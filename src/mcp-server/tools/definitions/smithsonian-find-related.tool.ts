/**
 * @fileoverview smithsonian_find_related tool — discover related objects across Smithsonian collections.
 * @module mcp-server/tools/definitions/smithsonian-find-related.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSmithsonianService } from '@/services/smithsonian/smithsonian-service.js';

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
    "Discover objects across Smithsonian collections related to a given anchor object. Fetches the anchor object's metadata (culture, period, object type, maker names, topic terms), then fans out up to 4 parallel searches using different metadata signals as queries. Deduplicates against the anchor and merges results into a ranked list. Cross-museum discovery is the differentiator — an NASM aerospace anchor may surface related objects from NMNH, SAAM, and NMAH.",
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
        'Related objects ranked by number of matching metadata signals. Empty when no related objects were found across all fan-out searches.',
      ),
    search_signals_used: z
      .array(z.string().describe('A metadata signal used for a fan-out search.'))
      .describe('Metadata fields that drove the fan-out searches.'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The anchor object ID does not exist in the Smithsonian catalog.',
      recovery: 'Verify the ID via smithsonian_search and use the record_id from search results.',
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
      throw ctx.fail('invalid_id', 'Anchor object ID must not be empty.', { id: input.id });
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

    // Build fan-out queries: culture, maker, topic, period+type
    type FanOut = { query: string; fq: string[]; signal: string };
    const fanOuts: FanOut[] = [];

    if (cultures.length > 0) {
      fanOuts.push({
        query: cultures[0]!,
        fq: [`culture:${cultures[0]!}`],
        signal: `culture: ${cultures[0]!}`,
      });
    }
    if (makerNames.length > 0) {
      fanOuts.push({
        query: makerNames[0]!,
        fq: [],
        signal: `maker: ${makerNames[0]!}`,
      });
    }
    if (topics.length > 0) {
      fanOuts.push({
        query: topics[0]!,
        fq: ['type:edanmdm'],
        signal: `topic: ${topics[0]!}`,
      });
    }
    // Always add period+type combo
    const period = dates[0];
    const objType = objectTypes[0];
    if (period || objType) {
      const q = [period, objType].filter(Boolean).join(' ');
      const signal = [period && `period: ${period}`, objType && `type: ${objType}`]
        .filter(Boolean)
        .join(', ');
      fanOuts.push({ query: q, fq: ['type:edanmdm'], signal });
    }

    const searchSignalsUsed = fanOuts.map((f) => f.signal);
    ctx.log.info('Fan-out searches', { signals: searchSignalsUsed });

    // Step 2: fan-out searches in parallel (graceful degradation)
    const fanOutResults = await Promise.allSettled(
      fanOuts.map((fo) =>
        svc.search({ query: fo.query, rows: 10, start: 0, fq: fo.fq }, ctx).then((res) => ({
          items: res.rows,
          signal: fo.signal,
        })),
      ),
    );

    // Step 3: collect, deduplicate, rank
    const seen = new Set<string>([anchorSummary.record_id]);
    const relatedMap = new Map<string, { item: typeof anchorSummary; signals: string[] }>();

    for (const result of fanOutResults) {
      if (result.status === 'rejected') continue;
      const { items, signal } = result.value;
      for (const item of items) {
        if (seen.has(item.record_id)) continue;
        seen.add(item.record_id);
        const existing = relatedMap.get(item.record_id);
        if (existing) {
          existing.signals.push(signal);
        } else {
          relatedMap.set(item.record_id, { item, signals: [signal] });
        }
      }
    }

    // Sort by signal count descending, cap at limit
    const related = [...relatedMap.values()]
      .sort((a, b) => b.signals.length - a.signals.length)
      .slice(0, input.limit)
      .map(({ item, signals }) => ({
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
