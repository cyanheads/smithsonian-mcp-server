/**
 * @fileoverview smithsonian_search_objects tool — full-text search across 19.4M Smithsonian objects.
 * @module mcp-server/tools/definitions/smithsonian-search-objects.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSmithsonianService, luceneField } from '@/services/smithsonian/smithsonian-service.js';

/**
 * Collect distinct, defined string values in first-seen order, capped so the
 * harvested recovery hint stays bounded. Used on the filtered-zero error path
 * to gather controlled-vocabulary values from an unfiltered re-query.
 */
function distinctValues(values: Array<string | undefined>, cap = 12): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Search-filter field → the smithsonian_list_terms field that enumerates its
 * vocabulary. These three are absent from ObjectSummary, so a filtered-zero can't
 * harvest them from result summaries — they route to list_terms with a `contains`
 * substring instead. `date_decade` maps to the list_terms `date` field.
 */
const LIST_TERMS_FIELD = { culture: 'culture', place: 'place', date_decade: 'date' } as const;

/**
 * Compose the filtered-zero recovery hint. culture/place/date_decade values route to
 * smithsonian_list_terms with a `contains` substring (their vocabulary isn't in result
 * summaries); object_type/unit_code values ARE in summaries, so they're named from the
 * unfiltered harvest. Returns '' when neither applies, so the caller keeps the static
 * contract hint.
 */
function composeFilterHint(
  routableFilters: Array<{ filter: string; field: string; value: string }>,
  objectTypes: string[],
  unitCodes: string[],
): string {
  const parts: string[] = [];
  for (const { filter, field, value } of routableFilters) {
    parts.push(
      `Your ${filter} filter "${value}" matched nothing — resolve it to an exact term with ` +
        `smithsonian_list_terms { field: "${field}", contains: "${value}" }.`,
    );
  }
  const harvested: string[] = [];
  if (objectTypes.length > 0) harvested.push(`object_type: ${objectTypes.join(', ')}`);
  if (unitCodes.length > 0) harvested.push(`unit_code: ${unitCodes.join(', ')}`);
  if (harvested.length > 0) {
    parts.push(
      `Values present for this query — ${harvested.join('; ')}. ` +
        `Retry with one of these exact terms (object_type is commonly plural, e.g. "Paintings").`,
    );
  }
  return parts.join(' ');
}

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
        'Museum unit code (e.g. "NASM", "SAAM", "NMNHBIRDS"). Use as a filter in future searches.',
      ),
    museum_name: z
      .string()
      .describe(
        'Full museum name for the unit code. A few rarely-indexed archive sub-unit codes have no mapped name and fall back to the raw unit code.',
      ),
    object_type: z
      .string()
      .optional()
      .describe('Object type term (e.g. "Aircraft", "Paintings", "Photographs").'),
    date: z
      .string()
      .optional()
      .describe(
        'Decade-level date the catalog indexes for the object (e.g. "1960s"). Sparse — omitted when the record has no indexed date.',
      ),
    thumbnail_url: z
      .string()
      .optional()
      .describe('Thumbnail image URL (~120px) if the object has online media.'),
    is_cc0: z
      .boolean()
      .describe(
        'True when the object metadata is CC0 (open access). Use smithsonian_get_media for CC0 image downloads.',
      ),
    has_media: z
      .boolean()
      .describe(
        'True when the object carries deliverable online media items. This is the signal smithsonian_get_media reads, so it — not the online_only filter — predicts whether that call returns anything.',
      ),
  })
  .describe('Curated summary of a single Smithsonian catalog object.');

