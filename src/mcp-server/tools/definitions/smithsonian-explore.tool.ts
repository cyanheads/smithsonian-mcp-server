/**
 * @fileoverview smithsonian_explore tool — guided browse by category across Smithsonian collections.
 * @module mcp-server/tools/definitions/smithsonian-explore.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSmithsonianService, luceneField } from '@/services/smithsonian/smithsonian-service.js';

const SampleObjectSchema = z
  .object({
    record_id: z
      .string()
      .describe('Object identifier — pass to smithsonian_get_object or smithsonian_get_media.'),
    title: z.string().describe('Object title.'),
    unit_code: z.string().describe('Museum unit code.'),
    thumbnail_url: z.string().optional().describe('Thumbnail image URL if available.'),
    is_cc0: z.boolean().describe('True when the object is CC0 open access.'),
  })
  .describe('A sample object from the first page of category matches.');

export const smithsonianExplore = tool('smithsonian_explore', {
  title: 'Explore Smithsonian by Category',
  description:
    'Browse Smithsonian collections by category to answer "what does the Smithsonian have about X?" questions. Returns an overview: total count, the first page of matching objects, and a breakdown of which museums those page objects come from. Four browse modes — museum, culture, period, medium. Use as the entry point for open-ended research.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    mode: z
      .enum(['museum', 'culture', 'period', 'medium'])
      .describe(
        'Browse dimension: "museum" (by unit code), "culture" (by culture term), "period" (by decade like "1940s"), "medium" (by object type like "Paintings").',
      ),
    value: z
      .string()
      .describe(
        'Category value appropriate to the mode. museum: a short unit code like "NASM" or "SAAM". culture: term, often plural or qualified ("Aztecs", "Plains Indian"). period: decade ("1940s", "1860s"). medium: object type, usually plural ("Paintings", "Aircraft"). Smithsonian uses a controlled vocabulary — for culture, place, or unit_code, call smithsonian_list_terms to find exact terms.',
      ),
    rows: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Number of sample objects to return (default 10, max 50).'),
  }),

  output: z.object({
    mode: z
      .string()
      .describe(
        'Browse dimension used for this request (one of "museum", "culture", "period", "medium").',
      ),
    value: z.string().describe('Category value queried, as provided in the request.'),
    total_count: z.number().describe('Total number of Smithsonian objects matching this category.'),
    sample_objects: z
      .array(SampleObjectSchema)
      .describe('The first page of objects matching the category, in upstream order.'),
    museum_breakdown: z
      .array(
        z
          .object({
            unit_code: z
              .string()
              .describe('Smithsonian unit code for this museum (e.g. "NMNHPALEO", "SAAM").'),
            museum_name: z.string().describe('Full name of the museum.'),
            count: z.number().describe('Estimated object count from sample (not exact).'),
          })
          .describe('A single museum contribution entry.'),
      )
      .describe(
        'When mode is not "museum": top contributing museums from the sample, helping plan museum-focused follow-up searches.',
      ),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe('True when the sample was capped by the rows parameter.'),
    shown: z.number().optional().describe('Number of sample objects returned.'),
    cap: z.number().optional().describe('The rows cap that was applied.'),
    truncationCeiling: z
      .number()
      .optional()
      .describe('Total matching objects (upper bound for omitted items).'),
  },

  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'No objects match the category value.',
      recovery:
        'Values must match Smithsonian\'s controlled vocabulary (often plural, e.g. "Paintings" not "Painting"). For culture, place, or unit_code, call smithsonian_list_terms to find exact terms; otherwise broaden the value or switch mode.',
    },
  ],

  async handler(input, ctx) {
    const svc = getSmithsonianService();

    // Build the constrained search based on mode.
    // Field constraints are embedded in q as Lucene field:value terms (EDAN has no fq param).
    const filters: string[] = [];
    let query = '';

    switch (input.mode) {
      case 'museum':
        // Short alphanumeric codes are unit_code values (e.g. "NASM", "SAAM").
        // Long values are museum names — use as free-text query only.
        if (input.value.length <= 8 && /^[A-Za-z]+$/.test(input.value)) {
          filters.push(`unit_code:${input.value.toUpperCase()}`);
          query = '';
        } else {
          query = input.value;
        }
        break;
      case 'culture':
        filters.push(luceneField('culture', input.value));
        query = '';
        break;
      case 'period':
        filters.push(`date:${input.value}`);
        query = '';
        break;
      case 'medium':
        filters.push(luceneField('object_type', input.value));
        query = '';
        break;
    }

    ctx.log.info('Exploring Smithsonian', { mode: input.mode, value: input.value, filters, query });

    const { rows: objects, rowCount } = await svc.search(
      { query, rows: input.rows, start: 0, filters },
      ctx,
    );

    if (objects.length === 0) {
      throw ctx.fail(
        'no_results',
        `No Smithsonian objects found for ${input.mode} "${input.value}".`,
        {
          ...ctx.recoveryFor('no_results'),
          mode: input.mode,
          value: input.value,
        },
      );
    }

    // Build sample objects
    const sampleObjects = objects.map((o) => ({
      record_id: o.record_id,
      title: o.title,
      unit_code: o.unit_code,
      thumbnail_url: o.thumbnail_url,
      is_cc0: o.is_cc0,
    }));

    // Museum breakdown from sample (only when mode !== museum)
    const museumBreakdown: Array<{ unit_code: string; museum_name: string; count: number }> = [];
    if (input.mode !== 'museum') {
      const counts = new Map<string, { museum_name: string; count: number }>();
      for (const obj of objects) {
        const existing = counts.get(obj.unit_code);
        if (existing) {
          existing.count += 1;
        } else {
          counts.set(obj.unit_code, { museum_name: obj.museum_name, count: 1 });
        }
      }
      // Sort by count descending, take top 5
      for (const [unit_code, { museum_name, count }] of [...counts.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 5)) {
        museumBreakdown.push({ unit_code, museum_name, count });
      }
    }

    ctx.log.info('Explore complete', {
      mode: input.mode,
      total: rowCount,
      samples: sampleObjects.length,
    });

    if (sampleObjects.length < rowCount) {
      ctx.enrich.truncated({ shown: sampleObjects.length, cap: input.rows, ceiling: rowCount });
    }

    return {
      mode: input.mode,
      value: input.value,
      total_count: rowCount,
      sample_objects: sampleObjects,
      museum_breakdown: museumBreakdown,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# Smithsonian — ${result.mode}: ${result.value}`);
    lines.push(`**Total objects:** ${result.total_count.toLocaleString()}`);
    lines.push(`**Sample:** ${result.sample_objects.length} objects\n`);
    for (const obj of result.sample_objects) {
      lines.push(
        `- **${obj.title}** (${obj.unit_code}) — ID: \`${obj.record_id}\`${obj.is_cc0 ? ' · CC0' : ''}`,
      );
      if (obj.thumbnail_url) lines.push(`  Thumbnail: ${obj.thumbnail_url}`);
    }
    if (result.museum_breakdown.length > 0) {
      lines.push('\n**Museum breakdown (from sample):**');
      for (const m of result.museum_breakdown) {
        lines.push(`- ${m.museum_name} (${m.unit_code}): ${m.count} in sample`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
