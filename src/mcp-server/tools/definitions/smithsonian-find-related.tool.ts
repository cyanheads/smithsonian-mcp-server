/**
 * @fileoverview smithsonian_find_related tool — discover related objects across Smithsonian collections.
 * @module mcp-server/tools/definitions/smithsonian-find-related.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSmithsonianService, luceneField } from '@/services/smithsonian/smithsonian-service.js';

/**
 * Per-signal upstream fetch cap. Each fan-out fetches from the top (start:0) up to
 * `min(start + limit, MAX_FETCH_PER_SIGNAL)` rows, so `start` can offset the merged
 * interleave without skipping candidates. Beyond this many matches per signal, deeper
 * pages aren't reachable (100 mirrors the max `rows` smithsonian_search accepts).
 */
const MAX_FETCH_PER_SIGNAL = 100;

const RelatedObjectSchema = z
  .object({
    record_id: z
      .string()
      .describe('Object identifier — pass to smithsonian_get_object or smithsonian_get_media.'),
    title: z.string().describe('Object title.'),
    unit_code: z.string().describe('Museum unit code.'),
    museum_name: z.string().describe('Full museum name.'),
    thumbnail_url: z.string().optional().describe('Thumbnail URL if available.'),
    is_cc0: z.boolean().describe('True when the object is CC0 open access.'),
    similarity_signals: z
      .array(
        z
          .string()
          .describe(
            'A metadata signal that connected this object to the anchor (e.g. "culture: Plains Indian").',
          ),
      )
      .describe('Metadata terms that connected this object to the anchor.'),
  })
  .describe('A related object with its connecting metadata signals.');

