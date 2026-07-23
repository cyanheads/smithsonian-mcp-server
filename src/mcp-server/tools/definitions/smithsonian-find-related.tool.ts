/**
 * @fileoverview smithsonian_find_related tool — discover related objects across Smithsonian collections.
 * @module mcp-server/tools/definitions/smithsonian-find-related.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSmithsonianService, luceneField } from '@/services/smithsonian/smithsonian-service.js';

/**
 * Per-signal fetch depth cap. Each fan-out signal is fetched from the top
 * (upstream start:0) up to `min(start + limit, MAX_FETCH_PER_SIGNAL)` rows, so
 * `start` can offset the merged interleave without skipping candidates. The depth
 * is fetched in chunks of at most `MAX_ROWS_PER_UPSTREAM_CALL` and concatenated,
 * so a page well past a single upstream call stays reachable. A signal with more
 * matches than this cap is still disclosed via `truncationCeiling`, but its rows
 * beyond the cap aren't reachable through this tool.
 */
const MAX_FETCH_PER_SIGNAL = 5000;

/**
 * Hard upstream ceiling on `rows` for a single `/search` call. The EDAN API
 * silently returns a 10-row default page (HTTP 200, no error) when `rows` exceeds
 * 1000 rather than clamping, so a deeper per-signal fetch must be split into
 * chunks of at most this many rows.
 */
const MAX_ROWS_PER_UPSTREAM_CALL = 1000;

