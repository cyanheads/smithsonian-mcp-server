/**
 * @fileoverview smithsonian_search tool — full-text search across 19.4M Smithsonian objects.
 * @module mcp-server/tools/definitions/smithsonian-search.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';
import { getSmithsonianService } from '@/services/smithsonian/smithsonian-service.js';

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
    'Search across 19.4 million Smithsonian objects by text query and optional filters. Filters narrow by museum unit, object type, decade, culture, geographic place, media type, and online-only availability. Returns curated summaries (title, date, museum, thumbnail URL, CC0 flag) with the total match count. The record_id in each result is the identifier for smithsonian_get_object, smithsonian_find_related, and smithsonian_get_media.',
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
            'Museum unit code (e.g. "NASM", "NMNH", "SAAM", "NMAH", "NMAAHC", "NMAI", "NPG", "CHNDM", "SIL"). Search first to discover valid codes.',
          ),
        object_type: z
          .string()
          .optional()
          .describe(
            'Object type term (e.g. "Aircraft", "Painting", "Fossil"). Search first to discover valid values.',
          ),
        date_decade: z
          .string()
          .optional()
          .describe(
            'Decade filter (e.g. "1920s", "1960s"). Must match the "NNNNs" format exactly.',
          ),
        culture: z
          .string()
          .optional()
          .describe(
            'Culture term (e.g. "Plains Indian", "Aztec"). Search first to discover valid values.',
          ),
        place: z
          .string()
          .optional()
          .describe(
            'Geographic place (e.g. "United States of America"). Search first to discover valid values.',
          ),
        online_media_type: z
          .enum(['Images', 'Videos', 'Audio', '3D Images'])
          .optional()
          .describe('Restrict to objects with a specific media type.'),
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
    rows: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe(
        'Page size (default 20, max 100). Results beyond 20 spill to DataCanvas when canvas is enabled.',
      ),
    start: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Pagination offset — 0-indexed. Use with rows for paging through large result sets.',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Existing DataCanvas token to extend. Omit to create a fresh canvas when results exceed the preview cap.',
      ),
  }),

  output: z.object({
    objects: z
      .array(ObjectSummarySchema)
      .describe('Curated object summaries for the current page.'),
    total_count: z
      .number()
      .describe('Total matching objects in the Smithsonian catalog before pagination.'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'DataCanvas token when results were spilled (rows > 20 or canvas_id was supplied). Pass to dataframe_query for SQL analysis across the full result set.',
      ),
    table_name: z
      .string()
      .optional()
      .describe('Canvas table name holding the full result set when canvas_id is present.'),
  }),

  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'No objects matched the query and filters.',
      recovery: 'Broaden the query, remove filters, or check spelling and try again.',
    },
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'An unknown or malformed filter value was provided.',
      recovery: 'Use only documented filter fields with values discovered via a prior search.',
    },
  ],

  async handler(input, ctx) {
    const svc = getSmithsonianService();

    // Build filter queries
    const fq: string[] = [];
    const f = input.filters;
    if (f?.unit_code) fq.push(`unit_code:${f.unit_code}`);
    if (f?.object_type) fq.push(`object_type:${f.object_type}`);
    if (f?.date_decade) fq.push(`date:${f.date_decade}`);
    if (f?.culture) fq.push(`culture:${f.culture}`);
    if (f?.place) fq.push(`place:${f.place}`);
    if (f?.online_media_type) fq.push(`online_media_type:${f.online_media_type}`);
    if (f?.online_only) fq.push('online_media_type:*');
    if (f?.cc0_only) fq.push('media_usage:CC0');

    const rows = Math.min(input.rows, 100);
    ctx.log.info('Searching Smithsonian', { query: input.query, rows, start: input.start, fq });

    const { rows: objects, rowCount } = await svc.search(
      { query: input.query, rows, start: input.start, fq },
      ctx,
    );

    if (objects.length === 0) {
      throw ctx.fail('no_results', `No Smithsonian objects matched query "${input.query}".`, {
        query: input.query,
        filters: input.filters,
      });
    }

    ctx.log.info('Search complete', { count: objects.length, total: rowCount });

    // DataCanvas spillover when rows > preview cap or canvas_id supplied
    const PREVIEW_CAP = 20;
    const dataCanvas = getCanvas();
    let canvasId: string | undefined;
    let tableName: string | undefined;

    if (dataCanvas && (rows > PREVIEW_CAP || input.canvas_id)) {
      const instance = await dataCanvas.acquire(input.canvas_id, ctx);
      canvasId = instance.canvasId;

      // Spread to plain objects: ObjectSummary lacks an index signature,
      // so a spread is required to satisfy the canvas Row constraint.
      const canvasRows = objects.map((o) => ({ ...o }));
      const spillResult = await spillover({
        canvas: instance,
        source: canvasRows,
        previewChars: 200_000,
        tableName: 'smithsonian_search',
        signal: ctx.signal,
      });

      tableName = spillResult.spilled ? spillResult.handle.tableName : 'smithsonian_search';
    }

    return {
      objects: objects.slice(0, PREVIEW_CAP),
      total_count: rowCount,
      ...(canvasId && { canvas_id: canvasId }),
      ...(tableName && { table_name: tableName }),
    };
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
    if (result.canvas_id) {
      lines.push(`\n**DataCanvas:** \`${result.canvas_id}\` — table \`${result.table_name}\``);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
