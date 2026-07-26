/**
 * @fileoverview Tests for smithsonian_find_related tool.
 * @module tests/mcp-server/tools/definitions/smithsonian-find-related.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
import {
  createInMemoryStorage,
  createMockContext,
  getEnrichment,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { smithsonianFindRelated } from '@/mcp-server/tools/definitions/smithsonian-find-related.tool.js';
import { smithsonianSearchObjects } from '@/mcp-server/tools/definitions/smithsonian-search-objects.tool.js';
import * as svcModule from '@/services/smithsonian/smithsonian-service.js';
import type { ObjectSummary, RawEDAN, RawIndexedName } from '@/services/smithsonian/types.js';

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

  it('propagates not_found with reason and recovery from the service (issues #10, #25)', async () => {
    // find_related fetches the anchor via getContent; the stand-in mirrors the real
    // service throw site, resolving the recovery from the ctx the tool handed it.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn((_id: string, svcCtx: Context) =>
        Promise.reject(
          notFound('No Smithsonian object found for ID "nasm_GONE".', {
            recordId: 'nasm_GONE',
            reason: 'not_found',
            ...svcCtx.recoveryFor('not_found'),
          }),
        ),
      ),
      toSummary: vi.fn(),
      search: vi.fn(),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    const input = smithsonianFindRelated.input.parse({ id: 'nasm_GONE' });
    const expectedHint = smithsonianFindRelated.errors?.find(
      (e) => e.reason === 'not_found',
    )?.recovery;
    await expect(smithsonianFindRelated.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found', recovery: { hint: expectedHint } },
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
    expect(signalsRepresented.has('manufacturer: Lockheed')).toBe(true);
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
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // manufacturer: Lockheed
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

  it('discloses each fan-out signal with its uncapped upstream row_count (issue #18)', async () => {
    // The merged interleave reaches at most MAX_FETCH_PER_SIGNAL (5000) rows per
    // signal, so a broad signal has matches no `start` on this tool can retrieve.
    // row_count is the uncapped truth; truncationCeiling stays the capped reach, and
    // the two must be allowed to disagree.
    const anchorRaw = makeAnchorRaw();
    // Every fan-out returns a distinct row so all four become contributing buckets —
    // the ceiling sums only buckets that surfaced candidates.
    const row = (id: string): ObjectSummary => ({
      record_id: id,
      title: id,
      unit_code: 'NMAI',
      museum_name: 'National Museum of the American Indian',
      is_cc0: true,
      has_media: false,
    });
    const searchFn = vi.fn().mockImplementation((params: { query: string; filters?: string[] }) => {
      if (params.filters?.some((f) => f.startsWith('culture:')))
        return Promise.resolve({ rows: [row('culture_1')], rowCount: 14662 });
      if (params.query === 'Lockheed')
        return Promise.resolve({ rows: [row('maker_1')], rowCount: 199 });
      if (params.filters?.some((f) => f.startsWith('topic:')))
        return Promise.resolve({ rows: [row('topic_1')], rowCount: 63 });
      return Promise.resolve({ rows: [row('period_1')], rowCount: 12 });
    });
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

    expect(result.signals.map((s) => s.signal)).toEqual(result.search_signals_used);
    expect(result.signals.map((s) => s.row_count)).toEqual([14662, 199, 63, 12]);
    // The ceiling caps each signal at the 5,000 reach; row_count does not.
    expect(getEnrichment(ctx).truncationCeiling).toBe(5000 + 199 + 63 + 12);
    expect(result.signals[0]?.row_count).toBeGreaterThan(5000);
  });

  it('signal continuations reproduce each fan-out as smithsonian_search_objects input (issue #18)', async () => {
    // Every fan-out query has a 1:1 equivalent in smithsonian_search_objects's query/filters
    // shape — the retrieval path past this tool's per-signal reach. Each of the four
    // signal kinds maps differently, so all four are pinned.
    const anchorRaw = makeAnchorRaw();
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
      search: vi.fn().mockResolvedValue({ rows: [], rowCount: 7 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    const input = smithsonianFindRelated.input.parse({ id: 'nasm_TEST001' });
    const result = await smithsonianFindRelated.handler(input, ctx);

    const bySignal = new Map(result.signals.map((s) => [s.signal, s.search_continuation]));
    // culture is a filter-only signal: no free text, one structured filter.
    expect(bySignal.get('culture: American')).toEqual({
      query: '',
      filters: { culture: 'American' },
    });
    // A freetext-sourced named party stays a plain free-text query with no filters,
    // labeled from the entry's own label rather than a hardcoded "maker" (issue #43).
    expect(bySignal.get('manufacturer: Lockheed')).toEqual({ query: 'Lockheed' });
    // topic is an indexed facet, so its fan-out is a filter, not free text (issue #44).
    expect(bySignal.get('topic: Aviation')).toEqual({
      query: '',
      filters: { topic: 'Aviation' },
    });
    // period+type carries both constraints structurally.
    expect(bySignal.get('period: 1960s, type: Aircraft')).toEqual({
      query: '',
      filters: { date: '1960s', object_type: 'Aircraft' },
    });
  });

  it.each([['1000-1099'], ['-2500'], ['BCE 1000s'], ['21st century']])(
    'carries the non-decade period %s structurally in the continuation (issue #36)',
    async (period) => {
      // The `date` filter accepts any indexed date term, so the continuation is the
      // same structured shape whatever the term looks like — no raw-Lucene fallback.
      const anchorRaw = makeAnchorRaw();
      anchorRaw.content!.indexedStructured!.date = [period];
      const searchFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
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
      const result = await smithsonianFindRelated.handler(
        smithsonianFindRelated.input.parse({ id: 'nasm_TEST001' }),
        ctx,
      );

      const periodSignal = result.signals.find((s) => s.signal.startsWith('period:'));
      expect(periodSignal?.search_continuation).toEqual({
        query: '',
        filters: { date: period, object_type: 'Aircraft' },
      });
      // The continuation must reproduce the fan-out's own upstream call, so the
      // fan-out quotes the date term exactly as the sibling tool would — always,
      // not only when the term contains a space (issue #42).
      const fanOutFilters = searchFn.mock.calls
        .map((call) => (call[0] as { filters: string[] }).filters)
        .find((filters) => filters.some((f) => f.startsWith('date:')));
      expect(fanOutFilters).toContain(`date:"${period}"`);
      // The whole continuation must parse as smithsonian_search_objects input.
      expect(() =>
        smithsonianSearchObjects.input.parse(periodSignal?.search_continuation),
      ).not.toThrow();
    },
  );

  it('every signal continuation parses as smithsonian_search_objects input (issue #18)', async () => {
    // The disclosure is only useful if the sibling tool accepts it verbatim.
    const anchorRaw = makeAnchorRaw();
    anchorRaw.content!.indexedStructured!.culture = ['Plains Indian'];
    anchorRaw.content!.indexedStructured!.object_type = ['Crewed spacecraft'];
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
      search: vi.fn().mockResolvedValue({ rows: [], rowCount: 3 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    const result = await smithsonianFindRelated.handler(
      smithsonianFindRelated.input.parse({ id: 'nasm_TEST001' }),
      ctx,
    );

    expect(result.signals.length).toBeGreaterThan(0);
    for (const s of result.signals) {
      expect(() => smithsonianSearchObjects.input.parse(s.search_continuation)).not.toThrow();
    }
  });

  it('omits a fan-out whose upstream call failed from signals[] (issue #18)', async () => {
    // A rejected fan-out contributed nothing and has no known row count — disclosing
    // it as zero would understate the signal rather than admit it is unknown.
    const anchorRaw = makeAnchorRaw();
    const searchFn = vi
      .fn()
      .mockImplementation((params: { filters?: string[] }) =>
        params.filters?.some((f) => f.startsWith('culture:'))
          ? Promise.reject(new Error('upstream 503'))
          : Promise.resolve({ rows: [], rowCount: 11 }),
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
    const result = await smithsonianFindRelated.handler(
      smithsonianFindRelated.input.parse({ id: 'nasm_TEST001' }),
      ctx,
    );

    expect(result.signals.map((s) => s.signal)).not.toContain('culture: American');
    expect(result.signals.map((s) => s.signal)).toContain('manufacturer: Lockheed');
    // search_signals_used still lists every fan-out attempted.
    expect(result.search_signals_used).toContain('culture: American');
  });

  it('truncation guidance names start and the signal continuation, and survives the enrichment schema (issue #23)', async () => {
    // Two-tier continuation: start pages the merged interleave, signals[] is the only
    // path past a signal's reach. Pre-fix, no `notice` field was declared, so the
    // notice ctx.enrich.truncated() always writes was stripped off the wire entirely.
    const anchorRaw = makeAnchorRaw();
    const cultureRows: ObjectSummary[] = Array.from({ length: 20 }, (_, i) => ({
      record_id: `culture_${i + 1}`,
      title: `Culture Object ${i + 1}`,
      unit_code: 'NMAI',
      museum_name: 'National Museum of the American Indian',
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
        has_media: true,
      }),
      search: vi
        .fn()
        .mockImplementation((params: { filters?: string[] }) =>
          Promise.resolve(
            params.filters?.some((f) => f.startsWith('culture:'))
              ? { rows: cultureRows, rowCount: 14662 }
              : { rows: [], rowCount: 0 },
          ),
        ),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    const result = await smithsonianFindRelated.handler(
      smithsonianFindRelated.input.parse({ id: 'nasm_TEST001', limit: 20 }),
      ctx,
    );

    const effectiveOutput = smithsonianFindRelated.output.extend(
      smithsonianFindRelated.enrichment!,
    );
    const onTheWire = effectiveOutput.parse({ ...result, ...getEnrichment(ctx) });
    expect(onTheWire.notice).toContain('start');
    expect(onTheWire.notice).toContain('search_continuation');
    expect(onTheWire.notice).not.toBe(
      'Results capped at 20; showing 20. Raise the cap or narrow with filters.',
    );
  });

  describe('named-party signal (issue #43)', () => {
    /**
     * Run the handler against an anchor whose name blocks are set by the caller, and
     * hand back the resulting signals plus every upstream call the fan-out issued.
     * The service is stubbed to a fixed empty result so only signal construction is
     * under test.
     */
    async function signalsFor(anchor: {
      culture?: string[];
      indexedNames?: RawIndexedName[];
      freetextNames?: Array<{ label?: string; content?: string }>;
    }) {
      const anchorRaw = makeAnchorRaw();
      if (anchor.culture) anchorRaw.content!.indexedStructured!.culture = anchor.culture;
      if (anchor.indexedNames) anchorRaw.content!.indexedStructured!.name = anchor.indexedNames;
      anchorRaw.content!.freetext!.name = anchor.freetextNames ?? [];
      const searchFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 4 });
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
      const result = await smithsonianFindRelated.handler(
        smithsonianFindRelated.input.parse({ id: 'nasm_TEST001' }),
        ctx,
      );
      return {
        result,
        calls: searchFn.mock.calls.map((c) => c[0] as { query: string; filters: string[] }),
      };
    }

    it.each([
      ['Collector', 'collector: Krieger, Herbert W.'],
      ['Donor Name', 'donor name: Smithsonian Institution'],
      ['issuing authority', 'issuing authority: United States Post Office'],
    ])('labels a %s entry from its own label, never as a maker', async (label, expected) => {
      // EDAN uses freetext.name for any named party — a collector, a donor, an issuing
      // authority — and maker is a minority of them. The hardcoded label asserted a
      // maker relationship the catalog never claimed.
      const value = expected.slice(expected.indexOf(': ') + 2);
      const { result } = await signalsFor({ freetextNames: [{ label, content: value }] });

      expect(result.search_signals_used).toContain(expected);
      expect(result.search_signals_used.some((s) => s.startsWith('maker:'))).toBe(false);
    });

    it('skips a first entry that duplicates the culture filter and takes the next distinct one', async () => {
      // The NMAI_230201 shape, minus the indexed name: freetext.name[0] is the
      // Culture/People entry, whose value the culture fan-out already runs as a hard
      // filter. Re-running it as free text spends a slot on a duplicate and presents
      // the culture as a named party.
      const donor = 'Major J. A. L. Möller (Jacob A.L. Möller/Monty Möller), Non-Indian, 1883-1957';
      const { result, calls } = await signalsFor({
        culture: ['Dene (Northern Athabascan)'],
        freetextNames: [
          { label: 'Culture/People', content: 'Dene (Northern Athabascan)' },
          { label: 'Previous owner', content: donor },
          { label: 'Donor', content: donor },
        ],
      });

      expect(result.search_signals_used).toContain('culture: Dene (Northern Athabascan)');
      expect(result.search_signals_used).toContain(`previous owner: ${donor}`);
      // The pre-fix output: the culture value relabeled as a maker and re-run as free
      // text, matching 1,604 records against the culture filter's 194.
      expect(result.search_signals_used).not.toContain('maker: Dene (Northern Athabascan)');
      expect(calls.some((c) => c.query === 'Dene (Northern Athabascan)')).toBe(false);
    });

    it('leaves the slot unused when every candidate duplicates the culture filter', async () => {
      // Nothing distinct is left to fan out on, so the signal is dropped rather than
      // emitted as a redundant restatement of the culture filter.
      const { result } = await signalsFor({
        culture: ['Dene (Northern Athabascan)'],
        freetextNames: [
          { label: 'Culture/People', content: 'Dene (Northern Athabascan)' },
          { label: 'Associated Name', content: 'Dene (Northern Athabascan)' },
        ],
      });

      expect(result.search_signals_used).toEqual([
        'culture: Dene (Northern Athabascan)',
        'topic: Aviation',
        'period: 1960s, type: Aircraft',
      ]);
    });

    it('prefers indexedStructured.name as a hard name: filter over the freetext entries', async () => {
      // The indexed block is the hard-filterable counterpart: name:"Warhol, Andy"
      // matches 421 records against 715 for the same string as free text. It carries no
      // positional correspondence to freetext.name — on NMAI_230201 three freetext
      // entries yield one indexed name drawn from entries [1]/[2] — so it takes the
      // slot outright rather than being paired with any entry.
      const { result, calls } = await signalsFor({
        culture: ['Dene (Northern Athabascan)'],
        indexedNames: ['Möller, Major J. A. L.'],
        freetextNames: [
          { label: 'Culture/People', content: 'Dene (Northern Athabascan)' },
          { label: 'Donor', content: 'Major J. A. L. Möller (…), Non-Indian, 1883-1957' },
        ],
      });

      expect(result.search_signals_used).toContain('name: Möller, Major J. A. L.');
      const nameCall = calls.find((c) => c.filters.some((f) => f.startsWith('name:')));
      expect(nameCall?.filters).toContain('name:"Möller, Major J. A. L."');
      // A hard filter, not a free-text query.
      expect(nameCall?.query).toBe('');
      expect(calls.some((c) => c.query.includes('Möller'))).toBe(false);
    });

    it('reproduces the indexed-name fan-out through filters.name in the continuation', async () => {
      // filters.name exists on smithsonian_search_objects so this fan-out's
      // search_continuation stays exact — the tool's documented invariant — rather
      // than degrading to a free-text query that matches a different set.
      const { result } = await signalsFor({ indexedNames: ['Warhol, Andy'] });

      const nameSignal = result.signals.find((s) => s.signal.startsWith('name:'));
      expect(nameSignal?.search_continuation).toEqual({
        query: '',
        filters: { name: 'Warhol, Andy' },
      });
      expect(() =>
        smithsonianSearchObjects.input.parse(nameSignal?.search_continuation),
      ).not.toThrow();
    });

    it('reads the wrapped form of an indexed name entry', async () => {
      // Bibliographic and authority records index the name as an object carrying the
      // value under `content` — {type:"author"} on Smithsonian Research Online,
      // {VIAF:"…"} on Libraries authority records — rather than as a bare string.
      // Passed through unread, the object reached luceneField and threw
      // `value.replace is not a function`, failing the whole call.
      const { result, calls } = await signalsFor({
        indexedNames: [{ content: 'Mitchell, Stephanie L.' }, { content: 'Schulkin, Jay' }],
      });

      expect(result.search_signals_used).toContain('name: Mitchell, Stephanie L.');
      const nameCall = calls.find((c) => c.filters.some((f) => f.startsWith('name:')));
      expect(nameCall?.filters).toContain('name:"Mitchell, Stephanie L."');
      expect(result.signals.find((s) => s.signal.startsWith('name:'))?.search_continuation).toEqual(
        {
          query: '',
          filters: { name: 'Mitchell, Stephanie L.' },
        },
      );
    });

    it('skips a wrapped indexed name with no content and falls back to the freetext block', async () => {
      const { result } = await signalsFor({
        indexedNames: [{}],
        freetextNames: [{ label: 'Collector', content: 'Krieger, Herbert W.' }],
      });

      expect(result.search_signals_used).toContain('collector: Krieger, Herbert W.');
    });

    it('applies the duplicate check to the indexed name too', async () => {
      const { result } = await signalsFor({
        culture: ['Ainu'],
        indexedNames: ['Ainu'],
        freetextNames: [{ label: 'Culture/People', content: 'Ainu' }],
      });

      expect(result.search_signals_used.some((s) => s.startsWith('name:'))).toBe(false);
      expect(result.search_signals_used).toContain('culture: Ainu');
    });
  });

  it('issues the topic fan-out as a hard topic: filter, not free text (issue #44)', async () => {
    // topic:"Quilts" matches 1,134 objects where the bare word matches 2,677, so the
    // free-text form tagged more than half its results with a topic the catalog never
    // assigned them.
    const anchorRaw = makeAnchorRaw();
    const searchFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 1134 });
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
    await smithsonianFindRelated.handler(
      smithsonianFindRelated.input.parse({ id: 'nasm_TEST001' }),
      ctx,
    );

    const topicCall = searchFn.mock.calls
      .map((c) => c[0] as { query: string; filters: string[] })
      .find((p) => p.filters.some((f) => f.startsWith('topic:')));
    // Always quoted (issue #42) — 80 of the 133,113 topic terms carry a `"`.
    expect(topicCall?.filters).toEqual(['topic:"Aviation"']);
    expect(topicCall?.query).toBe('');
    expect(searchFn.mock.calls.some((c) => (c[0] as { query: string }).query === 'Aviation')).toBe(
      false,
    );
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
      search_signals_used: ['culture: American', 'manufacturer: Lockheed'],
      signals: [
        {
          signal: 'culture: American',
          row_count: 14662,
          search_continuation: { query: '', filters: { culture: 'American' } },
        },
        {
          signal: 'manufacturer: Lockheed',
          row_count: 199,
          search_continuation: { query: 'Lockheed' },
        },
      ],
    };
    const blocks = smithsonianFindRelated.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('nasm_TEST001');
    expect(text).toContain('nasm_RELATED001');
    expect(text).toContain('culture: American');
    expect(text).toContain('manufacturer: Lockheed');
  });

  it('format renders every signal continuation field into content[] (issue #18)', () => {
    // content[]-only clients read format() alone, so the row_count and the exact
    // smithsonian_search_objects arguments must survive the markdown render — a filter key
    // rendered in an exclusive branch would reach structuredContent and nothing else.
    const output = {
      anchor: { record_id: 'nasm_TEST001', title: 'Anchor Object', unit_code: 'NASM' },
      related: [],
      search_signals_used: ['culture: American', 'period: 1960s, type: Aircraft'],
      signals: [
        {
          signal: 'culture: American',
          row_count: 14662,
          search_continuation: { query: '', filters: { culture: 'American' } },
        },
        {
          signal: 'period: 1960s, type: Aircraft',
          row_count: 12,
          search_continuation: {
            query: '',
            filters: { date: '1960s', object_type: 'Aircraft' },
          },
        },
        {
          signal: 'name: Warhol, Andy',
          row_count: 421,
          search_continuation: { query: '', filters: { name: 'Warhol, Andy' } },
        },
        {
          signal: 'topic: Quilts',
          row_count: 1134,
          search_continuation: { query: '', filters: { topic: 'Quilts' } },
        },
      ],
    };
    const text = smithsonianFindRelated.format!(output)
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');
    expect(text).toContain('14662');
    expect(text).toContain('smithsonian_search_objects');
    expect(text).toContain('culture: "American"');
    // Both filter keys of the same continuation render together, not as alternatives.
    expect(text).toContain('date: "1960s"');
    expect(text).toContain('object_type: "Aircraft"');
    // The two filter keys added for issues #43/#44 reach content[] on the same render.
    expect(text).toContain('name: "Warhol, Andy"');
    expect(text).toContain('topic: "Quilts"');
  });

  it('format renders cleanly when related is empty', () => {
    const output = {
      anchor: { record_id: 'nasm_TEST001', title: 'Anchor Object', unit_code: 'NASM' },
      related: [],
      search_signals_used: ['culture: American'],
      signals: [],
    };
    const blocks = smithsonianFindRelated.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('nasm_TEST001');
    expect(text).toContain('0'); // related count
    expect(blocks).toHaveLength(1);
  });

  describe('upstream markup and entities (issue #49)', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    it('decodes both the anchor title and every related title, in output and format()', async () => {
      // The real service over a stubbed fetch, dispatched by endpoint: the anchor
      // arrives through getContent/toSummary and the related rows through search,
      // and both projections must decode.
      vi.stubEnv('SMITHSONIAN_API_KEY', 'test-key-12345');
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
          const anchor = url.includes('/content/');
          const body = anchor
            ? {
                status: 200,
                responseCode: 1,
                response: {
                  id: 'ld1-anchor',
                  title: 'The Sun&#39;s Open Magnetic Flux',
                  unitCode: 'SLA_SRO',
                  url: 'edanmdm:slasro_92924',
                  content: {
                    descriptiveNonRepeating: {
                      record_ID: 'slasro_92924',
                      unit_code: 'SLA_SRO',
                      metadata_usage: { access: 'CC0' },
                    },
                    indexedStructured: { culture: ['American'] },
                  },
                },
              }
            : {
                status: 200,
                responseCode: 1,
                response: {
                  rows: [
                    {
                      id: 'ld1-related',
                      title: 'Pregnant Women&#39;s Concerns Regarding COVID-19',
                      unitCode: 'SLA_SRO',
                      url: 'edanmdm:slasro_171906',
                      content: {
                        descriptiveNonRepeating: {
                          record_ID: 'slasro_171906',
                          unit_code: 'SLA_SRO',
                          metadata_usage: { access: 'CC0' },
                        },
                      },
                    },
                  ],
                  rowCount: 1,
                },
              };
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => body,
            text: async () => JSON.stringify(body),
          });
        }),
      );
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(
        new svcModule.SmithsonianService(createInMemoryStorage()),
      );

      const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
      const input = smithsonianFindRelated.input.parse({ id: 'slasro_92924' });
      const result = await smithsonianFindRelated.handler(input, ctx);

      expect(result.anchor.title).toBe("The Sun's Open Magnetic Flux");
      expect(result.related[0]?.title).toBe("Pregnant Women's Concerns Regarding COVID-19");
      const text = smithsonianFindRelated.format!(result)
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('');
      expect(text).toContain("The Sun's Open Magnetic Flux");
      expect(text).toContain("Pregnant Women's Concerns");
      expect(text).not.toContain('&#39;');
    });
  });
});
