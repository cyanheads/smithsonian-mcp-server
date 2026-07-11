/**
 * @fileoverview Tests for smithsonian_search tool.
 * @module tests/mcp-server/tools/definitions/smithsonian-search.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { smithsonianSearch } from '@/mcp-server/tools/definitions/smithsonian-search.tool.js';
import * as svcModule from '@/services/smithsonian/smithsonian-service.js';
import type { ObjectSummary } from '@/services/smithsonian/types.js';

function makeObjectSummary(id = 'nasm_TEST001'): ObjectSummary {
  return {
    record_id: id,
    title: 'Test Object',
    unit_code: 'NASM',
    museum_name: 'National Air and Space Museum',
    object_type: 'Aircraft',
    date: '1960s',
    thumbnail_url: 'https://ids.si.edu/thumb',
    is_cc0: true,
    has_media: true,
  };
}

describe('smithsonianSearch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns results for a valid query', async () => {
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: [makeObjectSummary()], rowCount: 100 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearch.errors });
    const input = smithsonianSearch.input.parse({ query: 'aircraft' });
    const result = await smithsonianSearch.handler(input, ctx);

    expect(result.objects).toHaveLength(1);
    expect(result.objects[0]?.record_id).toBe('nasm_TEST001');
    expect(result.total_count).toBe(100);
  });

  it('returns up to `rows` objects directly when rows exceeds 20', async () => {
    const many = Array.from({ length: 25 }, (_, i) => makeObjectSummary(`nasm_TEST${i}`));
    const searchFn = vi.fn().mockResolvedValue({ rows: many, rowCount: 5000 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearch.errors });
    const input = smithsonianSearch.input.parse({ query: 'quilt', rows: 25 });
    const result = await smithsonianSearch.handler(input, ctx);

    expect(result.objects).toHaveLength(25);
    expect(searchFn.mock.calls[0]?.[0]).toMatchObject({ rows: 25 });
  });

  it('throws no_results with the declared recovery hint on the wire (issue #14)', async () => {
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearch.errors });
    const input = smithsonianSearch.input.parse({ query: 'xyzzy_no_results_ever' });
    // The declared contract recovery must reach the wire as data.recovery.hint.
    const expectedHint = smithsonianSearch.errors?.find((e) => e.reason === 'no_results')?.recovery;
    await expect(smithsonianSearch.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results', recovery: { hint: expectedHint } },
    });
  });

  it('harvests valid object_type/unit_code terms into the recovery hint on a filtered-zero (issue #15)', async () => {
    // First (filtered) search returns nothing; the unfiltered harvest re-query
    // returns rows whose distinct object_type/unit_code values are named in the hint,
    // turning a 2-hop "call list_terms" recovery into "retry with one of these".
    const harvestRows: ObjectSummary[] = [
      {
        record_id: 'a',
        title: 'A',
        unit_code: 'SIL',
        museum_name: 'Smithsonian Libraries and Archives',
        object_type: 'Books',
        is_cc0: true,
        has_media: false,
      },
      {
        record_id: 'b',
        title: 'B',
        unit_code: 'SIL',
        museum_name: 'Smithsonian Libraries and Archives',
        object_type: 'Manuscripts',
        is_cc0: true,
        has_media: false,
      },
      {
        record_id: 'c',
        title: 'C',
        unit_code: 'NMNH',
        museum_name: 'National Museum of Natural History',
        object_type: 'Books',
        is_cc0: false,
        has_media: false,
      },
    ];
    const searchFn = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: harvestRows, rowCount: harvestRows.length });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearch.errors });
    const input = smithsonianSearch.input.parse({
      query: 'Greek',
      filters: { object_type: 'Painting' },
    });
    const err = await smithsonianSearch.handler(input, ctx).catch((e) => e);

    expect(err.data?.reason).toBe('invalid_filter');
    const hint = err.data?.recovery?.hint as string;
    // Distinct harvested values (deduped) appear in the hint, not just the count.
    expect(hint).toContain('Books');
    expect(hint).toContain('Manuscripts');
    expect(hint).toContain('SIL');
    expect(hint).toContain('NMNH');
    // Exactly one extra re-query, and it drops the failing filters.
    expect(searchFn).toHaveBeenCalledTimes(2);
    expect(searchFn.mock.calls[1]?.[0]).toMatchObject({ query: 'Greek', filters: [] });
  });

  it('falls back to the static contract hint when the harvest re-query is empty (issue #15)', async () => {
    // object_type is harvest-relevant, so the unfiltered re-query runs; when it also
    // returns nothing, the hint degrades to the declared contract recovery — no crash,
    // no empty term list.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearch.errors });
    const input = smithsonianSearch.input.parse({
      query: 'quilt',
      filters: { object_type: 'Painting' },
    });
    const expectedHint = smithsonianSearch.errors?.find(
      (e) => e.reason === 'invalid_filter',
    )?.recovery;
    await expect(smithsonianSearch.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_filter', recovery: { hint: expectedHint } },
    });
  });

  it('falls back to the static contract hint when the harvest re-query throws (issue #15)', async () => {
    // The unfiltered harvest re-query errors — harvesting is best-effort and must
    // not turn the invalid_filter error into a crash; the static hint stands.
    const searchFn = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockRejectedValueOnce(new Error('upstream 503'));
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearch.errors });
    const input = smithsonianSearch.input.parse({
      query: 'quilt',
      filters: { object_type: 'Painting' },
    });
    const expectedHint = smithsonianSearch.errors?.find(
      (e) => e.reason === 'invalid_filter',
    )?.recovery;
    await expect(smithsonianSearch.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_filter', recovery: { hint: expectedHint } },
    });
  });

  it('routes a bad culture filter to smithsonian_list_terms with contains, no harvest re-query (issue #21)', async () => {
    // culture is absent from ObjectSummary, so a result harvest can't resolve it — the
    // hint routes to the vocabulary endpoint with a contains substring, and no
    // unfiltered harvest re-query runs for a routable-only filter.
    const searchFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearch.errors });
    const input = smithsonianSearch.input.parse({
      query: 'sculpture',
      filters: { culture: 'Ancient Greek' },
    });
    const err = await smithsonianSearch.handler(input, ctx).catch((e) => e);

    expect(err.data?.reason).toBe('invalid_filter');
    const hint = err.data?.recovery?.hint as string;
    expect(hint).toContain('culture filter "Ancient Greek"');
    expect(hint).toContain(
      'smithsonian_list_terms { field: "culture", contains: "Ancient Greek" }',
    );
    // Only the filtered search runs — no object_type/unit_code harvest for a
    // routable-only filter.
    expect(searchFn).toHaveBeenCalledTimes(1);
  });

  it('routes a bad place filter to smithsonian_list_terms field "place" (issue #21)', async () => {
    const searchFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearch.errors });
    const input = smithsonianSearch.input.parse({ query: 'mask', filters: { place: 'Nigeria' } });
    const err = await smithsonianSearch.handler(input, ctx).catch((e) => e);

    expect(err.data?.reason).toBe('invalid_filter');
    const hint = err.data?.recovery?.hint as string;
    expect(hint).toContain('place filter "Nigeria"');
    expect(hint).toContain('field: "place", contains: "Nigeria"');
    expect(searchFn).toHaveBeenCalledTimes(1);
  });

  it('routes a bad date_decade filter to the list_terms "date" field (issue #21)', async () => {
    // date_decade maps to the list_terms `date` field — not a literal "date_decade" field.
    const searchFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearch.errors });
    const input = smithsonianSearch.input.parse({
      query: 'car',
      filters: { date_decade: '1820s' },
    });
    const err = await smithsonianSearch.handler(input, ctx).catch((e) => e);

    expect(err.data?.reason).toBe('invalid_filter');
    const hint = err.data?.recovery?.hint as string;
    expect(hint).toContain('date_decade filter "1820s"');
    expect(hint).toContain('field: "date", contains: "1820s"');
  });

  it('routes culture and still harvests object_type when both filters are set (issue #21)', async () => {
    // culture routes to list_terms; object_type (harvest-relevant) triggers the
    // unfiltered re-query, so the hint carries BOTH the routing and the harvest.
    const harvestRows: ObjectSummary[] = [
      {
        record_id: 'a',
        title: 'A',
        unit_code: 'SAAM',
        museum_name: 'Smithsonian American Art Museum',
        object_type: 'Paintings',
        is_cc0: true,
        has_media: false,
      },
    ];
    const searchFn = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: harvestRows, rowCount: harvestRows.length });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearch.errors });
    const input = smithsonianSearch.input.parse({
      query: 'portrait',
      filters: { culture: 'Ancient Greek', object_type: 'Painting' },
    });
    const err = await smithsonianSearch.handler(input, ctx).catch((e) => e);

    const hint = err.data?.recovery?.hint as string;
    expect(hint).toContain('field: "culture", contains: "Ancient Greek"');
    expect(hint).toContain('object_type: Paintings');
    // The harvest re-query runs because object_type is set.
    expect(searchFn).toHaveBeenCalledTimes(2);
  });

  it('non-truncated result validates against the effective output schema (issue #13)', async () => {
    // Narrow result: objects.length === rowCount, so no truncation enrichment is
    // written. The framework validates output.extend(enrichment); required-but-
    // unpopulated enrichment fields (the pre-fix contract) threw on this path.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: [makeObjectSummary()], rowCount: 1 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearch.errors });
    const input = smithsonianSearch.input.parse({ query: 'phlogiston', rows: 100 });
    const result = await smithsonianSearch.handler(input, ctx);

    const effectiveOutput = smithsonianSearch.output.extend(smithsonianSearch.enrichment!);
    expect(() => effectiveOutput.parse(result)).not.toThrow();
  });

  it('builds filter queries embedded in q for all filter fields', async () => {
    const searchFn = vi.fn().mockResolvedValue({ rows: [makeObjectSummary()], rowCount: 1 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearch.errors });
    const input = smithsonianSearch.input.parse({
      query: 'test',
      filters: {
        unit_code: 'NASM',
        object_type: 'Aircraft',
        cc0_only: true,
        online_only: true,
      },
    });
    await smithsonianSearch.handler(input, ctx);

    const calledParams = searchFn.mock.calls[0]?.[0] as { filters: string[] };
    // Filters are passed as Lucene terms to embed in q — not as separate fq params
    expect(calledParams.filters).toContain('unit_code:NASM');
    expect(calledParams.filters).toContain('object_type:Aircraft');
    expect(calledParams.filters).toContain('media_usage:CC0');
    expect(calledParams.filters).toContain('online_media_type:*');
  });

  it('quotes multi-word filter values in Lucene terms', async () => {
    const searchFn = vi.fn().mockResolvedValue({ rows: [makeObjectSummary()], rowCount: 1 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearch.errors });
    const input = smithsonianSearch.input.parse({
      query: 'test',
      filters: {
        culture: 'Plains Indian',
        place: 'United States of America',
      },
    });
    await smithsonianSearch.handler(input, ctx);

    const calledParams = searchFn.mock.calls[0]?.[0] as { filters: string[] };
    expect(calledParams.filters).toContain('culture:"Plains Indian"');
    expect(calledParams.filters).toContain('place:"United States of America"');
  });

  it('defaults rows to 20 and start to 0', async () => {
    const searchFn = vi.fn().mockResolvedValue({ rows: [makeObjectSummary()], rowCount: 1 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext();
    const input = smithsonianSearch.input.parse({ query: 'test' });
    await smithsonianSearch.handler(input, ctx);

    const calledParams = searchFn.mock.calls[0]?.[0] as { rows: number; start: number };
    expect(calledParams.rows).toBe(20);
    expect(calledParams.start).toBe(0);
  });

  it('caps rows at 100', () => {
    expect(() => smithsonianSearch.input.parse({ query: 'test', rows: 101 })).toThrow();
  });

  it('format renders record_id, title, museum, and CC0 status', () => {
    const output = {
      objects: [makeObjectSummary()],
      total_count: 100,
    };
    const blocks = smithsonianSearch.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('nasm_TEST001');
    expect(text).toContain('Test Object');
    expect(text).toContain('NASM');
    expect(text).toContain('100');
    expect(text).toContain('CC0');
  });

  it('format renders the object date when present (issue #20)', () => {
    const output = { objects: [makeObjectSummary()], total_count: 1 };
    const blocks = smithsonianSearch.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('**Date:** 1960s');
  });

  it('format omits the date line for a date-less object (issue #20)', () => {
    // Sparse upstream row with no indexed date — the Date line must be absent,
    // not rendered as an empty or fabricated value.
    const dateless: ObjectSummary = {
      record_id: 'nmnh_NODATE',
      title: 'Undated Object',
      unit_code: 'NMNH',
      museum_name: 'National Museum of Natural History',
      is_cc0: false,
      has_media: false,
    };
    const output = { objects: [dateless], total_count: 1 };
    const blocks = smithsonianSearch.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).not.toContain('**Date:**');
    expect(text).toContain('nmnh_NODATE');
  });
});
