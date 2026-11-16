/**
 * @fileoverview smithsonian_get_media tool — image URLs at multiple resolutions for a Smithsonian object.
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

export const smithsonianGetMedia = tool('smithsonian_get_media', {
  title: 'Get Smithsonian Object Media',
  description:
    "Return a Smithsonian object's CC0 (open-access) images at multiple resolutions, in catalog order, with cc0_image_count. An object with no CC0 image fails with its own reason: nothing digitized, media that is entirely non-image (3D models, scanned books, documents), or images that are all non-CC0. Page a long image list with start and limit: omit limit to get every image from start, and a start at or past cc0_image_count returns an empty images list. Each image includes a thumbnail (~150px), a screen-size image (~1,200px on the long edge), and a full-size JPEG — with pixel dimensions when the catalog lists a high-resolution JPEG — plus an archival TIFF when one exists. The cc0_only filter on smithsonian_search_objects surfaces objects that have downloadable CC0 images.",
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    id: z
      .string()
      .describe(
        'record_id of the object (e.g. "nasm_A19670093000") from smithsonian_search_objects or smithsonian_get_object.',
      ),
    start: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Offset into the CC0 images, 0-indexed in catalog order. A truncated page names the next start in its notice.',
      ),
    limit: pageSizeInput('smithsonian_get_media', 'limit')
      .optional()
      .meta(
        pageSizeMeta('smithsonian_get_media', (clamped, cap) =>
          clamped
            ? `Images to return from start. Omit to return every image from start. A value above ${cap} is served at ${cap} with a notice.`
            : `Images to return from start (max ${cap}). Omit to return every image from start.`,
        ),
      ),
  }),

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
        "CC0 images on the record before paging — the same count as smithsonian_get_object's media_summary.cc0_image_count.",
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
        'The CC0 images from start in catalog order: limit of them, or every remaining one when limit is omitted. Empty when start is at or past cc0_image_count.',
      ),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when CC0 images remain past this page. Absent on a page that reaches the last image, and on a start past it.',
      ),
    shown: z.number().optional().describe('Number of images returned in this page.'),
    cap: z
      .number()
      .optional()
      .describe('The page size served: limit as requested, or its cap when limit exceeded it.'),
    truncationCeiling: z
      .number()
      .optional()
      .describe('CC0 images on the record (cc0_image_count) — upper bound for omitted images.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance naming the start that retrieves the images this page omitted. Opens with the page size served when limit exceeded its cap.',
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
      when: 'The object has digitized media, but none of it is an image — the media is entirely non-image types such as 3D models, scanned books, or documents.',
      recovery:
        'Call smithsonian_get_object for this record and read media_summary.non_image_media, which links each non-image item; this tool delivers images only.',
    },
    {
      reason: 'not_cc0',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The object has media but none of its images are CC0 open access.',
      recovery:
        'Use smithsonian_search_objects with filters.cc0_only: true to find CC0 objects with downloadable images.',
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
    ctx.log.info('Fetching media for Smithsonian object', { id: input.id });

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

    // The object has media, but none of it survived the image filter — 3D
    // models, scanned books, documents. Distinct from both neighbours: no_media means
    // nothing was digitized, not_cc0 means images exist but are restricted.
    // Returning images: [] here would be indistinguishable from either.
    if (allImages.length === 0) {
      const mediaTypes = [
        ...new Set(media.map((m) => m.type).filter((t): t is string => Boolean(t))),
      ];
      const typeList = mediaTypes.join(', ');
      throw ctx.fail(
        'no_images',
        `Object "${input.id}" has ${mediaCount} media item(s), but none of them are images${typeList ? ` (media types: ${typeList})` : ''}.`,
        {
          ...(typeList && {
            recovery: {
              hint: `This object's online media is ${typeList}, which smithsonian_get_media does not deliver. Call smithsonian_get_object { id: "${input.id}" } and read media_summary.non_image_media for each item's link.`,
            },
          }),
          record_id: recordId,
          title,
          media_count: mediaCount,
          media_types: mediaTypes,
        },
      );
    }

    // Gate: only return CC0 images
    const cc0Images = allImages.filter((img) => img.is_cc0);

    if (cc0Images.length === 0) {
      throw ctx.fail(
        'not_cc0',
        `Object "${input.id}" has ${allImages.length} image(s) but none are CC0 open access.`,
        { record_id: recordId, title, image_count: allImages.length },
      );
    }

    // The page is sliced after the whole-record gates above, so a record with no CC0
    // image fails with its own reason at any start. An omitted limit runs to the end.
    const limit = pageSize?.value ?? cc0Images.length;
    const images = cc0Images.slice(input.start, input.start + limit);

    ctx.log.info('Media fetched', {
      record_id: recordId,
      total_images: allImages.length,
      cc0_images: cc0Images.length,
      start: input.start,
      returned: images.length,
      is_cc0: isCC0,
    });

    enrichProvenance(ctx, [provenance]);
    // The next start is named outright: after a clamp, advancing by the requested limit
    // would skip images.
    const next = input.start + images.length;
    enrichPageNotice(ctx, {
      leading: [pageSize?.notice],
      truncation:
        next < cc0Images.length
          ? {
              shown: images.length,
              cap: limit,
              ceiling: cc0Images.length,
              guidance: `${cc0Images.length} CC0 images; this page shows ${images.length} from start ${input.start}. Retrieve the next page with start: ${next}, or omit limit to return every remaining image.`,
            }
          : undefined,
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
    const lines: string[] = [
      `# Media: ${headingText(result.title)}`,
      `**ID:** ${markdown().inlineCode(result.record_id).build()} | **Object CC0:** ${result.is_cc0 ? 'Yes' : 'No'}`,
      `**Images:** ${result.images.length} of ${result.cc0_image_count} CC0 image(s)\n`,
    ];
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
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