export const smithsonianFindRelated = tool('smithsonian_find_related', {
  title: 'Find Related Smithsonian Objects',
  description:
    "Discover objects across Smithsonian collections related to a given anchor object. Fetches the anchor object's metadata (culture, period, object type, maker names, topic terms), then fans out up to 4 parallel searches using different metadata signals as queries. Deduplicates against the anchor and interleaves results across the fan-out signals so each signal contributes. Cross-museum discovery is the differentiator — an NASM aerospace anchor may surface related objects from NMNH, SAAM, and NMAH.",
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    id: z
      .string()
      .describe(
        'record_id of the anchor object (e.g. "nasm_A19670093000") from smithsonian_search or smithsonian_get_object.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(10)
      .describe('Maximum number of related objects to return (default 10, max 20).'),
    start: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        `Pagination offset into the interleaved related-object sequence — 0-indexed. Page contiguously with start = page × limit: page N+1 continues where page N ended, within the first ${MAX_FETCH_PER_SIGNAL} related objects per signal. Near a page seam a small, bounded number of objects (up to the active-signal count) can shift by one page when a deeper page surfaces an object that ranks very differently across signals. Beyond the cap, truncated stays true but deeper pages aren't reachable.`,
      ),
  }),

  output: z.object({
    anchor: z
      .object({
        record_id: z.string().describe('Smithsonian catalog record ID for the input object.'),
        title: z.string().describe('Title of the input object from the catalog.'),
        unit_code: z.string().describe('Museum unit code for the input object (e.g. "NASM").'),
      })
      .describe('Summary of the anchor object used to drive the fan-out searches.'),
    related: z
      .array(RelatedObjectSchema)
      .describe(
        'Related objects interleaved across the fan-out signals so each signal contributes. Empty when no related objects were found across all fan-out searches.',
      ),
    search_signals_used: z
      .array(z.string().describe('A metadata signal used for a fan-out search.'))
      .describe('Metadata fields that drove the fan-out searches.'),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the related list is incomplete — either capped by the limit or more results exist upstream past the current page (advance start to retrieve them).',
      ),
    shown: z.number().optional().describe('Number of related objects returned.'),
    cap: z.number().optional().describe('The limit cap that was applied.'),
    truncationCeiling: z
      .number()
      .optional()
      .describe(
        'Upper bound on total related objects across the contributing signals (sum of each fan-out signal’s upstream match count; cross-signal overlaps are not subtracted).',
      ),
  },

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The anchor object ID does not exist in the Smithsonian catalog.',
      recovery: 'Verify the ID via smithsonian_search and use the record_id from search results.',
    },
    {
      reason: 'invalid_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The ID is empty or contains only whitespace.',
      recovery:
        'Use record_id values directly from smithsonian_search results — do not construct IDs manually.',
    },
  ],

  async handler(input, ctx) {
    if (!input.id.trim()) {
      throw ctx.fail('invalid_id', 'Anchor object ID must not be empty.', {
        ...ctx.recoveryFor('invalid_id'),
        id: input.id,
      });
    }

    const svc = getSmithsonianService();
    ctx.log.info('Finding related objects', { id: input.id, limit: input.limit });

    // Step 1: fetch anchor
    const anchorRaw = await svc.getContent(input.id, ctx);
    const anchorSummary = svc.toSummary(anchorRaw);

    const indexed = anchorRaw.content?.indexedStructured;
    const freetext = anchorRaw.content?.freetext;

    // Extract metadata signals for fan-out
    const cultures = indexed?.culture?.slice(0, 2) ?? [];
    const makerNames = (freetext?.name ?? [])
      .map((n) => n.content)
      .filter((n): n is string => Boolean(n))
      .slice(0, 2);
    const topics = (indexed?.topic ?? []).slice(0, 2);
    const objectTypes = indexed?.object_type ?? [];
    const dates = indexed?.date ?? [];

    // Build fan-out queries: culture, maker, topic, period+type.
    // Field constraints are embedded in q as Lucene field:value terms.
    type FanOut = { query: string; filters: string[]; signal: string };
    const fanOuts: FanOut[] = [];

    const culture0 = cultures[0];
    if (culture0) {
      fanOuts.push({
        query: '',
        filters: [luceneField('culture', culture0)],
        signal: `culture: ${culture0}`,
      });
    }
    const maker0 = makerNames[0];
    if (maker0) {
      fanOuts.push({
        query: maker0,
        filters: [],
        signal: `maker: ${maker0}`,
      });
    }
    const topic0 = topics[0];
    if (topic0) {
      fanOuts.push({
        query: topic0,
        filters: [],
        signal: `topic: ${topic0}`,
      });
    }
    // Always add period+type combo
    const period = dates[0];
    const objType = objectTypes[0];
    if (period || objType) {
      const filters = [
        period && `date:${period}`,
        objType && luceneField('object_type', objType),
      ].filter((x): x is string => Boolean(x));
      const signal = [period && `period: ${period}`, objType && `type: ${objType}`]
        .filter(Boolean)
        .join(', ');
      fanOuts.push({ query: '', filters, signal });
    }

    const searchSignalsUsed = fanOuts.map((f) => f.signal);
    ctx.log.info('Fan-out searches', { signals: searchSignalsUsed });

    // Step 2: fan-out searches in parallel (graceful degradation). Each signal fetches
    // from the top (start:0) enough rows to cover the requested page — the start offset
    // is applied to the MERGED interleave below, not the upstream query. Offsetting the
    // upstream query instead would fetch a disjoint window per page and permanently drop
    // the fetched-but-unshown candidates the round-robin merge didn't reach. rowCount is
    // the signal's upstream total, used for the ceiling and truncation below.
    const fetchedRows = Math.min(input.start + input.limit, MAX_FETCH_PER_SIGNAL);
    const fanOutResults = await Promise.allSettled(
      fanOuts.map((fo) =>
        svc
          .search({ query: fo.query, rows: fetchedRows, start: 0, filters: fo.filters }, ctx)
          .then((res) => ({ items: res.rows, signal: fo.signal, rowCount: res.rowCount })),
      ),
    );

    // Step 3: accumulate every signal per record_id, bucket by first-discovery
    // order for round-robin fairness, then interleave so each signal contributes
    // before any one backfills.
    const anchorId = anchorSummary.record_id;
    // record_id → every distinct signal that surfaced it. The array reference is
    // shared into each bucket entry, so a later fan-out that re-surfaces an id
    // accumulates onto the same array the merge step reads — preserving every
    // signal even across fan-outs (issue #19).
    const signalsById = new Map<string, string[]>();
    // First fan-out to see an id claims it for bucket membership (round-robin
    // fairness); the anchor is pre-claimed so it can never surface as related.
    const claimed = new Set<string>([anchorId]);
    // Each contributing fan-out becomes one bucket; rowCount drives the truncation
    // ceiling and the "more upstream" disclosure (issue #18).
    const buckets: Array<{
      entries: { item: typeof anchorSummary; signals: string[] }[];
      rowCount: number;
    }> = [];

    for (const result of fanOutResults) {
      if (result.status === 'rejected') continue;
      const { items, signal, rowCount } = result.value;
      const entries: { item: typeof anchorSummary; signals: string[] }[] = [];
      for (const item of items) {
        if (item.record_id === anchorId) continue;
        let signals = signalsById.get(item.record_id);
        if (signals) {
          if (!signals.includes(signal)) signals.push(signal);
        } else {
          signals = [signal];
          signalsById.set(item.record_id, signals);
        }
        // Claim the id for exactly one bucket (first-discovery); later fan-outs
        // still accumulate the signal above, they just don't re-add the item.
        if (!claimed.has(item.record_id)) {
          claimed.add(item.record_id);
          entries.push({ item, signals });
        }
      }
      if (entries.length > 0) buckets.push({ entries, rowCount });
    }

    // Round-robin interleave the FULL candidate pool: take one item from each bucket
    // per round so every signal contributes before any one backfills. Each entry's
    // signals array is the live accumulator, so it already carries every signal that
    // surfaced the id. The whole sequence is built (not capped at one page) so `start`
    // can offset into it — page N+1 (start = N × limit) continues exactly where page N
    // ended, with no gap or overlap within the fetched window.
    const merged: { item: typeof anchorSummary; signals: string[] }[] = [];
    let round = 0;
    let advanced = true;
    while (advanced) {
      advanced = false;
      for (const bucket of buckets) {
        const entry = bucket.entries[round];
        if (!entry) continue;
        merged.push(entry);
        advanced = true;
      }
      round++;
    }

    // Offset into the interleaved sequence and take one page.
    const page = merged.slice(input.start, input.start + input.limit);

    const related = page.map(({ item, signals }) => ({
      record_id: item.record_id,
      title: item.title,
      unit_code: item.unit_code,
      museum_name: item.museum_name,
      thumbnail_url: item.thumbnail_url,
      is_cc0: item.is_cc0,
      similarity_signals: signals,
    }));

    ctx.log.info('Related search complete', {
      anchor: anchorSummary.record_id,
      related_count: related.length,
    });

    // Disclose truncation when related objects were omitted — either the interleaved
    // sequence extends past this page, or a contributing signal has more matches
    // upstream than the fetch reached (retrievable by advancing start, up to the cap).
    // The ceiling is an upper bound on the related pool across contributing signals
    // (summed upstream match counts; cross-signal overlap is not subtracted).
    const ceiling = buckets.reduce((sum, b) => sum + b.rowCount, 0);
    // moreInMerged: distinct candidates beyond this page already sit in the merge.
    // moreUpstream: a signal reported more matches than we fetched, so deeper pages
    // exist upstream. Comparing rowCount to the requested fetch size (not the
    // page-local count) avoids false-positiving on a trailing page that lands on the
    // exact end of a signal — there rowCount never exceeds fetchedRows.
    const moreInMerged = merged.length > input.start + input.limit;
    const moreUpstream = buckets.some((b) => b.rowCount > fetchedRows);
    if (moreInMerged || moreUpstream) {
      ctx.enrich.truncated({ shown: related.length, cap: input.limit, ceiling });
    }

    return {
      anchor: {
        record_id: anchorSummary.record_id,
        title: anchorSummary.title,
        unit_code: anchorSummary.unit_code,
      },
      related,
      search_signals_used: searchSignalsUsed,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# Related: ${result.anchor.title}`);
    lines.push(`**Anchor:** \`${result.anchor.record_id}\` (${result.anchor.unit_code})`);
    lines.push(`**Signals used:** ${result.search_signals_used.join(', ')}`);
    lines.push(`**Related objects:** ${result.related.length}\n`);
    for (const obj of result.related) {
      lines.push(`### ${obj.title}`);
      lines.push(`**ID:** ${obj.record_id} | **Museum:** ${obj.museum_name} (${obj.unit_code})`);
      lines.push(`**Connected by:** ${obj.similarity_signals.join(', ')}`);
      lines.push(`**CC0:** ${obj.is_cc0 ? 'Yes' : 'No'}`);
      if (obj.thumbnail_url) lines.push(`**Thumbnail:** ${obj.thumbnail_url}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
