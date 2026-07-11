/**
 * @fileoverview Tests for smithsonian_find_related tool.
 * @module tests/mcp-server/tools/definitions/smithsonian-find-related.tool.test
 */

import { JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { smithsonianFindRelated } from '@/mcp-server/tools/definitions/smithsonian-find-related.tool.js';
import * as svcModule from '@/services/smithsonian/smithsonian-service.js';
import type { ObjectSummary, RawEDAN } from '@/services/smithsonian/types.js';

function makeAnchorRaw(id = 'nasm_TEST001'): RawEDAN {
  return {
    id: 'ld1-anchor',
    title: 'Anchor Object',
    unitCode: 'NASM',
    url: `edanmdm:${id}`,
    content: {
      descriptiveNonRepeating: {
        record_ID: id,
        unit_code: 'NASM',
        metadata_usage: { access: 'CC0' },
      },
      indexedStructured: {
        culture: ['American'],
        object_type: ['Aircraft'],
        date: ['1960s'],
        topic: ['Aviation'],
      },
      freetext: {
        name: [{ label: 'Manufacturer', content: 'Lockheed' }],
      },
    },
  };
}

function makeRelatedRows(): ObjectSummary[] {
  return [
    {
      record_id: 'nasm_RELATED001',
      title: 'Related Aircraft 1',
      unit_code: 'NASM',
      museum_name: 'National Air and Space Museum',
      is_cc0: true,
      has_media: true,
    },
    {
      record_id: 'nmah_RELATED002',
      title: 'Related Object 2',
      unit_code: 'NMAH',
      museum_name: 'National Museum of American History',
      is_cc0: false,
      has_media: false,
    },
  ];
}

describe('smithsonianFindRelated', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns related objects for a valid anchor ID', async () => {
    const anchorRaw = makeAnchorRaw();
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue(anchorRaw),
      toSummary: vi.fn().mockReturnValue({
        record_id: 'nasm_TEST001',
        title: 'Anchor Object',
        unit_code: 'NASM',
        museum_name: 'National Air and Space Museum',
        is_cc0: true,
        has_media: true,
      }),
      search: vi.fn().mockResolvedValue({ rows: makeRelatedRows(), rowCount: 2 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    const input = smithsonianFindRelated.input.parse({ id: 'nasm_TEST001' });
    const result = await smithsonianFindRelated.handler(input, ctx);

    expect(result.anchor.record_id).toBe('nasm_TEST001');
    expect(result.anchor.title).toBe('Anchor Object');
    expect(result.related.length).toBeGreaterThan(0);
    expect(result.search_signals_used.length).toBeGreaterThan(0);
    // Anchor should not appear in related
    for (const rel of result.related) {
      expect(rel.record_id).not.toBe('nasm_TEST001');
    }
  });

  it('throws invalid_id for empty ID', async () => {
    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    const input = smithsonianFindRelated.input.parse({ id: '   ' });
    const expectedHint = smithsonianFindRelated.errors?.find(
      (e) => e.reason === 'invalid_id',
    )?.recovery;
    await expect(smithsonianFindRelated.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id', recovery: { hint: expectedHint } },
    });
  });

  it('propagates not_found with reason from the service (issue #10)', async () => {
    // find_related fetches the anchor via getContent; an unknown anchor surfaces the
    // service's real notFound() factory. The tool must propagate data.reason.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockRejectedValue(
        notFound('No Smithsonian object found for ID "nasm_GONE".', {
          recordId: 'nasm_GONE',
          reason: 'not_found',
        }),
      ),
      toSummary: vi.fn(),
      search: vi.fn(),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    const input = smithsonianFindRelated.input.parse({ id: 'nasm_GONE' });
    await expect(smithsonianFindRelated.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  it('deduplicates results — no duplicate record_ids', async () => {
    const anchorRaw = makeAnchorRaw();
    // Fan-out returns overlapping results
    const duplicated = [...makeRelatedRows(), makeRelatedRows()[0]!];
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue(anchorRaw),
      toSummary: vi.fn().mockReturnValue({
        record_id: 'nasm_TEST001',
        title: 'Anchor Object',
        unit_code: 'NASM',
        museum_name: 'National Air and Space Museum',
        is_cc0: true,
        has_media: true,
      }),
      search: vi.fn().mockResolvedValue({ rows: duplicated, rowCount: duplicated.length }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    const input = smithsonianFindRelated.input.parse({ id: 'nasm_TEST001', limit: 20 });
    const result = await smithsonianFindRelated.handler(input, ctx);

    const ids = result.related.map((r) => r.record_id);
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });

  it('caps results at the limit', async () => {
    const anchorRaw = makeAnchorRaw();
    // 15 distinct related objects
    const manyRelated: ObjectSummary[] = Array.from({ length: 15 }, (_, i) => ({
      record_id: `nasm_MANY${i + 1}`,
      title: `Many ${i + 1}`,
      unit_code: 'NASM',
      museum_name: 'National Air and Space Museum',
      is_cc0: true,
      has_media: false,
    }));
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue(anchorRaw),
      toSummary: vi.fn().mockReturnValue({
        record_id: 'nasm_TEST001',
        title: 'Anchor',
        unit_code: 'NASM',
        museum_name: 'National Air and Space Museum',
        is_cc0: true,
        has_media: false,
      }),
      search: vi.fn().mockResolvedValue({ rows: manyRelated, rowCount: 15 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    const input = smithsonianFindRelated.input.parse({ id: 'nasm_TEST001', limit: 5 });
    const result = await smithsonianFindRelated.handler(input, ctx);

    expect(result.related.length).toBeLessThanOrEqual(5);
  });

  it('interleaves fan-out signals so each contributes before any backfills', async () => {
    // Setup: anchor has culture + maker + topic signals.
    // Each fan-out returns distinct non-overlapping results.
    const anchorRaw = makeAnchorRaw();
    const anchorSummary = {
      record_id: 'nasm_TEST001',
      title: 'Anchor',
      unit_code: 'NASM',
      museum_name: 'National Air and Space Museum',
      is_cc0: true,
      has_media: true,
    };

    // Build distinct result sets per signal
    const cultureResults: ObjectSummary[] = Array.from({ length: 5 }, (_, i) => ({
      record_id: `culture_${i + 1}`,
      title: `Culture Object ${i + 1}`,
      unit_code: 'NMAI',
      museum_name: 'National Museum of the American Indian',
      is_cc0: true,
      has_media: false,
    }));
    const makerResults: ObjectSummary[] = Array.from({ length: 5 }, (_, i) => ({
      record_id: `maker_${i + 1}`,
      title: `Maker Object ${i + 1}`,
      unit_code: 'NMAH',
      museum_name: 'National Museum of American History',
      is_cc0: false,
      has_media: true,
    }));
    const topicResults: ObjectSummary[] = Array.from({ length: 5 }, (_, i) => ({
      record_id: `topic_${i + 1}`,
      title: `Topic Object ${i + 1}`,
      unit_code: 'NMNH',
      museum_name: 'National Museum of Natural History',
      is_cc0: true,
      has_media: true,
    }));

    // Each search call returns a different result set based on call order
    const searchFn = vi
      .fn()
      .mockResolvedValueOnce({ rows: cultureResults, rowCount: 5 })
      .mockResolvedValueOnce({ rows: makerResults, rowCount: 5 })
      .mockResolvedValueOnce({ rows: topicResults, rowCount: 5 })
      .mockResolvedValue({ rows: [], rowCount: 0 });

    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue(anchorRaw),
      toSummary: vi.fn().mockReturnValue(anchorSummary),
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    // Limit to 6 — with round-robin we expect 2 from each signal (culture, maker, topic)
    const input = smithsonianFindRelated.input.parse({ id: 'nasm_TEST001', limit: 6 });
    const result = await smithsonianFindRelated.handler(input, ctx);

    expect(result.related.length).toBe(6);

    // Verify each signal contributes at least one result
    const signalsRepresented = new Set(result.related.flatMap((r) => r.similarity_signals));
    expect(signalsRepresented.has('culture: American')).toBe(true);
    expect(signalsRepresented.has('maker: Lockheed')).toBe(true);
    expect(signalsRepresented.has('topic: Aviation')).toBe(true);
  });

  it('returns empty related array when all fan-out searches return only the anchor or no hits', async () => {
    // Design spec: "Returns up to 20 related objects ... empty when no related objects were found."
    // If every fan-out search result only contains the anchor ID (already in seen set),
    // the deduplicated result must be an empty array — not an error.
    const anchorRaw = makeAnchorRaw();
    const anchorSummary = {
      record_id: 'nasm_TEST001',
      title: 'Anchor Object',
      unit_code: 'NASM',
      museum_name: 'National Air and Space Museum',
      is_cc0: true,
      has_media: true,
    };
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue(anchorRaw),
      toSummary: vi.fn().mockReturnValue(anchorSummary),
      // Every search returns only the anchor itself — all deduplicated away
      search: vi.fn().mockResolvedValue({
        rows: [{ ...anchorSummary }],
        rowCount: 1,
      }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    const input = smithsonianFindRelated.input.parse({ id: 'nasm_TEST001' });
    const result = await smithsonianFindRelated.handler(input, ctx);

    // Must not throw — empty related is a valid outcome, not an error
    expect(result.related).toHaveLength(0);
    expect(result.anchor.record_id).toBe('nasm_TEST001');
    expect(result.search_signals_used.length).toBeGreaterThan(0);
  });

  it('non-truncated result validates against the effective output schema (issue #13)', async () => {
    // Few related, high limit → related.length >= totalCandidates, so no
    // truncation enrichment is written. The framework validates
    // output.extend(enrichment); required-but-unpopulated enrichment fields
    // (the pre-fix contract) threw on this path.
    const anchorRaw = makeAnchorRaw();
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue(anchorRaw),
      toSummary: vi.fn().mockReturnValue({
        record_id: 'nasm_TEST001',
        title: 'Anchor Object',
        unit_code: 'NASM',
        museum_name: 'National Air and Space Museum',
        is_cc0: true,
        has_media: true,
      }),
      search: vi.fn().mockResolvedValue({ rows: makeRelatedRows(), rowCount: 2 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    const input = smithsonianFindRelated.input.parse({ id: 'nasm_TEST001', limit: 20 });
    const result = await smithsonianFindRelated.handler(input, ctx);

    const effectiveOutput = smithsonianFindRelated.output.extend(
      smithsonianFindRelated.enrichment!,
    );
    expect(() => effectiveOutput.parse(result)).not.toThrow();
  });

  it('accumulates every similarity signal when an object surfaces under distinct fan-out signals (issue #19)', async () => {
    // Same record_id is returned by the culture fan-out AND the topic fan-out.
    // The merged entry must carry BOTH signals, deduped to one related object.
    const anchorRaw = makeAnchorRaw();
    const shared: ObjectSummary = {
      record_id: 'nmai_SHARED',
      title: 'Shared Object',
      unit_code: 'NMAI',
      museum_name: 'National Museum of the American Indian',
      is_cc0: true,
      has_media: true,
    };
    // Fan-out order for this anchor: culture, maker, topic, period+type.
    const searchFn = vi
      .fn()
      .mockResolvedValueOnce({ rows: [shared], rowCount: 1 }) // culture: American
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // maker: Lockheed
      .mockResolvedValueOnce({ rows: [shared], rowCount: 1 }) // topic: Aviation
      .mockResolvedValue({ rows: [], rowCount: 0 }); // period + type
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue(anchorRaw),
      toSummary: vi.fn().mockReturnValue({
        record_id: 'nasm_TEST001',
        title: 'Anchor',
        unit_code: 'NASM',
        museum_name: 'National Air and Space Museum',
        is_cc0: true,
        has_media: true,
      }),
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    const input = smithsonianFindRelated.input.parse({ id: 'nasm_TEST001', limit: 20 });
    const result = await smithsonianFindRelated.handler(input, ctx);

    const sharedEntries = result.related.filter((r) => r.record_id === 'nmai_SHARED');
    expect(sharedEntries).toHaveLength(1); // deduped to a single related object
    const signals = sharedEntries[0]?.similarity_signals ?? [];
    expect(signals).toContain('culture: American');
    expect(signals).toContain('topic: Aviation');
  });

  it('fetches each fan-out from the top with a page-covering row count, not the raw start (issue #18)', async () => {
    // start offsets the MERGED interleave, not the upstream query. Every fan-out must
    // fetch from row 0 with enough rows to cover start+limit (capped at MAX_FETCH_PER_SIGNAL),
    // so the fetched-but-unshown candidates the merge skips are never permanently dropped.
    const anchorRaw = makeAnchorRaw();
    const searchFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue(anchorRaw),
      toSummary: vi.fn().mockReturnValue({
        record_id: 'nasm_TEST001',
        title: 'Anchor',
        unit_code: 'NASM',
        museum_name: 'National Air and Space Museum',
        is_cc0: true,
        has_media: true,
      }),
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    const input = smithsonianFindRelated.input.parse({ id: 'nasm_TEST001', limit: 20, start: 10 });
    await smithsonianFindRelated.handler(input, ctx);

    expect(searchFn).toHaveBeenCalled();
    // start:0 with rows = start + limit = 30 (one chunk, below the 1000 per-call ceiling).
    for (const call of searchFn.mock.calls) {
      expect(call[0]).toMatchObject({ start: 0, rows: 30 });
    }
  });

  it('issues a single chunk-of-one call per signal for a shallow default request (issue #18)', async () => {
    // The default (start:0, limit:10) targets a depth of 10 — well under one upstream
    // chunk — so the chunked fetch must collapse to exactly the prior single call per
    // signal: rows:10, start:0, no wave-2. This pins the common path byte-identical to
    // the pre-fix behavior.
    const anchorRaw = makeAnchorRaw();
    const searchFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue(anchorRaw),
      toSummary: vi.fn().mockReturnValue({
        record_id: 'nasm_TEST001',
        title: 'Anchor',
        unit_code: 'NASM',
        museum_name: 'National Air and Space Museum',
        is_cc0: true,
        has_media: true,
      }),
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    // makeAnchorRaw drives four fan-outs (culture, maker, topic, period+type).
    const input = smithsonianFindRelated.input.parse({ id: 'nasm_TEST001' });
    await smithsonianFindRelated.handler(input, ctx);

    // Exactly one call per fan-out — no chunking round-trips on a shallow request.
    expect(searchFn).toHaveBeenCalledTimes(4);
    for (const call of searchFn.mock.calls) {
      expect(call[0]).toMatchObject({ start: 0, rows: 10 });
    }
  });

  it('reaches a deep page past the old 100-row per-signal wall (issue #18)', async () => {
    // Regression for the reopened gap: with MAX_FETCH_PER_SIGNAL = 100 a single signal
    // could reach at most ~100 candidates, so start:300 returned []. The chunked fetch
    // targets start+limit rows from the top, so start:300 must return real, contiguous
    // results.
    const anchorRaw = makeAnchorRaw();
    const fullSeq: ObjectSummary[] = Array.from({ length: 400 }, (_, i) => ({
      record_id: `culture_${i + 1}`,
      title: `Culture Object ${i + 1}`,
      unit_code: 'NMAI',
      museum_name: 'National Museum of the American Indian',
      is_cc0: true,
      has_media: false,
    }));
    // Only the culture fan-out yields rows; upstream returns a stable top-`rows` prefix
    // from start:0 (the deep fetch never offsets the upstream query for depths ≤ 1 chunk).
    const searchFn = vi
      .fn()
      .mockImplementation((params: { rows: number; start: number; filters?: string[] }) =>
        Promise.resolve(
          params.filters?.some((f) => f.startsWith('culture:'))
            ? {
                rows: fullSeq.slice(params.start, params.start + params.rows),
                rowCount: fullSeq.length,
              }
            : { rows: [], rowCount: 0 },
        ),
      );
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue(anchorRaw),
      toSummary: vi.fn().mockReturnValue({
        record_id: 'nasm_TEST001',
        title: 'Anchor',
        unit_code: 'NASM',
        museum_name: 'National Museum of the American Indian',
        is_cc0: true,
        has_media: false,
      }),
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    const deep = await smithsonianFindRelated.handler(
      smithsonianFindRelated.input.parse({ id: 'nasm_TEST001', limit: 20, start: 300 }),
      ctx,
    );
    const next = await smithsonianFindRelated.handler(
      smithsonianFindRelated.input.parse({ id: 'nasm_TEST001', limit: 20, start: 320 }),
      ctx,
    );

    const deepIds = deep.related.map((r) => r.record_id);
    const nextIds = next.related.map((r) => r.record_id);
    // Real results past row 300 — not the pre-fix empty page.
    expect(deepIds).toEqual(Array.from({ length: 20 }, (_, i) => `culture_${i + 301}`));
    // Advancing continues contiguously, gap-free.
    expect(nextIds).toEqual(Array.from({ length: 20 }, (_, i) => `culture_${i + 321}`));
    expect([...deepIds, ...nextIds]).toEqual(
      Array.from({ length: 40 }, (_, i) => `culture_${i + 301}`),
    );
  });

  it('splits a deep fetch into ≤1000-row chunks and concatenates in order (issue #18)', async () => {
    // A signal with more than 1000 upstream matches, paged deep enough that neededDepth
    // exceeds one chunk (start:1000 + limit:20 = 1020 > 1000), must fetch wave 1 at
    // start:0 and a parallel wave 2 at start:1000, concatenated in ascending order — a
    // single call requesting >1000 rows would silently collapse upstream.
    const anchorRaw = makeAnchorRaw();
    const fullSeq: ObjectSummary[] = Array.from({ length: 1500 }, (_, i) => ({
      record_id: `culture_${i + 1}`,
      title: `Culture Object ${i + 1}`,
      unit_code: 'NMAI',
      museum_name: 'National Museum of the American Indian',
      is_cc0: true,
      has_media: false,
    }));
    // Slice by BOTH start and rows so wave 2 (start:1000) returns the correct window.
    const searchFn = vi
      .fn()
      .mockImplementation((params: { rows: number; start: number; filters?: string[] }) =>
        Promise.resolve(
          params.filters?.some((f) => f.startsWith('culture:'))
            ? {
                rows: fullSeq.slice(params.start, params.start + params.rows),
                rowCount: fullSeq.length,
              }
            : { rows: [], rowCount: 0 },
        ),
      );
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue(anchorRaw),
      toSummary: vi.fn().mockReturnValue({
        record_id: 'nasm_TEST001',
        title: 'Anchor',
        unit_code: 'NASM',
        museum_name: 'National Museum of the American Indian',
        is_cc0: false,
        has_media: false,
      }),
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    const result = await smithsonianFindRelated.handler(
      smithsonianFindRelated.input.parse({ id: 'nasm_TEST001', limit: 20, start: 1000 }),
      ctx,
    );

    // The page at start:1000 is the deep window, concatenated in order across the chunk seam.
    const ids = result.related.map((r) => r.record_id);
    expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => `culture_${i + 1001}`));

    // The culture signal was fetched in two chunks: wave 1 (start:0, rows:1000) then
    // wave 2 (start:1000, rows:20). Both start values were requested; the >1000-row
    // single call was never issued.
    const cultureCalls = searchFn.mock.calls
      .map((c) => c[0] as { start: number; rows: number; filters?: string[] })
      .filter((p) => p.filters?.some((f) => f.startsWith('culture:')));
    expect(cultureCalls.map((p) => p.start)).toEqual([0, 1000]);
    expect(cultureCalls.find((p) => p.start === 0)?.rows).toBe(1000);
    expect(cultureCalls.find((p) => p.start === 1000)?.rows).toBe(20);
    for (const p of cultureCalls) {
      expect(p.rows).toBeLessThanOrEqual(1000);
    }
  });

  it('caps truncationCeiling at the per-signal reach when a signal exceeds it (issue #18)', async () => {
    // A signal reporting more upstream matches than MAX_FETCH_PER_SIGNAL (5000) can only
    // ever surface the first 5000 through paging, so the disclosed ceiling must be the
    // capped reach (5000), not the raw upstream count — the ceiling stays equal to a
    // position start can actually reach. truncated stays true (more remains upstream).
    const anchorRaw = makeAnchorRaw();
    const cultureRows: ObjectSummary[] = Array.from({ length: 20 }, (_, i) => ({
      record_id: `culture_${i + 1}`,
      title: `Culture Object ${i + 1}`,
      unit_code: 'NMAI',
      museum_name: 'National Museum of the American Indian',
      is_cc0: true,
      has_media: false,
    }));
    const searchFn = vi.fn().mockImplementation((params: { filters?: string[] }) =>
      Promise.resolve(
        params.filters?.some((f) => f.startsWith('culture:'))
          ? { rows: cultureRows, rowCount: 8000 } // far more upstream than the 5000 reach
          : { rows: [], rowCount: 0 },
      ),
    );
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue(anchorRaw),
      toSummary: vi.fn().mockReturnValue({
        record_id: 'nasm_TEST001',
        title: 'Anchor',
        unit_code: 'NASM',
        museum_name: 'National Museum of the American Indian',
        is_cc0: true,
        has_media: false,
      }),
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    const input = smithsonianFindRelated.input.parse({ id: 'nasm_TEST001', limit: 20 });
    const result = await smithsonianFindRelated.handler(input, ctx);

    expect(result.related).toHaveLength(20);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    // Capped reach (5000), NOT the raw 8000 upstream count.
    expect(enrichment.truncationCeiling).toBe(5000);
  });

  it('surfaces truncationCeiling from upstream rowCount when a signal has more upstream (issue #18)', async () => {
    // Culture fan-out returns a full fetched page (20 rows at limit 20) but reports 215
    // total upstream — the disclosure must fire because more matches remain past the
    // fetch, and truncationCeiling must reflect the summed upstream count.
    const anchorRaw = makeAnchorRaw();
    const cultureRows: ObjectSummary[] = Array.from({ length: 20 }, (_, i) => ({
      record_id: `culture_${i + 1}`,
      title: `Culture Object ${i + 1}`,
      unit_code: 'NMAI',
      museum_name: 'National Museum of the American Indian',
      is_cc0: true,
      has_media: false,
    }));
    const searchFn = vi
      .fn()
      .mockResolvedValueOnce({ rows: cultureRows, rowCount: 215 }) // culture — more upstream
      .mockResolvedValue({ rows: [], rowCount: 0 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue(anchorRaw),
      toSummary: vi.fn().mockReturnValue({
        record_id: 'nasm_TEST001',
        title: 'Anchor',
        unit_code: 'NASM',
        museum_name: 'National Air and Space Museum',
        is_cc0: true,
        has_media: true,
      }),
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    const input = smithsonianFindRelated.input.parse({ id: 'nasm_TEST001', limit: 20 });
    const result = await smithsonianFindRelated.handler(input, ctx);

    expect(result.related).toHaveLength(20);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(20);
    expect(enrichment.truncationCeiling).toBe(215);
  });

  it('does not report truncated when a page lands on the exact end of the interleaved sequence (issue #18 regression)', async () => {
    // A single signal has exactly 15 related objects, all fetched (rowCount 15). Paging
    // to start=10 with limit=5 returns the last 5 (merged indices 10-14) — the exact
    // tail. Nothing more is interleaved or fetchable upstream, so truncated must NOT
    // fire. The check compares rowCount to the requested fetch size (not the page-local
    // count), so a trailing page that lands on the end doesn't false-positive.
    const anchorRaw = makeAnchorRaw();
    const fullRows: ObjectSummary[] = Array.from({ length: 15 }, (_, i) => ({
      record_id: `culture_${i + 1}`,
      title: `Culture Object ${i + 1}`,
      unit_code: 'NMAI',
      museum_name: 'National Museum of the American Indian',
      is_cc0: true,
      has_media: false,
    }));
    // Model upstream: only the culture fan-out yields rows, returning a stable top-N
    // prefix from start:0 (rowCount is the full 15 — everything is fetchable).
    const searchFn = vi
      .fn()
      .mockImplementation((params: { rows: number; filters?: string[] }) =>
        Promise.resolve(
          params.filters?.some((f) => f.startsWith('culture:'))
            ? { rows: fullRows.slice(0, params.rows), rowCount: fullRows.length }
            : { rows: [], rowCount: 0 },
        ),
      );
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue(anchorRaw),
      toSummary: vi.fn().mockReturnValue({
        record_id: 'nasm_TEST001',
        title: 'Anchor',
        unit_code: 'NASM',
        museum_name: 'National Air and Space Museum',
        is_cc0: true,
        has_media: true,
      }),
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    const input = smithsonianFindRelated.input.parse({ id: 'nasm_TEST001', limit: 5, start: 10 });
    const result = await smithsonianFindRelated.handler(input, ctx);

    expect(result.related).toHaveLength(5);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBeUndefined();
  });

  it('reconstructs the full sequence — page(start:0) ++ page(start:L) equals page(start:0, limit:2L) (issue #18)', async () => {
    // The load-bearing correctness proof: paging must be gap-free AND overlap-free, so
    // concatenating two half-limit pages must equal one double-limit page fetched from
    // the top — a "distinct next page" check alone passes even when a gap silently drops
    // objects. A single signal exposes a stable ordered sequence upstream; each fan-out
    // fetches from start:0 (the offset is applied to the merged interleave).
    const anchorRaw = makeAnchorRaw();
    const fullSeq: ObjectSummary[] = Array.from({ length: 30 }, (_, i) => ({
      record_id: `culture_${i + 1}`,
      title: `Culture Object ${i + 1}`,
      unit_code: 'NMAI',
      museum_name: 'National Museum of the American Indian',
      is_cc0: true,
      has_media: false,
    }));
    // Only the culture fan-out yields rows; upstream returns a stable top-`rows` prefix
    // from row 0, exactly as the real API does when queried with start:0.
    const searchFn = vi
      .fn()
      .mockImplementation((params: { rows: number; filters?: string[] }) =>
        Promise.resolve(
          params.filters?.some((f) => f.startsWith('culture:'))
            ? { rows: fullSeq.slice(0, params.rows), rowCount: fullSeq.length }
            : { rows: [], rowCount: 0 },
        ),
      );
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue(anchorRaw),
      toSummary: vi.fn().mockReturnValue({
        record_id: 'nasm_TEST001',
        title: 'Anchor',
        unit_code: 'NASM',
        museum_name: 'National Air and Space Museum',
        is_cc0: true,
        has_media: true,
      }),
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    const first = await smithsonianFindRelated.handler(
      smithsonianFindRelated.input.parse({ id: 'nasm_TEST001', limit: 10 }),
      ctx,
    );
    const second = await smithsonianFindRelated.handler(
      smithsonianFindRelated.input.parse({ id: 'nasm_TEST001', limit: 10, start: 10 }),
      ctx,
    );
    const full = await smithsonianFindRelated.handler(
      smithsonianFindRelated.input.parse({ id: 'nasm_TEST001', limit: 20 }),
      ctx,
    );

    const firstIds = first.related.map((r) => r.record_id);
    const secondIds = second.related.map((r) => r.record_id);
    const fullIds = full.related.map((r) => r.record_id);
    // Page 1 is the first 10 of the interleaved sequence; page 2 is the next 10.
    expect(firstIds).toEqual(Array.from({ length: 10 }, (_, i) => `culture_${i + 1}`));
    expect(secondIds).toEqual(Array.from({ length: 10 }, (_, i) => `culture_${i + 11}`));
    // Reconstruction: the two half pages concatenate to exactly the one double page —
    // proves no gap and no overlap at the seam, byte-identical by record_id sequence.
    expect([...firstIds, ...secondIds]).toEqual(fullIds);
    // Every fan-out fetched from the top; start never leaked into the upstream query.
    for (const call of searchFn.mock.calls) {
      expect(call[0].start).toBe(0);
    }
  });

  it('format renders anchor, related record_ids, and similarity signals', () => {
    const output = {
      anchor: { record_id: 'nasm_TEST001', title: 'Anchor Object', unit_code: 'NASM' },
      related: [
        {
          record_id: 'nasm_RELATED001',
          title: 'Related 1',
          unit_code: 'NASM',
          museum_name: 'National Air and Space Museum',
          is_cc0: true,
          similarity_signals: ['culture: American', 'period: 1960s'],
        },
      ],
      search_signals_used: ['culture: American', 'maker: Lockheed'],
    };
    const blocks = smithsonianFindRelated.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('nasm_TEST001');
    expect(text).toContain('nasm_RELATED001');
    expect(text).toContain('culture: American');
    expect(text).toContain('maker: Lockheed');
  });

  it('format renders cleanly when related is empty', () => {
    const output = {
      anchor: { record_id: 'nasm_TEST001', title: 'Anchor Object', unit_code: 'NASM' },
      related: [],
      search_signals_used: ['culture: American'],
    };
    const blocks = smithsonianFindRelated.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('nasm_TEST001');
    expect(text).toContain('0'); // related count
    expect(blocks).toHaveLength(1);
  });
});
