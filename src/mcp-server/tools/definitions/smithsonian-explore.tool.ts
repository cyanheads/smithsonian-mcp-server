/**
 * @fileoverview smithsonian_explore tool — guided browse by category across Smithsonian collections.
 * @module mcp-server/tools/definitions/smithsonian-explore.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSmithsonianService } from '@/services/smithsonian/smithsonian-service.js';

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
  .describe('A representative sample object from the category.');

export const smithsonianExplore = tool('smithsonian_explore', {
  title: 'Explore Smithsonian by Category',
  description:
    'Browse Smithsonian collections by category to answer "what does the Smithsonian have about X?" questions. Constructs and executes a category-constrained search, then returns an overview: total count, a curated set of sample objects, and a breakdown of which museums hold matching objects. Four browse modes: museum (by unit code or name), culture (by culture term), period (by decade), medium (by object type). Use as the entry point for open-ended research.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    mode: z
      .enum(['museum', 'culture', 'period', 'medium'])
      .describe(
        'Browse dimension: "museum" (by unit code/name), "culture" (by culture term), "period" (by decade like "1940s"), "medium" (by object type like "Painting").',
      ),
    value: z
      .string()
      .describe(
        'Category value appropriate to the mode. museum: unit code ("NMNH") or full name ("National Museum of Natural History"). culture: term ("Aztec", "Sioux"). period: decade ("1940s", "1860s"). medium: object type ("Painting", "Aircraft", "Fossil").',
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
      .describe('Representative objects from the category.'),
    museum_breakdown: z
      .array(
        z
          .object({
            unit_code: z
              .string()
              .describe('Smithsonian unit code for this museum (e.g. "NMNH", "SAAM").'),
            museum_name: z.string().describe('Full name of the museum.'),
            count: z.number().describe('Estimated object count from sample (not exact).'),
          })
          .describe('A single museum contribution entry.'),
      )
      .describe(
        'When mode is not "museum": top contributing museums from the sample, helping plan museum-focused follow-up searches.',
      ),
  }),

  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'No objects match the category value.',
      recovery: 'Try a broader value, check spelling, or switch browse mode.',
    },
  ],

  async handler(input, ctx) {
    const svc = getSmithsonianService();

    // Build the constrained search based on mode
    const fq: string[] = [];
    let query = input.value;

    switch (input.mode) {
      case 'museum':
        // unit_code takes short codes; if it looks like a long name, use it as query
        if (input.value.length <= 8 && /^[A-Za-z]+$/.test(input.value)) {
          fq.push(`unit_code:${input.value.toUpperCase()}`);
          query = '*';
        } else {
          // Search by museum name as free text
          fq.push('type:edanmdm');
        }
        break;
      case 'culture':
        fq.push(`culture:${input.value}`);
        query = input.value;
        break;
      case 'period':
        fq.push(`date:${input.value}`);
        query = input.value;
        break;
      case 'medium':
        fq.push(`object_type:${input.value}`);
        query = input.value;
        break;
    }

    ctx.log.info('Exploring Smithsonian', { mode: input.mode, value: input.value, fq, query });

    const { rows: objects, rowCount } = await svc.search(
      { query, rows: input.rows, start: 0, fq },
      ctx,
    );

    if (objects.length === 0) {
      throw ctx.fail(
        'no_results',
        `No Smithsonian objects found for ${input.mode} "${input.value}".`,
        { mode: input.mode, value: input.value },
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
