/**
 * @fileoverview smithsonian_get_media tool — a Smithsonian object's CC0 image URLs at multiple
 * resolutions, or with `media: "3d"` its CC0 3D model packages and their files.
 * @module mcp-server/tools/definitions/smithsonian-get-media.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  escapeMarkdownInline,
  markdown,
  markdownImage,
  markdownLink,
} from '@cyanheads/mcp-ts-core/utils';
import { headingText, noticeTrailer } from '@/mcp-server/tools/markdown-encoders.js';
import {
  enrichPageNotice,
  pageSizeInput,
  pageSizeMeta,
  servePageSize,
} from '@/mcp-server/tools/page-size.js';
import {
  enrichProvenance,
  provenanceEnrichment,
  provenanceTrailer,
} from '@/mcp-server/tools/provenance.js';
import {
  API_KEY_REJECTED_ERROR,
  getSmithsonianService,
  startCallDeadline,
  toPlainText,
} from '@/services/smithsonian/smithsonian-service.js';

const ImageResolutionSchema = z
  .object({
    url: z.string().describe('Direct download URL for the image.'),
    width: z.number().optional().describe('Image width in pixels.'),
    height: z.number().optional().describe('Image height in pixels.'),
  })
  .describe('Image URL with optional pixel dimensions.');

const ModelFileSchema = z
  .object({
    url: z.string().describe('Direct download URL for the file.'),
    filename: z.string().optional().describe('Download file name.'),
    category: z
      .string()
      .optional()
      .describe(
        'Resolution tier as the catalog spells it, e.g. "Low resolution", "Full resolution", "iOS AR model", or "Watertight" (a closed mesh ready for 3D printing). Spellings vary ("Full_resolution", "Low Resolution").',
      ),
    file_type: z
      .string()
      .optional()
      .describe(
        'Format of the downloaded file as the catalog spells it, e.g. "glb", "usdz", "ply", or "zip"; a zip holds the mesh model_file_type names.',
      ),
    model_file_type: z
      .string()
      .optional()
      .describe(
        'Mesh format as the catalog spells it, e.g. "obj", "glb", "gltf", "ply", "usdz", "stl".',
      ),
    units: z
      .string()
      .optional()
      .describe('Units of the model coordinates as the catalog gives them, e.g. "m", "mm", "in".'),
    draco_compressed: z
      .boolean()
      .optional()
      .describe(
        'The catalog\'s Draco-compression flag for the mesh, which can disagree with a format it names "draco compressed glb".',
      ),
    size_bytes: z.number().optional().describe('File size in bytes.'),
  })
  .describe(
    "One downloadable model file. Every field but url is the catalog's value as written, absent when the catalog gives none.",
  );

const ModelPackageSchema = z
  .object({
    media_id: z.string().describe('3D package identifier (3d_package:<uuid>).'),
    is_cc0: z
      .boolean()
      .describe(
        'True when this package is CC0. Always true on returned packages — non-CC0 packages are filtered out before the response.',
      ),
    viewer_url: z
      .string()
      .optional()
      .describe('Voyager 3D viewer page for the package — a web page, not a file.'),
    thumbnail_url: z.string().optional().describe('Thumbnail image of the 3D scene.'),
    files: z
      .array(ModelFileSchema)
      .describe(
        'The downloadable files the package lists, in catalog order. Empty when the catalog lists none.',
      ),
  })
  .describe('A CC0 3D model package (a Voyager scene) and its downloadable model files.');

export const smithsonianGetMedia = tool('smithsonian_get_media', {
  title: 'Get Smithsonian Object Media',
  description:
    'Return a Smithsonian object\'s CC0 (open-access) images at multiple resolutions, in catalog order, with cc0_image_count — or, with media: "3d", its CC0 3D model packages with cc0_model_count. In the default images mode, an object with no CC0 image fails with its own reason: nothing digitized, media that is entirely non-image (3D models, scanned books, documents; a 3D object\'s failure names the media: "3d" call), or images that are all non-CC0. Page a long list with start and limit: omit limit to get everything from start, and a start at or past the count returns an empty list. Each image includes a thumbnail (~150px), a screen-size image (~1,200px on the long edge), and a full-size JPEG — with pixel dimensions when the catalog lists a high-resolution JPEG — plus an archival TIFF when one exists. Each 3D package carries its Voyager viewer URL, a thumbnail, and its downloadable files: URL, filename, resolution tier (low, full, iOS AR, or watertight for 3D printing), file and mesh format, units, Draco compression, and size in bytes, spelled as the catalog lists them. A record with no 3D package fails no_models in 3D mode. On smithsonian_search_objects, the cc0_only filter surfaces objects with downloadable CC0 images, and filters.online_media_type "3D Models" surfaces objects with 3D packages.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    id: z
      .string()
      .describe(
        'record_id of the object (e.g. "nasm_A19670093000") from smithsonian_search_objects or smithsonian_get_object.',
      ),
    media: z
      .enum(['images', '3d'])
      .default('images')
      .describe(
        'Which media to return: "images" for CC0 images, or "3d" for CC0 3D model packages and their downloadable model files.',
      ),
    start: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Offset into the CC0 images, or with media "3d" the CC0 model packages, 0-indexed in catalog order. A truncated page names the next start in its notice.',
      ),
    limit: pageSizeInput('smithsonian_get_media', 'limit')
      .optional()
      .meta(
        pageSizeMeta('smithsonian_get_media', (clamped, cap) =>
          clamped
            ? `Images, or with media "3d" model packages, to return from start. Omit to return every one from start. A value above ${cap} is served at ${cap} with a notice.`
            : `Images, or with media "3d" model packages, to return from start (max ${cap}). Omit to return every one from start.`,
        ),
      ),
  }),
  // Results name the object `record_id`; a call passing that key reaches `id`.
  inputAliases: { record_id: 'id' },

  output: z.object({
    record_id: z.string().describe('Smithsonian catalog record ID for the object.'),
    title: z.string().describe('Object title from the catalog record.'),
    is_cc0: z
      .boolean()
      .describe(
        'True when the object-level metadata is CC0. The Open Access corpus is CC0 throughout, so this rarely varies; the per-image is_cc0 flag is what gates delivery.',
      ),
    cc0_image_count: z
      .number()
      .describe(
        'CC0 images on the record before paging — the same count as smithsonian_get_object\'s media_summary.cc0_image_count. Reported with media "3d" too, where images is empty.',
      ),
    images: z
      .array(
        z
          .object({
            media_id: z.string().describe('IDS media identifier.'),
            is_cc0: z
              .boolean()
              .describe(
                'True when this specific image is CC0 (may differ from the object-level flag). Always true on returned images — non-CC0 images are filtered out before the response.',
              ),
            alt_text: z.string().optional().describe('Accessibility alt text for the image.'),
            description: z.string().optional().describe('Extended accessibility description.'),
            thumbnail_url: z.string().optional().describe('Thumbnail URL (~150px).'),
            screen_url: z
              .string()
              .optional()
              .describe(
                'Screen-size URL (~1,200px on the long edge), or the full-size delivery URL when the catalog lists no screen image.',
              ),
            high_res_jpeg: ImageResolutionSchema.optional().describe(
              "Full-size JPEG: the catalog's high-resolution JPEG with its pixel dimensions, or, when it lists none, the image's full-size delivery URL with no dimensions. Absent only when the image has neither.",
            ),
            high_res_tiff: ImageResolutionSchema.optional().describe(
              'Archival TIFF download when available.',
            ),
          })
          .describe('A single CC0 image item with resolution variants.'),
      )
      .describe(
        'The CC0 images from start in catalog order: limit of them, or every remaining one when limit is omitted. Empty when start is at or past cc0_image_count, and always empty with media "3d".',
      ),
    cc0_model_count: z
      .number()
      .optional()
      .describe('CC0 3D model packages on the record before paging. Present only with media "3d".'),
    models: z
      .array(ModelPackageSchema)
      .optional()
      .describe(
        'The CC0 3D model packages from start in catalog order: limit of them, or every remaining one when limit is omitted. Empty when start is at or past cc0_model_count. Present only with media "3d".',
      ),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when CC0 images, or with media "3d" CC0 model packages, remain past this page. Absent on a page that reaches the last one, and on a start past it.',
      ),
    shown: z
      .number()
      .optional()
      .describe('Number of images, or with media "3d" model packages, returned in this page.'),
    cap: z
      .number()
      .optional()
      .describe('The page size served: limit as requested, or its cap when limit exceeded it.'),
    truncationCeiling: z
      .number()
      .optional()
      .describe(
        'CC0 images on the record (cc0_image_count), or with media "3d" CC0 model packages (cc0_model_count) — upper bound for omitted items.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance naming the start that retrieves the images or model packages this page omitted. Opens with the page size served when limit exceeded its cap.',
      ),
    ...provenanceEnrichment,
  },
  enrichmentTrailer: { ...provenanceTrailer, notice: noticeTrailer },

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No object with the given ID exists in the Smithsonian catalog.',
      recovery:
        'Verify the ID via smithsonian_search_objects and use the record_id from search results.',
      // Raised by SmithsonianService.getContent, which resolves this hint itself.
      thrownBy: 'service',
    },
    {
      reason: 'no_media',
      code: JsonRpcErrorCode.NotFound,
      when: 'The object exists but has no digitized online media.',
      recovery:
        'The physical object may not have been digitized. Use smithsonian_search_objects to find similar objects with media.',
    },
    {
      reason: 'no_images',
      code: JsonRpcErrorCode.NotFound,
      when: 'In images mode, the object has digitized media but none of it is an image — the media is entirely non-image types such as 3D models, scanned books, or documents.',
      recovery:
        'For 3D models (3d_voyager items), call smithsonian_get_media again with media: "3d" for their model files. For other non-image media, call smithsonian_get_object for this record and read media_summary.non_image_media, which links each item.',
    },
    {
      reason: 'no_models',
      code: JsonRpcErrorCode.NotFound,
      when: 'With media "3d", the object has digitized media but no 3D model package (3d_voyager item).',
      recovery:
        'Call smithsonian_get_media without media for the object\'s images, or smithsonian_get_object for media_summary.non_image_media, which links its other media. smithsonian_search_objects { query: "", filters: { online_media_type: "3D Models" } } finds objects that carry 3D models.',
    },
    {
      reason: 'not_cc0',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The object has media but none of its images — or, with media "3d", none of its 3D model packages — are CC0 open access.',
      recovery:
        'Use smithsonian_search_objects { query: "", filters: { cc0_only: true } } to find CC0 objects with downloadable images.',
    },
    {
      reason: 'invalid_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The ID is empty or contains only whitespace.',
      recovery:
        'Use record_id values directly from smithsonian_search_objects results — do not construct IDs manually.',
    },
    API_KEY_REJECTED_ERROR,
  ],

  async handler(input, ctx) {
    const deadline = startCallDeadline();
    if (!input.id.trim()) {
      throw ctx.fail('invalid_id', 'Object ID must not be empty.', { id: input.id });
    }

    const pageSize =
      input.limit === undefined
        ? undefined
        : servePageSize('smithsonian_get_media', 'limit', input.limit, ctx);
    const svc = getSmithsonianService();
    ctx.log.info('Fetching media for Smithsonian object', { id: input.id, media: input.media });

    const { record: raw, provenance } = await svc.getContent(input.id, ctx, deadline);

    const isCC0 = svc.isCC0(raw);
    const title = toPlainText(raw.title ?? '');
    const recordId = raw.content?.descriptiveNonRepeating?.record_ID ?? input.id;
    const media = raw.content?.descriptiveNonRepeating?.online_media?.media ?? [];
    const mediaCount =
      raw.content?.descriptiveNonRepeating?.online_media?.mediaCount ?? media.length;

    if (mediaCount === 0) {
      throw ctx.fail('no_media', `Object "${input.id}" has no digitized online media.`, {
        record_id: recordId,
        title,
      });
    }

    const allImages = svc.toImageItems(raw);
    const cc0Images = allImages.filter((img) => img.is_cc0);
    const mediaTypes = [
      ...new Set(media.map((m) => m.type).filter((t): t is string => Boolean(t))),
    ];
    const typeList = mediaTypes.join(', ');

    /**
     * One page of `items` from start — limit of them, or every remaining one when limit is
     * omitted — with the read's provenance and the page's notice enriched. Pages are sliced
     * after the whole-record gates, so a record with nothing CC0 to deliver fails with its own
     * reason at any start. The next start is named outright: after a clamp, advancing by the
     * requested limit would skip items.
     */
    const servePage = <T>(items: T[], counted: string, each: string): T[] => {
      const limit = pageSize?.value ?? items.length;
      const page = items.slice(input.start, input.start + limit);
      enrichProvenance(ctx, [provenance]);
      const next = input.start + page.length;
      enrichPageNotice(ctx, {
        leading: [pageSize?.notice],
        truncation:
          next < items.length
            ? {
                shown: page.length,
                cap: limit,
                ceiling: items.length,
                guidance: `${items.length} ${counted}; this page shows ${page.length} from start ${input.start}. Retrieve the next page with start: ${next}, or omit limit to return every remaining ${each}.`,
              }
            : undefined,
      });
      return page;
    };

    if (input.media === '3d') {
      const packages = svc.toModelPackages(raw);
      if (packages.length === 0) {
        // Route to images mode only when it would deliver an image, and to get_object only when
        // it would link a non-image item ("type set and not Images", as get_object selects them).
        const route =
          cc0Images.length > 0
            ? `Call smithsonian_get_media { id: "${input.id}" } for its images.`
            : mediaTypes.some((type) => type !== 'Images')
              ? `Call smithsonian_get_object { id: "${input.id}" } and read media_summary.non_image_media for each item's link.`
              : 'None of its images are CC0, and this tool returns CC0 media only. Use smithsonian_search_objects { query: "", filters: { online_media_type: "3D Models" } } to find objects with 3D models.';
        throw ctx.fail(
          'no_models',
          `Object "${input.id}" has ${mediaCount} media item(s), but no 3D model package${typeList ? ` (media types: ${typeList})` : ''}.`,
          {
            ...(typeList && {
              recovery: {
                hint: `This object has no 3D model package; its online media is ${typeList}. ${route}`,
              },
            }),
            record_id: recordId,
            title,
            media_count: mediaCount,
            media_types: mediaTypes,
          },
        );
      }

      // Each package carries its own usage.access, as each image does.
      const cc0Models = packages.filter((pkg) => pkg.is_cc0);
      if (cc0Models.length === 0) {
        throw ctx.fail(
          'not_cc0',
          `Object "${input.id}" has ${packages.length} 3D model package(s) but none are CC0 open access.`,
          {
            recovery: {
              hint: 'None of this object\'s 3D model packages are CC0, and this tool returns CC0 media only. Use smithsonian_search_objects { query: "", filters: { online_media_type: "3D Models" } } to find objects with 3D models.',
            },
            record_id: recordId,
            title,
            model_count: packages.length,
          },
        );
      }

      const models = servePage(cc0Models, 'CC0 model packages', 'package');
      ctx.log.info('Models fetched', {
        record_id: recordId,
        total_packages: packages.length,
        cc0_packages: cc0Models.length,
        start: input.start,
        returned: models.length,
        is_cc0: isCC0,
      });
      return {
        record_id: recordId,
        title,
        is_cc0: isCC0,
        cc0_image_count: cc0Images.length,
        images: [],
        cc0_model_count: cc0Models.length,
        models,
      };
    }

    // The object has media, but none of it survived the image filter — 3D
    // models, scanned books, documents. Distinct from both neighbours: no_media means
    // nothing was digitized, not_cc0 means images exist but are restricted.
    // Returning images: [] here would be indistinguishable from either.
    if (allImages.length === 0) {
      const has3d = svc.toModelPackages(raw).length > 0;
      // With a package present, a second type is media the 3D call leaves out.
      const others = has3d && mediaTypes.length > 1;
      const hint = has3d
        ? `This object's online media is ${typeList}, none of it images. Call smithsonian_get_media { id: "${input.id}", media: "3d" } for its 3D model files${others ? `, and smithsonian_get_object { id: "${input.id}" } and read media_summary.non_image_media for each other item's link` : ''}.`
        : `This object's online media is ${typeList}, which smithsonian_get_media does not deliver. Call smithsonian_get_object { id: "${input.id}" } and read media_summary.non_image_media for each item's link.`;
      throw ctx.fail(
        'no_images',
        `Object "${input.id}" has ${mediaCount} media item(s), but none of them are images${typeList ? ` (media types: ${typeList})` : ''}.`,
        {
          ...(typeList && { recovery: { hint } }),
          record_id: recordId,
          title,
          media_count: mediaCount,
          media_types: mediaTypes,
        },
      );
    }

    if (cc0Images.length === 0) {
      throw ctx.fail(
        'not_cc0',
        `Object "${input.id}" has ${allImages.length} image(s) but none are CC0 open access.`,
        { record_id: recordId, title, image_count: allImages.length },
      );
    }

    const images = servePage(cc0Images, 'CC0 images', 'image');
    ctx.log.info('Media fetched', {
      record_id: recordId,
      total_images: allImages.length,
      cc0_images: cc0Images.length,
      start: input.start,
      returned: images.length,
      is_cc0: isCC0,
    });
    return {
      record_id: recordId,
      title,
      is_cc0: isCC0,
      cc0_image_count: cc0Images.length,
      images,
    };
  },

  format: (result) => {
    /** A download link, with its pixel size when the catalog lists one. */
    const download = (label: string, file: z.infer<typeof ImageResolutionSchema>) =>
      `${markdownLink(label, file.url)}${file.width ? ` (${file.width}×${file.height}px)` : ''}`;
    /** One model file as a list item: its download link, then each field the catalog gives. */
    const modelFile = (file: z.infer<typeof ModelFileSchema>) => {
      const fields = [markdownLink(file.filename ?? 'Download', file.url)];
      if (file.category) fields.push(`Category: ${escapeMarkdownInline(file.category)}`);
      if (file.file_type) fields.push(`File type: ${escapeMarkdownInline(file.file_type)}`);
      if (file.model_file_type) {
        fields.push(`Model file type: ${escapeMarkdownInline(file.model_file_type)}`);
      }
      if (file.units) fields.push(`Units: ${escapeMarkdownInline(file.units)}`);
      if (file.draco_compressed !== undefined) {
        fields.push(`Draco compressed: ${file.draco_compressed ? 'Yes' : 'No'}`);
      }
      if (file.size_bytes !== undefined) fields.push(`Size: ${file.size_bytes} bytes`);
      return `- ${fields.join(' · ')}`;
    };
    const lines: string[] = [
      `# Media: ${headingText(result.title)}`,
      `**ID:** ${markdown().inlineCode(result.record_id).build()} | **Object CC0:** ${result.is_cc0 ? 'Yes' : 'No'}`,
    ];
    if (result.models) {
      const imageCount = result.cc0_image_count;
      lines.push(
        `**Models:** ${result.models.length} of ${result.cc0_model_count} CC0 3D model package(s)`,
        `**CC0 images:** ${imageCount}${imageCount ? ' — call with media "images" to list them' : ''}\n`,
      );
    } else {
      lines.push(`**Images:** ${result.images.length} of ${result.cc0_image_count} CC0 image(s)\n`);
    }
    for (const img of result.images) {
      lines.push(`### Image: ${headingText(img.media_id)}`);
      lines.push(`**CC0:** ${img.is_cc0 ? 'Yes' : 'No'}`);
      if (img.alt_text) lines.push(`**Alt:** ${escapeMarkdownInline(img.alt_text)}`);
      if (img.description) lines.push(`**Description:** ${escapeMarkdownInline(img.description)}`);
      if (img.thumbnail_url) {
        lines.push(`**Thumbnail:** ${markdownImage('Thumbnail', img.thumbnail_url)}`);
      }
      if (img.screen_url) lines.push(`**Screen:** ${markdownLink('Screen size', img.screen_url)}`);
      if (img.high_res_jpeg)
        lines.push(`**JPEG:** ${download('Full-size JPEG', img.high_res_jpeg)}`);
      if (img.high_res_tiff)
        lines.push(`**TIFF:** ${download('Archival TIFF', img.high_res_tiff)}`);
    }
    for (const model of result.models ?? []) {
      lines.push(`### Model: ${headingText(model.media_id)}`);
      lines.push(`**CC0:** ${model.is_cc0 ? 'Yes' : 'No'}`);
      if (model.viewer_url) {
        lines.push(`**Viewer:** ${markdownLink('Voyager 3D viewer', model.viewer_url)}`);
      }
      if (model.thumbnail_url) {
        lines.push(`**Thumbnail:** ${markdownImage('Thumbnail', model.thumbnail_url)}`);
      }
      lines.push(`**Files:** ${model.files.length}`, ...model.files.map(modelFile));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