const RelatedObjectSchema = z
  .object({
    record_id: z
      .string()
      .describe('Object identifier — pass to smithsonian_get_object or smithsonian_get_media.'),
    title: z.string().describe('Object title.'),
    unit_code: z.string().describe('Museum unit code.'),
    museum_name: z
      .string()
      .describe(
        'Full museum name. A few rarely-indexed archive sub-unit codes have no mapped name and fall back to the raw unit code.',
      ),
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

/**
 * The `smithsonian_search` call that reproduces one fan-out exactly. Every query
 * this tool builds has a 1:1 equivalent in that tool's `query`/`filters` input,
 * and `smithsonian_search` applies `start` straight to the upstream offset with
 * no per-signal depth cap — so this is the retrieval path for a signal's matches
 * beyond the merged interleave's per-signal reach.
 */
const SearchContinuationSchema = z
  .object({
    query: z
      .string()
      .describe(
        "Pass verbatim as smithsonian_search's query. Empty when the signal is expressed entirely through filters.",
      ),
    filters: z
      .object({
        culture: z.string().optional().describe('smithsonian_search filters.culture value.'),
        object_type: z
          .string()
          .optional()
          .describe('smithsonian_search filters.object_type value.'),
        date_decade: z
          .string()
          .optional()
          .describe('smithsonian_search filters.date_decade value.'),
      })
      .optional()
      .describe(
        "Pass verbatim as smithsonian_search's filters. Omitted when the signal's constraint is already carried entirely by query.",
      ),
  })
  .describe(
    "Exact smithsonian_search input that reproduces this signal's full match set, at any depth.",
  );

export const smithsonianFindRelated = tool('smithsonian_find_related', {
  title: 'Find Related Smithsonian Objects',
  description:
    'Discover objects across Smithsonian collections related to a given anchor object, matched on shared metadata signals — culture, period, object type, maker names, and topic terms. Each related object is tagged with the signals that connected it to the anchor. Matches surface across museums — an NASM aerospace anchor can pull related objects from NMNHPALEO, SAAM, and NMAH.',
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
        `Pagination offset — 0-indexed. Page contiguously with start = page × limit; each signal is reachable to a depth of ${MAX_FETCH_PER_SIGNAL} objects, beyond which truncated stays true but deeper pages aren't retrievable.`,
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
    signals: z
      .array(
        z
          .object({
            signal: z
              .string()
              .describe(
                'Matches an entry in search_signals_used and in related[].similarity_signals.',
              ),
            row_count: z
              .number()
              .describe(
                `True upstream match count for this signal, uncapped — it can exceed the ${MAX_FETCH_PER_SIGNAL}-per-signal depth this tool's own paging reaches.`,
              ),
            search_continuation: SearchContinuationSchema,
          })
          .describe('One fan-out signal with its true size and its retrieval path.'),
      )
      .describe(
        `Per-signal breakdown of every fan-out that returned. Use search_continuation with smithsonian_search to retrieve a signal's matches past this tool's ${MAX_FETCH_PER_SIGNAL}-per-signal reach. A signal whose upstream call failed is omitted.`,
      ),
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
        "Upper bound on the related objects reachable by paging with start. Cross-signal overlaps are not subtracted, so it can overcount. Signals larger than this tool's per-signal reach are counted at that reach — see signals[].row_count for their true size.",
      ),
    notice: z
      .string()
      .optional()
      .describe(
        "Guidance naming the inputs that retrieve the related objects this page omitted — start for the next page, signals[].search_continuation for a signal past this tool's reach.",
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
    // `continuation` is the equivalent smithsonian_search input, captured here
    // where the raw signal values are still in hand rather than reverse-parsed
    // out of the Lucene strings (issue #18).
    type FanOut = {
      query: string;
      filters: string[];
      signal: string;
      continuation: z.infer<typeof SearchContinuationSchema>;
    };
    const fanOuts: FanOut[] = [];

    const culture0 = cultures[0];
    if (culture0) {
      fanOuts.push({
        query: '',
        filters: [luceneField('culture', culture0)],
        signal: `culture: ${culture0}`,
        continuation: { query: '', filters: { culture: culture0 } },
      });
    }
    const maker0 = makerNames[0];
    if (maker0) {
      fanOuts.push({
        query: maker0,
        filters: [],
        signal: `maker: ${maker0}`,
        continuation: { query: maker0 },
      });
    }
    const topic0 = topics[0];
    if (topic0) {
      fanOuts.push({
        query: topic0,
        filters: [],
        signal: `topic: ${topic0}`,
        continuation: { query: topic0 },
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
      // smithsonian_search's date_decade only accepts the "NNNNs" shape, but EDAN
      // indexes date terms in many others (year ranges, BCE values). When the period
      // isn't decade-shaped the structured filter can't carry it, so the continuation
      // falls back to the fan-out's exact Lucene expression — smithsonian_search
      // forwards `query` verbatim when no filters accompany it, reproducing the
      // identical upstream q either way.
      const decade = period && /^\d{4}s$/.test(period) ? period : undefined;
      const continuation: z.infer<typeof SearchContinuationSchema> =
        period && !decade
          ? { query: filters.join(' AND ') }
          : {
              query: '',
              filters: {
                ...(decade && { date_decade: decade }),
                ...(objType && { object_type: objType }),
              },
            };
      fanOuts.push({ query: '', filters, signal, continuation });
    }

    const searchSignalsUsed = fanOuts.map((f) => f.signal);
    ctx.log.info('Fan-out searches', { signals: searchSignalsUsed });

    // Step 2: fan-out searches in parallel (graceful degradation). Each signal fetches
    // from the top (upstream start:0) enough rows to cover the requested page — the
    // start offset is applied to the MERGED interleave below, not the upstream query.
    // Offsetting the upstream query instead would fetch a disjoint window per page and
    // permanently drop the fetched-but-unshown candidates the round-robin merge didn't
    // reach. The depth is fetched in chunks of at most MAX_ROWS_PER_UPSTREAM_CALL: wave 1
    // is a single call — covering the common depth ≤ one chunk case at the same cost as
    // an un-chunked fetch — that also reveals the signal's real upstream rowCount; wave 2
    // fetches the remaining start:1000, 2000, … chunks in parallel, and only when both
    // the requested depth and the real total exceed one chunk. rowCount is the signal's
    // upstream total, used for the ceiling and truncation below. A chunk rejection
    // bubbles to the outer allSettled, dropping the whole signal rather than leaving a
    // gap in the middle of its contiguous range.
    const neededDepth = Math.min(input.start + input.limit, MAX_FETCH_PER_SIGNAL);
    const fetchSignal = async (fo: FanOut) => {
      const wave1 = await svc.search(
        {
          query: fo.query,
          rows: Math.min(neededDepth, MAX_ROWS_PER_UPSTREAM_CALL),
          start: 0,
          filters: fo.filters,
        },
        ctx,
      );
      const items = [...wave1.rows];
      const reachable = Math.min(neededDepth, wave1.rowCount);
      if (reachable > MAX_ROWS_PER_UPSTREAM_CALL) {
        const starts: number[] = [];
        for (let s = MAX_ROWS_PER_UPSTREAM_CALL; s < reachable; s += MAX_ROWS_PER_UPSTREAM_CALL) {
          starts.push(s);
        }
        const laterChunks = await Promise.all(
          starts.map((start) =>
            svc.search(
              {
                query: fo.query,
                rows: Math.min(MAX_ROWS_PER_UPSTREAM_CALL, reachable - start),
                start,
                filters: fo.filters,
              },
              ctx,
            ),
          ),
        );
        for (const chunk of laterChunks) items.push(...chunk.rows);
      }
      return { items, signal: fo.signal, rowCount: wave1.rowCount };
    };
    const fanOutResults = await Promise.allSettled(fanOuts.map(fetchSignal));

    // Per-signal disclosure (issue #18). The merged interleave reaches at most
    // MAX_FETCH_PER_SIGNAL rows per signal, so a broad signal has matches no `start`
    // on this tool can retrieve. row_count is the uncapped upstream truth and
    // search_continuation is the escape hatch — allSettled preserves input order,
    // so each result pairs with the fan-out that produced it. A rejected fan-out
    // contributed nothing and has no known row count, so it's omitted rather than
    // disclosed as zero.
    const signals = fanOuts.flatMap((fo, index) => {
      const settled = fanOutResults[index];
      if (settled?.status !== 'fulfilled') return [];
      return [
        {
          signal: fo.signal,
          row_count: settled.value.rowCount,
          search_continuation: fo.continuation,
        },
      ];
    });

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
    // The ceiling is an upper bound on the reachable related pool: each signal's
    // upstream match count is capped at MAX_FETCH_PER_SIGNAL (its reach) before summing,
    // so the disclosed ceiling never exceeds what start can actually reach. Cross-signal
    // overlap is not subtracted.
    const ceiling = buckets.reduce((sum, b) => sum + Math.min(b.rowCount, MAX_FETCH_PER_SIGNAL), 0);
    // moreInMerged: distinct candidates beyond this page already sit in the merge.
    // moreUpstream: a signal reported more matches than we fetched, so deeper pages
    // exist upstream. Comparing rowCount to the targeted fetch depth (not the
    // page-local count) avoids false-positiving on a trailing page that lands on the
    // exact end of a signal — there rowCount never exceeds neededDepth.
    const moreInMerged = merged.length > input.start + input.limit;
    const moreUpstream = buckets.some((b) => b.rowCount > neededDepth);
    if (moreInMerged || moreUpstream) {
      // Two-tier continuation: `start` pages the merged interleave up to each
      // signal's MAX_FETCH_PER_SIGNAL reach; signals[].search_continuation is the
      // only path past it. Name both, because a broad signal exhausts the first
      // long before the ceiling is reached.
      ctx.enrich.truncated({
        shown: related.length,
        cap: input.limit,
        ceiling,
        guidance:
          `Showing ${related.length} related objects from offset ${input.start}. ` +
          'Advance start (start = page × limit) for the next page. Each signal is reachable ' +
          `to ${MAX_FETCH_PER_SIGNAL} objects this way — see signals[].row_count for a signal's true size, ` +
          'and pass its search_continuation to smithsonian_search to retrieve the rest.',
      });
    }

    return {
      anchor: {
        record_id: anchorSummary.record_id,
        title: anchorSummary.title,
        unit_code: anchorSummary.unit_code,
      },
      related,
      search_signals_used: searchSignalsUsed,
      signals,
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
    if (result.signals.length > 0) {
      lines.push('\n## Signals');
      lines.push("Retrieve a signal past this tool's reach with smithsonian_search:\n");
      for (const s of result.signals) {
        const c = s.search_continuation;
        // Each filter key renders in its own block, never as exclusive branches —
        // every field must reach content[] on the same render.
        const filterArgs: string[] = [];
        if (c.filters?.culture) filterArgs.push(`culture: ${JSON.stringify(c.filters.culture)}`);
        if (c.filters?.object_type)
          filterArgs.push(`object_type: ${JSON.stringify(c.filters.object_type)}`);
        if (c.filters?.date_decade)
          filterArgs.push(`date_decade: ${JSON.stringify(c.filters.date_decade)}`);
        const filterArg = filterArgs.length > 0 ? `, filters: { ${filterArgs.join(', ')} }` : '';
        lines.push(`- **${s.signal}** — ${s.row_count} upstream matches`);
        lines.push(`  \`smithsonian_search { query: ${JSON.stringify(c.query)}${filterArg} }\``);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
