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
    'Return all available CC0 images for a Smithsonian object at multiple resolutions. Only CC0 (open access) images are returned — throws Forbidden when an object has media but none of it is CC0. Each image entry includes thumbnail (~120px), screen-size (~800px), and high-resolution JPEG/TIFF URLs with pixel dimensions. Use smithsonian_search with filters.cc0_only to find CC0 objects before calling this tool.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    id: z
      .string()
      .describe(
        'record_id of the object (e.g. "nasm_A19670093000") from smithsonian_search or smithsonian_get_object.',
      ),
  }),

  output: z.object({
    record_id: z.string().describe('Smithsonian catalog record ID for the object.'),
    title: z.string().describe('Object title from the catalog record.'),
    is_cc0: z.boolean().describe('True when the object-level metadata is CC0.'),
    images: z
      .array(
        z
          .object({
            media_id: z.string().describe('IDS media identifier.'),
            is_cc0: z
              .boolean()
              .describe(
                'True when this specific image is CC0 (may differ from the object-level flag).',
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
      recovery: 'Verify the ID via smithsonian_search and use the record_id from search results.',
    },
    {
      reason: 'no_media',
      code: JsonRpcErrorCode.NotFound,
      when: 'The object exists but has no digitized online media.',
      recovery:
        'The physical object may not have been digitized. Use smithsonian_search to find similar objects with media.',
    },
    {
      reason: 'not_cc0',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The object has media but none of its images are CC0 open access.',
      recovery:
        'Use smithsonian_search with filters.cc0_only: true to find CC0 objects with downloadable images.',
    },
    {
      reason: 'invalid_id',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The ID is empty or contains only whitespace.',
      recovery:
        'Use record_id values directly from smithsonian_search results — do not construct IDs manually.',
    },
  ],

  async handler(input, ctx) {
    if (!input.id.trim()) {
      throw ctx.fail('invalid_id', 'Object ID must not be empty.', { id: input.id });
    }

    const svc = getSmithsonianService();
    ctx.log.info('Fetching media for Smithsonian object', { id: input.id });

    const raw = await svc.getContent(input.id, ctx);

    const isCC0 = svc.isCC0(raw);
    const title = raw.title ?? '';
    const recordId = raw.content?.descriptiveNonRepeating?.record_ID ?? input.id;
    const mediaCount =
      raw.content?.descriptiveNonRepeating?.online_media?.mediaCount ??
      raw.content?.descriptiveNonRepeating?.online_media?.media?.length ??
      0;

    if (mediaCount === 0) {
      throw ctx.fail('no_media', `Object "${input.id}" has no digitized online media.`, {
        record_id: recordId,
        title,
      });
    }

    const allImages = svc.toImageItems(raw);

    // Gate: only return CC0 images
    const cc0Images = allImages.filter((img) => img.is_cc0);

    if (allImages.length > 0 && cc0Images.length === 0) {
      throw ctx.fail(
        'not_cc0',
        `Object "${input.id}" has ${allImages.length} image(s) but none are CC0 open access.`,
        { record_id: recordId, title, image_count: allImages.length },
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