export const smithsonianSearchObjects = tool('smithsonian_search_objects', {
  title: 'Search Smithsonian Objects',
  description:
    'Recommended first step for open-ended or topic discovery: free-text search across 19.4 million Smithsonian objects, with optional exact filters. Filters narrow by museum unit, object type, decade, culture, geographic place, and online/CC0 availability. Returns curated summaries (title, date, museum, thumbnail URL, CC0 flag) with the total match count. The record_id in each result is the identifier for smithsonian_get_object, smithsonian_find_related, and smithsonian_get_media. To browse one exact category — a single museum, culture, decade, or object type — use smithsonian_browse_category instead.',
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
            'Museum unit code (e.g. "NASM", "SAAM", "NMAH", "NMAAHC", "NMAI", "NPG", "CHNDM", "SIL"); the National Museum of Natural History is indexed under discipline sub-units like "NMNHBIRDS" and "NMNHPALEO", not a bare "NMNH". The full set is enumerable via smithsonian_list_terms (field "unit_code").',
          ),
        object_type: z
          .string()
          .optional()
          .describe(
            'Object type term from Smithsonian\'s controlled vocabulary — commonly plural (e.g. "Paintings", "Photographs", "Aircraft"). Singular everyday forms like "Painting" usually return nothing. This field is not enumerable via smithsonian_list_terms; harvest valid values from the object_type field in smithsonian_search_objects results.',
          ),
        date_decade: z
          .string()
          .regex(/^\d{4}s$/, 'Decade must be in "NNNNs" format, e.g. "1920s".')
          .optional()
          .describe(
            'Decade filter (e.g. "1920s", "1960s"). Must match the "NNNNs" format exactly. Indexed decades are enumerable via smithsonian_list_terms (field "date").',
          ),
        culture: z
          .string()
          .optional()
          .describe(
            'Culture term from the controlled vocabulary — often plural or qualified (e.g. "Aztecs", "Plains Indian"). The vocabulary is enumerable via smithsonian_list_terms (field "culture").',
          ),
        place: z
          .string()
          .optional()
          .describe(
            'Geographic place (e.g. "United States of America"). The full set is enumerable via smithsonian_list_terms (field "place").',
          ),
        online_only: z
          .boolean()
          .optional()
          .describe(
            'When true, restrict to records carrying an indexed online_media_type value. That vocabulary covers digitized surrogates — finding aids, catalog cards, scanned books, full text, electronic resources — alongside images, 3D models, and video, and the surrogate types often have no deliverable media attached, so a match can still report has_media: false. Read has_media on each result to decide whether smithsonian_get_media will return anything.',
          ),
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
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when matching objects remain past this page. False on a terminal or past-the-end page, where nothing is being withheld.',
      ),
    shown: z.number().optional().describe('Number of objects returned in this page.'),
    cap: z.number().optional().describe('The rows cap that was applied.'),
    truncationCeiling: z
      .number()
      .optional()
      .describe('Total matching objects (upper bound for omitted items).'),
    notice: z
      .string()
      .optional()
      .describe('Guidance naming the input that retrieves the objects this page omitted.'),
  },

  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'An unfiltered query matched no objects.',
      recovery: 'Broaden the query or check spelling and try again.',
    },
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A filtered search matched nothing — most often a filter value outside the Smithsonian controlled vocabulary (e.g. a singular "Painting" instead of "Paintings").',
      recovery:
        'Call smithsonian_list_terms with the relevant field (unit_code, culture, place, date) and a contains substring to resolve a filter value to an exact vocabulary term, then retry. Note object_type is not enumerable — harvest its values from search results.',
    },
  ],

  async handler(input, ctx) {
    const svc = getSmithsonianService();

    // Build Lucene field:value filters to embed in q.
    // Multi-word values are quoted; single tokens are bare.
    const filters: string[] = [];
    const f = input.filters;
    if (f?.unit_code) filters.push(luceneField('unit_code', f.unit_code));
    if (f?.object_type) filters.push(luceneField('object_type', f.object_type));
    if (f?.date_decade) filters.push(luceneField('date', f.date_decade));
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

    // Guard on the TRUE match count, not the page-local length. A deep `start`
    // past the end of a real result set returns an empty page with rowCount > 0 —
    // normal pagination completion, not a query that matched nothing. Firing
    // no_results there tells a caller with hundreds of real matches to check
    // their spelling (issue #29).
    if (rowCount === 0) {
      // A filtered zero-result is most often a filter value outside the
      // controlled vocabulary — surface the actionable invalid_filter reason
      // (recovery points at smithsonian_list_terms) rather than generic no_results.
      if (filters.length > 0) {
        // culture/place/date_decade values aren't present in ObjectSummary, so a
        // result harvest can't resolve them — route each to smithsonian_list_terms
        // with a `contains` substring instead. object_type/unit_code ARE in summaries,
        // so those are harvested from one unfiltered re-query and named in the hint.
        // Harvesting is best-effort and failure-path only: any error or an empty
        // re-query keeps the static contract hint, so it never turns a clean
        // invalid_filter into a crash.
        const routableFilters: Array<{ filter: string; field: string; value: string }> = [];
        if (f?.culture)
          routableFilters.push({
            filter: 'culture',
            field: LIST_TERMS_FIELD.culture,
            value: f.culture,
          });
        if (f?.place)
          routableFilters.push({ filter: 'place', field: LIST_TERMS_FIELD.place, value: f.place });
        if (f?.date_decade)
          routableFilters.push({
            filter: 'date_decade',
            field: LIST_TERMS_FIELD.date_decade,
            value: f.date_decade,
          });

        // Harvest only when object_type/unit_code is the culprit — those are the only
        // filters whose exact values an unfiltered re-query can surface.
        let objectTypes: string[] = [];
        let unitCodes: string[] = [];
        if (f?.object_type || f?.unit_code) {
          try {
            const { rows: sample } = await svc.search(
              { query: input.query, rows: 100, start: 0, filters: [] },
              ctx,
            );
            objectTypes = distinctValues(sample.map((o) => o.object_type));
            unitCodes = distinctValues(sample.map((o) => o.unit_code));
          } catch {
            // Harvesting is best-effort — fall back to the static contract hint.
          }
        }

        const hint = composeFilterHint(routableFilters, objectTypes, unitCodes);
        const recovery: Record<string, unknown> = hint
          ? { recovery: { hint } }
          : ctx.recoveryFor('invalid_filter');

        throw ctx.fail(
          'invalid_filter',
          `No Smithsonian objects matched query "${input.query}" with the given filters. A filter value may not be an exact controlled-vocabulary term, or the query and filters may legitimately have no overlap.`,
          { ...recovery, query: input.query, filters: input.filters },
        );
      }
      throw ctx.fail('no_results', `No Smithsonian objects matched query "${input.query}".`, {
        ...ctx.recoveryFor('no_results'),
        query: input.query,
      });
    }

    ctx.log.info('Search complete', { count: objects.length, total: rowCount });

    // Account for the offset already consumed: a page is incomplete only when
    // objects remain BEYOND it. Comparing the page-local length against the total
    // reports truncated on every page past the first, including the terminal and
    // past-the-end pages the rowCount guard above now lets through.
    if (input.start + objects.length < rowCount) {
      ctx.enrich.truncated({
        shown: objects.length,
        cap: rows,
        ceiling: rowCount,
        guidance:
          `${rowCount} objects match; this page shows ${objects.length} from offset ${input.start}. ` +
          'Retrieve the rest by advancing start (start = page × rows, rows max 100), or narrow with filters.',
      });
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
      if (obj.date) lines.push(`**Date:** ${obj.date}`);
      lines.push(
        `**CC0:** ${obj.is_cc0 ? 'Yes' : 'No'} | **Has media:** ${obj.has_media ? 'Yes' : 'No'}`,
      );
      if (obj.thumbnail_url) lines.push(`**Thumbnail:** ${obj.thumbnail_url}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
