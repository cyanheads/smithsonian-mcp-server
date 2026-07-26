/**
 * @fileoverview smithsonian_get_media tool — image URLs at multiple resolutions for a Smithsonian object.
 * @module mcp-server/tools/definitions/smithsonian-get-media.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSmithsonianService } from '@/services/smithsonian/smithsonian-service.js';

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
    'Return every CC0 (open-access) image for a Smithsonian object at multiple resolutions. The tool never returns an empty list — it names the reason instead: an object with nothing digitized, an object whose media is entirely non-image (scanned books, 3D models, sound recordings), and an object whose images are entirely non-CC0 each fail with their own reason. Each image entry includes thumbnail (~120px), screen-size (~800px), and high-resolution JPEG/TIFF URLs with pixel dimensions. The cc0_only filter on smithsonian_search_objects surfaces objects that have downloadable CC0 images.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    id: z
      .string()
      .describe(
        'record_id of the object (e.g. "nasm_A19670093000") from smithsonian_search_objects or smithsonian_get_object.',
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
            thumbnail_url: z.string().optional().describe('Thumbnail URL (~120px).'),
            screen_url: z.string().optional().describe('Screen-size URL (~800px).'),
            high_res_jpeg: ImageResolutionSchema.optional().describe(
              'Full-resolution JPEG download when available.',
            ),
            high_res_tiff: ImageResolutionSchema.optional().describe(
              'Archival TIFF download when available.',
            ),
          })
          .describe('A single CC0 image item with resolution variants.'),
      )
      .describe('CC0-licensed images for this object.'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No object with the given ID exists in the Smithsonian catalog.',
      recovery:
        'Verify the ID via smithsonian_search_objects and use the record_id from search results.',
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
      when: 'The object has digitized media, but none of it is an image — the media is entirely non-image types such as scanned books, 3D models, or sound recordings.',
      recovery:
        'Call smithsonian_get_object for this record and read media_summary and record_link — non-image media is reachable from the Smithsonian record page, not from this tool.',
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
  ],

  async handler(input, ctx) {
    if (!input.id.trim()) {
      throw ctx.fail('invalid_id', 'Object ID must not be empty.', {
        ...ctx.recoveryFor('invalid_id'),
        id: input.id,
      });
    }

    const svc = getSmithsonianService();
    ctx.log.info('Fetching media for Smithsonian object', { id: input.id });

    const raw = await svc.getContent(input.id, ctx);

    const isCC0 = svc.isCC0(raw);
    const title = raw.title ?? '';
    const recordId = raw.content?.descriptiveNonRepeating?.record_ID ?? input.id;
    const media = raw.content?.descriptiveNonRepeating?.online_media?.media ?? [];
    const mediaCount =
      raw.content?.descriptiveNonRepeating?.online_media?.mediaCount ?? media.length;

    if (mediaCount === 0) {
      throw ctx.fail('no_media', `Object "${input.id}" has no digitized online media.`, {
        ...ctx.recoveryFor('no_media'),
        record_id: recordId,
        title,
      });
    }

    const allImages = svc.toImageItems(raw);

    // The object has media, but none of it survived the image filter — scanned
    // books, 3D models, video. Distinct from both neighbours: no_media means
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
          ...(typeList
            ? {
                recovery: {
                  hint: `This object's online media is ${typeList}, which smithsonian_get_media does not deliver. Call smithsonian_get_object { id: "${input.id}" } and read media_summary and record_link to reach it.`,
                },
              }
            : ctx.recoveryFor('no_images')),
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
        {
          ...ctx.recoveryFor('not_cc0'),
          record_id: recordId,
          title,
          image_count: allImages.length,
        },
      );
    }

    ctx.log.info('Media fetched', {
      record_id: recordId,
      total_images: allImages.length,
      cc0_images: cc0Images.length,
      is_cc0: isCC0,
    });

    return {
      record_id: recordId,
      title,
      is_cc0: isCC0,
      images: cc0Images,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# Media: ${result.title}`);
    lines.push(`**ID:** ${result.record_id} | **Object CC0:** ${result.is_cc0 ? 'Yes' : 'No'}`);
    lines.push(`**Images:** ${result.images.length} CC0 image(s)\n`);
    for (const img of result.images) {
      lines.push(`### Image: ${img.media_id}`);
      lines.push(`**CC0:** ${img.is_cc0 ? 'Yes' : 'No'}`);
      if (img.alt_text) lines.push(`**Alt:** ${img.alt_text}`);
      if (img.description) lines.push(`**Description:** ${img.description}`);
      if (img.thumbnail_url) lines.push(`**Thumbnail:** ${img.thumbnail_url}`);
      if (img.screen_url) lines.push(`**Screen:** ${img.screen_url}`);
      if (img.high_res_jpeg) {
        const dims = img.high_res_jpeg.width
          ? ` (${img.high_res_jpeg.width}×${img.high_res_jpeg.height}px)`
          : '';
        lines.push(`**JPEG:** ${img.high_res_jpeg.url}${dims}`);
      }
      if (img.high_res_tiff) {
        const dims = img.high_res_tiff.width
          ? ` (${img.high_res_tiff.width}×${img.high_res_tiff.height}px)`
          : '';
        lines.push(`**TIFF:** ${img.high_res_tiff.url}${dims}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
