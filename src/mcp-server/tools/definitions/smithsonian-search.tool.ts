/**
 * @fileoverview smithsonian_search tool — full-text search across 19.4M Smithsonian objects.
 * @module mcp-server/tools/definitions/smithsonian-search.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSmithsonianService, luceneField } from '@/services/smithsonian/smithsonian-service.js';

const ObjectSummarySchema = z
  .object({
    record_id: z
      .string()
      .describe(
        'Unique object identifier — pass to smithsonian_get_object, smithsonian_get_media, or smithsonian_find_related.',
      ),
    title: z.string().describe('Object title from the catalog.'),
    unit_code: z
      .string()
      .describe(
        'Museum unit code (e.g. "NASM", "NMNH", "SAAM"). Use as a filter in future searches.',
      ),
    museum_name: z.string().describe('Full museum name for the unit code.'),
    object_type: z
      .string()
      .optional()
      .describe('Object type term (e.g. "Aircraft", "Painting", "Fossil").'),
    thumbnail_url: z
      .string()
      .optional()
      .describe('Thumbnail image URL (~120px) if the object has online media.'),
    is_cc0: z
      .boolean()
      .describe(
        'True when the object metadata is CC0 (open access). Use smithsonian_get_media for CC0 image downloads.',
      ),
    has_media: z.boolean().describe('True when the object has any digitized online media.'),
  })
  .describe('Curated summary of a single Smithsonian catalog object.');

export const smithsonianSearch = tool('smithsonian_search', {
  title: 'Search Smithsonian Collections',
  description:
    'Search across 19.4 million Smithsonian objects by text query and optional filters. Filters narrow by museum unit, object type, decade, culture, geographic place, and online/CC0 availability. Returns curated summaries (title, date, museum, thumbnail URL, CC0 flag) with the total match count. The record_id in each result is the identifier for smithsonian_get_object, smithsonian_find_related, and smithsonian_get_media.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    query: z
      .string()
      .describe(
        'Free-text search. Use specific terms for precision ("Tlingit totem pole") or broad terms for browsing ("quilt").',
      ),
    filters: z
      .object({
        unit_code: z
          .string()
          .optional()
          .describe(
            'Museum unit code (e.g. "NASM", "NMNH", "SAAM", "NMAH", "NMAAHC", "NMAI", "NPG", "CHNDM", "SIL"). Use smithsonian_list_terms with field "unit_code" to enumerate valid values.',
          ),
        object_type: z
          .string()
          .optional()
          .describe(
            'Object type term (e.g. "Aircraft", "Painting", "Fossil"). Use smithsonian_list_terms with field "object_type" to enumerate valid values.',
          ),
        date_decade: z
          .string()
          .optional()
          .describe(
            'Decade filter (e.g. "1920s", "1960s"). Must match the "NNNNs" format exactly. Use smithsonian_list_terms with field "date" to see indexed decades.',
          ),
        culture: z
          .string()
          .optional()
          .describe(
            'Culture term (e.g. "Plains Indian", "Aztec"). Use smithsonian_list_terms with field "culture" to enumerate valid values.',
          ),
        place: z
          .string()
          .optional()
          .describe(
            'Geographic place (e.g. "United States of America"). Use smithsonian_list_terms with field "place" to enumerate valid values.',
          ),
        online_only: z
          .boolean()
          .optional()
          .describe('When true, restrict to objects that have any online media.'),
        cc0_only: z
          .boolean()
          .optional()
          .describe(
            'When true, restrict to CC0 open-access objects. Useful before calling smithsonian_get_media.',
          ),
      })
      .optional()
      .describe('Optional structured filters to narrow the search.'),
    rows: z.number().int().min(1).max(100).default(20).describe('Page size (default 20, max 100).'),
    start: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Pagination offset — 0-indexed. Use with rows for paging through large result sets.',
      ),
  }),

  output: z.object({
    objects: z
      .array(ObjectSummarySchema)
      .describe('Curated object summaries for the current page.'),
    total_count: z
      .number()
      .describe('Total matching objects in the Smithsonian catalog before pagination.'),
  }),

  enrichment: {
    truncated: z.boolean().describe('True when the result set was capped by the rows parameter.'),
    shown: z.number().describe('Number of objects returned in this page.'),
    cap: z.number().describe('The rows cap that was applied.'),
    truncationCeiling: z
      .number()
      .optional()
      .describe('Total matching objects (upper bound for omitted items).'),
  },

  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'No objects matched the query and filters.',
      recovery: 'Broaden the query, remove filters, or check spelling and try again.',
    },
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An unknown or malformed filter value was provided.',
      recovery:
        'Call smithsonian_list_terms with the relevant field name to get the valid vocabulary, then retry with an exact term from that list.',
    },
  ],

  async handler(input, ctx) {
    const svc = getSmithsonianService();

    // Build Lucene field:value filters to embed in q.
    // Multi-word values are quoted; single tokens are bare.
    const filters: string[] = [];
    const f = input.filters;
    if (f?.unit_code) filters.push(`unit_code:${f.unit_code}`);
    if (f?.object_type) filters.push(luceneField('object_type', f.object_type));
    if (f?.date_decade) filters.push(`date:${f.date_decade}`);
    if (f?.culture) filters.push(luceneField('culture', f.culture));
    if (f?.place) filters.push(luceneField('place', f.place));
    if (f?.online_only) filters.push('online_media_type:*');
    if (f?.cc0_only) filters.push('media_usage:CC0');

    const rows = Math.min(input.rows, 100);
    ctx.log.info('Searching Smithsonian', {
      query: input.query,
      rows,
      start: input.start,
      filters,
    });

    const { rows: objects, rowCount } = await svc.search(
      { query: input.query, rows, start: input.start, filters },
      ctx,
    );

    if (objects.length === 0) {
      throw ctx.fail('no_results', `No Smithsonian objects matched query "${input.query}".`, {
        query: input.query,
        filters: input.filters,
      });
    }

    ctx.log.info('Search complete', { count: objects.length, total: rowCount });

    if (objects.length < rowCount) {
      ctx.enrich.truncated({ shown: objects.length, cap: rows, ceiling: rowCount });
    }

    return { objects, total_count: rowCount };
  },

  format: (result) => {
    const lines: string[] = [
      `**${result.total_count.toLocaleString()} total results** — showing ${result.objects.length}\n`,
    ];
    for (const obj of result.objects) {
      lines.push(`### ${obj.title}`);
      lines.push(`**ID:** ${obj.record_id} | **Museum:** ${obj.museum_name} (${obj.unit_code})`);
      if (obj.object_type) lines.push(`**Type:** ${obj.object_type}`);
      lines.push(
        `**CC0:** ${obj.is_cc0 ? 'Yes' : 'No'} | **Has media:** ${obj.has_media ? 'Yes' : 'No'}`,
      );
      if (obj.thumbnail_url) lines.push(`**Thumbnail:** ${obj.thumbnail_url}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
