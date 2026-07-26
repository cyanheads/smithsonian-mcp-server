/**
 * @fileoverview Tests for smithsonian_search_objects tool.
 * @module tests/mcp-server/tools/definitions/smithsonian-search-objects.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { smithsonianSearchObjects } from '@/mcp-server/tools/definitions/smithsonian-search-objects.tool.js';
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

/**
 * Stand in for the service on the filtered-zero path, where the handler consults the
 * term vocabulary for each routable filter to tell an unresolvable value from a
 * resolvable one (issue #33). `indexed` is the answer that check returns; passing it
 * explicitly keeps every filtered-zero test on a deliberate branch.
 */
function makeFilteredZeroService(
  search: ReturnType<typeof vi.fn>,
  indexed: boolean | Error = false,
): svcModule.SmithsonianService {
  const isIndexedTerm =
    indexed instanceof Error
      ? vi.fn().mockRejectedValue(indexed)
      : vi.fn().mockResolvedValue(indexed);
  return { search, isIndexedTerm } as unknown as svcModule.SmithsonianService;
}

describe('smithsonianSearchObjects', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns results for a valid query', async () => {
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: [makeObjectSummary()], rowCount: 100 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
    const input = smithsonianSearchObjects.input.parse({ query: 'aircraft' });
    const result = await smithsonianSearchObjects.handler(input, ctx);

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

    const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
    const input = smithsonianSearchObjects.input.parse({ query: 'quilt', rows: 25 });
    const result = await smithsonianSearchObjects.handler(input, ctx);

    expect(result.objects).toHaveLength(25);
    expect(searchFn.mock.calls[0]?.[0]).toMatchObject({ rows: 25 });
  });

  it('throws no_results with the declared recovery hint on the wire (issue #14)', async () => {
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
    const input = smithsonianSearchObjects.input.parse({ query: 'xyzzy_no_results_ever' });
    // The declared contract recovery must reach the wire as data.recovery.hint.
    const expectedHint = smithsonianSearchObjects.errors?.find(
      (e) => e.reason === 'no_results',
    )?.recovery;
    await expect(smithsonianSearchObjects.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results', recovery: { hint: expectedHint } },
    });
  });

  it('returns a successful terminal page when start is past the end (issue #29)', async () => {
    // rowCount > 0 with an empty page means the offset walked off the end of a real
    // result set — normal pagination completion. The pre-fix guard read the page-local
    // length and threw no_results, telling a caller with 400 real matches to check
    // their spelling.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: [], rowCount: 400 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
    const input = smithsonianSearchObjects.input.parse({
      query: 'Apollo 11',
      start: 10000,
      rows: 10,
    });
    const result = await smithsonianSearchObjects.handler(input, ctx);

    expect(result.objects).toEqual([]);
    expect(result.total_count).toBe(400);
  });

  it('still throws no_results when the query genuinely matches nothing at any offset (issue #29)', async () => {
    // The complement of the fix: rowCount === 0 is a real zero-match query, so the
    // spelling/broadening recovery is the correct advice even at a deep start.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
    const input = smithsonianSearchObjects.input.parse({
      query: 'xyzzy_no_such_thing',
      start: 500,
    });
    await expect(smithsonianSearchObjects.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results' },
    });
  });

  it('does not report truncated on a past-the-end page (issue #29)', async () => {
    // The page-local trigger reported truncated: true, shown: 0 on a page that
    // withholds nothing — the same defect #30 fixes in smithsonian_list_terms,
    // newly reachable here once the guard stopped throwing.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: [], rowCount: 400 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
    const input = smithsonianSearchObjects.input.parse({
      query: 'Apollo 11',
      start: 10000,
      rows: 10,
    });
    await smithsonianSearchObjects.handler(input, ctx);

    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('does not report truncated on the exact last page (issue #29)', async () => {
    // start(20) + shown(5) === rowCount(25): nothing remains past this page.
    const tail = Array.from({ length: 5 }, (_, i) => makeObjectSummary(`nasm_TAIL${i}`));
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: tail, rowCount: 25 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
    const input = smithsonianSearchObjects.input.parse({ query: 'quilt', start: 20, rows: 10 });
    await smithsonianSearchObjects.handler(input, ctx);

    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('still reports truncated when objects remain past the page (issue #29)', async () => {
    const page = Array.from({ length: 10 }, (_, i) => makeObjectSummary(`nasm_MID${i}`));
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: page, rowCount: 400 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
    const input = smithsonianSearchObjects.input.parse({ query: 'Apollo 11', start: 20, rows: 10 });
    await smithsonianSearchObjects.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(10);
    expect(enrichment.truncationCeiling).toBe(400);
  });

  it('truncation guidance names start and survives the enrichment schema (issue #23)', async () => {
    // Two failure modes, one test. ctx.enrich.truncated() always writes a notice, but
    // the generic default names no continuation input — and with no `notice` field
    // declared, output.extend(enrichment) stripped it off the wire entirely.
    const page = Array.from({ length: 10 }, (_, i) => makeObjectSummary(`nasm_G${i}`));
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: page, rowCount: 400 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
    const input = smithsonianSearchObjects.input.parse({ query: 'Apollo 11', rows: 10 });
    const result = await smithsonianSearchObjects.handler(input, ctx);

    const effectiveOutput = smithsonianSearchObjects.output.extend(
      smithsonianSearchObjects.enrichment!,
    );
    const onTheWire = effectiveOutput.parse({ ...result, ...getEnrichment(ctx) });
    expect(onTheWire.notice).toContain('start');
    expect(onTheWire.notice).not.toBe(
      'Results capped at 10; showing 10. Raise the cap or narrow with filters.',
    );
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

    const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
    const input = smithsonianSearchObjects.input.parse({
      query: 'Greek',
      filters: { object_type: 'Painting' },
    });
    const err = await smithsonianSearchObjects.handler(input, ctx).catch((e) => e);

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

    const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
    const input = smithsonianSearchObjects.input.parse({
      query: 'quilt',
      filters: { object_type: 'Painting' },
    });
    const expectedHint = smithsonianSearchObjects.errors?.find(
      (e) => e.reason === 'invalid_filter',
    )?.recovery;
    await expect(smithsonianSearchObjects.handler(input, ctx)).rejects.toMatchObject({
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

    const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
    const input = smithsonianSearchObjects.input.parse({
      query: 'quilt',
      filters: { object_type: 'Painting' },
    });
    const expectedHint = smithsonianSearchObjects.errors?.find(
      (e) => e.reason === 'invalid_filter',
    )?.recovery;
    await expect(smithsonianSearchObjects.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_filter', recovery: { hint: expectedHint } },
    });
  });

  it('routes a bad culture filter to smithsonian_list_terms with contains, no harvest re-query (issue #21)', async () => {
    // culture is absent from ObjectSummary, so a result harvest can't resolve it — the
    // hint routes to the vocabulary endpoint with a contains substring, and no
    // unfiltered harvest re-query runs for a routable-only filter.
    const searchFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(makeFilteredZeroService(searchFn));

    const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
    const input = smithsonianSearchObjects.input.parse({
      query: 'sculpture',
      filters: { culture: 'Ancient Greek' },
    });
    const err = await smithsonianSearchObjects.handler(input, ctx).catch((e) => e);

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
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(makeFilteredZeroService(searchFn));

    const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
    const input = smithsonianSearchObjects.input.parse({
      query: 'mask',
      filters: { place: 'Nigeria' },
    });
    const err = await smithsonianSearchObjects.handler(input, ctx).catch((e) => e);

    expect(err.data?.reason).toBe('invalid_filter');
    const hint = err.data?.recovery?.hint as string;
    expect(hint).toContain('place filter "Nigeria"');
    expect(hint).toContain('field: "place", contains: "Nigeria"');
    expect(searchFn).toHaveBeenCalledTimes(1);
  });

  it('routes a bad date filter to the list_terms "date" field (issue #21)', async () => {
    const searchFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(makeFilteredZeroService(searchFn));

    const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
    const input = smithsonianSearchObjects.input.parse({
      query: 'car',
      filters: { date: '1820s' },
    });
    const err = await smithsonianSearchObjects.handler(input, ctx).catch((e) => e);

    expect(err.data?.reason).toBe('invalid_filter');
    const hint = err.data?.recovery?.hint as string;
    expect(hint).toContain('date filter "1820s"');
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
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(makeFilteredZeroService(searchFn));

    const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
    const input = smithsonianSearchObjects.input.parse({
      query: 'portrait',
      filters: { culture: 'Ancient Greek', object_type: 'Painting' },
    });
    const err = await smithsonianSearchObjects.handler(input, ctx).catch((e) => e);

    const hint = err.data?.recovery?.hint as string;
    expect(hint).toContain('field: "culture", contains: "Ancient Greek"');
    expect(hint).toContain('object_type: Paintings');
    // The harvest re-query runs because object_type is set.
    expect(searchFn).toHaveBeenCalledTimes(2);
  });

  describe('indexed-but-empty filter values (issue #33)', () => {
    /**
     * The two branches of the same filtered zero, per routable filter. `indexed: true`
     * is a value the vocabulary enumerates: `smithsonian_list_terms { contains }`
     * returns it verbatim, so a hint routing there loops the caller through the
     * identical failing search. Only culture, place, and date route to
     * list_terms — unit_code and object_type resolve through the result harvest.
     */
    it.each([
      ['culture', { culture: 'Guiana' }, 'culture', 'Guiana'],
      ['place', { place: 'Nigeria' }, 'place', 'Nigeria'],
      ['date', { date: '1210s' }, 'date', '1210s'],
    ] as const)(
      '%s: an indexed value is named as exact, not as unresolved',
      async (filter, filters, field, value) => {
        const isIndexedTerm = vi.fn().mockResolvedValue(true);
        vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
          search: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
          isIndexedTerm,
        } as unknown as svcModule.SmithsonianService);

        const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
        const input = smithsonianSearchObjects.input.parse({ query: 'basket', filters });
        const err = await smithsonianSearchObjects.handler(input, ctx).catch((e) => e);

        expect(err.data?.reason).toBe('invalid_filter');
        const hint = err.data?.recovery?.hint as string;
        expect(hint).toContain(`${filter} filter "${value}" is an exact term`);
        expect(hint).toContain('resolving it again returns the same value');
        // The dead-end the old hint produced for every zero match.
        expect(hint).not.toContain('matched nothing — resolve it to an exact term');
        expect(isIndexedTerm).toHaveBeenCalledWith(field, value, ctx);
      },
    );

    it('keeps the resolve-it hint for a value outside the vocabulary', async () => {
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(
        makeFilteredZeroService(vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), false),
      );

      const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
      const input = smithsonianSearchObjects.input.parse({
        query: 'basket',
        filters: { culture: 'Guianaa' },
      });
      const err = await smithsonianSearchObjects.handler(input, ctx).catch((e) => e);

      const hint = err.data?.recovery?.hint as string;
      expect(hint).toContain('culture filter "Guianaa" matched nothing');
      expect(hint).not.toContain('is an exact term');
    });

    it('branches each routable filter independently', async () => {
      // One indexed value and one unindexed value in the same failing call: the hint
      // must carry both statements, not collapse to whichever was checked first.
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
        search: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        isIndexedTerm: vi
          .fn()
          .mockImplementation((field: string) => Promise.resolve(field === 'culture')),
      } as unknown as svcModule.SmithsonianService);

      const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
      const input = smithsonianSearchObjects.input.parse({
        query: 'basket',
        filters: { culture: 'Guiana', place: 'Nowherestan' },
      });
      const err = await smithsonianSearchObjects.handler(input, ctx).catch((e) => e);

      const hint = err.data?.recovery?.hint as string;
      expect(hint).toContain('culture filter "Guiana" is an exact term');
      expect(hint).toContain('place filter "Nowherestan" matched nothing');
    });

    it('falls back to the resolve-it hint when the vocabulary lookup throws', async () => {
      // Best-effort and failure-path only — an unreachable /terms must not turn a
      // clean invalid_filter into a crash.
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(
        makeFilteredZeroService(
          vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
          new Error('EDAN unavailable'),
        ),
      );

      const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
      const input = smithsonianSearchObjects.input.parse({
        query: 'basket',
        filters: { culture: 'Guiana' },
      });
      const err = await smithsonianSearchObjects.handler(input, ctx).catch((e) => e);

      expect(err.data?.reason).toBe('invalid_filter');
      expect(err.data?.recovery?.hint as string).toContain(
        'culture filter "Guiana" matched nothing',
      );
    });

    it('never consults the vocabulary for unit_code or object_type', async () => {
      // Those two resolve through the unfiltered result harvest, not list_terms, so
      // they have no routable entry to check.
      const isIndexedTerm = vi.fn().mockResolvedValue(true);
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
        search: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        isIndexedTerm,
      } as unknown as svcModule.SmithsonianService);

      const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
      const input = smithsonianSearchObjects.input.parse({
        query: 'basket',
        filters: { unit_code: 'FSA', object_type: 'Painting' },
      });
      await smithsonianSearchObjects.handler(input, ctx).catch((e) => e);

      expect(isIndexedTerm).not.toHaveBeenCalled();
    });
  });

  it('non-truncated result validates against the effective output schema (issue #13)', async () => {
    // Narrow result: objects.length === rowCount, so no truncation enrichment is
    // written. The framework validates output.extend(enrichment); required-but-
    // unpopulated enrichment fields (the pre-fix contract) threw on this path.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: [makeObjectSummary()], rowCount: 1 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
    const input = smithsonianSearchObjects.input.parse({ query: 'phlogiston', rows: 100 });
    const result = await smithsonianSearchObjects.handler(input, ctx);

    const effectiveOutput = smithsonianSearchObjects.output.extend(
      smithsonianSearchObjects.enrichment!,
    );
    expect(() => effectiveOutput.parse(result)).not.toThrow();
  });

  it('builds filter queries embedded in q for all filter fields', async () => {
    const searchFn = vi.fn().mockResolvedValue({ rows: [makeObjectSummary()], rowCount: 1 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
    const input = smithsonianSearchObjects.input.parse({
      query: 'test',
      filters: {
        unit_code: 'NASM',
        object_type: 'Aircraft',
        cc0_only: true,
        online_only: true,
      },
    });
    await smithsonianSearchObjects.handler(input, ctx);

    const calledParams = searchFn.mock.calls[0]?.[0] as { filters: string[] };
    // Filters are passed as Lucene terms to embed in q — not as separate fq params
    expect(calledParams.filters).toContain('unit_code:"NASM"');
    expect(calledParams.filters).toContain('object_type:"Aircraft"');
    // Not luceneField calls — these two are intentional wildcards and stay unquoted.
    expect(calledParams.filters).toContain('media_usage:CC0');
    expect(calledParams.filters).toContain('online_media_type:*');
  });

  it('online_only matches the index field, so a result may report has_media false (issue #28)', async () => {
    // online_media_type (what the filter matches) and descriptiveNonRepeating.online_media
    // (what has_media reports) are two distinct upstream signals: a scanned book carries
    // an online_media_type with no deliverable media. The two are allowed to disagree —
    // has_media stays the accurate predictor of a smithsonian_get_media outcome, and
    // re-deriving it from the filter's signal would make it lie about that call.
    const surrogate: ObjectSummary = {
      ...makeObjectSummary('siris_sil_813668'),
      unit_code: 'SIL',
      museum_name: 'Smithsonian Libraries',
      has_media: false,
    };
    const searchFn = vi.fn().mockResolvedValue({ rows: [surrogate], rowCount: 1 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
    const input = smithsonianSearchObjects.input.parse({
      query: 'dinosaur',
      filters: { online_only: true },
    });
    const result = await smithsonianSearchObjects.handler(input, ctx);

    const calledParams = searchFn.mock.calls[0]?.[0] as { filters: string[] };
    expect(calledParams.filters).toEqual(['online_media_type:*']);
    expect(result.objects[0]?.record_id).toBe('siris_sil_813668');
    expect(result.objects[0]?.has_media).toBe(false);
  });

  it('online_only names the index field it matches rather than promising media (issue #28)', () => {
    // The advertised description is the whole fix here — no code path changed. Assert
    // the substantive claim, not the exact prose: it must name online_media_type and
    // must not restate the old "objects that have any online media" promise.
    const jsonSchema = z.toJSONSchema(smithsonianSearchObjects.input) as {
      properties: {
        filters: { properties: { online_only: { description?: string } } };
      };
    };
    const description = jsonSchema.properties.filters.properties.online_only.description ?? '';
    expect(description).toContain('online_media_type');
    expect(description).not.toMatch(/objects that have any online media/i);
  });

  it('cc0_only describes itself as a media-presence filter, not a license filter (issue #40)', () => {
    // media_usage:CC0 marks a record as HAVING CC0 media, not as being CC0-licensed —
    // the records it excludes are CC0 too, just undigitized. The advertised description
    // is the whole fix here; assert the substantive claim, not the exact prose.
    const jsonSchema = z.toJSONSchema(smithsonianSearchObjects.input) as {
      properties: {
        filters: { properties: { cc0_only: { description?: string } } };
      };
    };
    const description = jsonSchema.properties.filters.properties.cc0_only.description ?? '';
    expect(description).toContain('media_usage:CC0');
    expect(description).toContain('has_media');
    expect(description).not.toMatch(/restrict to CC0 open-access objects/i);
  });

  it('quotes multi-word filter values in Lucene terms', async () => {
    const searchFn = vi.fn().mockResolvedValue({ rows: [makeObjectSummary()], rowCount: 1 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
    const input = smithsonianSearchObjects.input.parse({
      query: 'test',
      filters: {
        culture: 'Plains Indian',
        place: 'United States of America',
      },
    });
    await smithsonianSearchObjects.handler(input, ctx);

    const calledParams = searchFn.mock.calls[0]?.[0] as { filters: string[] };
    expect(calledParams.filters).toContain('culture:"Plains Indian"');
    expect(calledParams.filters).toContain('place:"United States of America"');
  });

  it('quotes a multi-word unit_code so it cannot leak into free text (issue #32)', async () => {
    // An unquoted unit_code term ends the field constraint at the first space, so
    // the trailing words rejoin q as free text and the result set comes back
    // effectively unfiltered — reported to the caller as the museum's total_count.
    const searchFn = vi.fn().mockResolvedValue({ rows: [makeObjectSummary()], rowCount: 1 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
    const input = smithsonianSearchObjects.input.parse({
      query: 'flight',
      filters: { unit_code: 'National Air and Space Museum' },
    });
    await smithsonianSearchObjects.handler(input, ctx);

    const calledParams = searchFn.mock.calls[0]?.[0] as { filters: string[] };
    expect(calledParams.filters).toContain('unit_code:"National Air and Space Museum"');
    expect(calledParams.filters).not.toContain('unit_code:National Air and Space Museum');
  });

  it('defaults rows to 20 and start to 0', async () => {
    const searchFn = vi.fn().mockResolvedValue({ rows: [makeObjectSummary()], rowCount: 1 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext();
    const input = smithsonianSearchObjects.input.parse({ query: 'test' });
    await smithsonianSearchObjects.handler(input, ctx);

    const calledParams = searchFn.mock.calls[0]?.[0] as { rows: number; start: number };
    expect(calledParams.rows).toBe(20);
    expect(calledParams.start).toBe(0);
  });

  it('caps rows at 100', () => {
    expect(() => smithsonianSearchObjects.input.parse({ query: 'test', rows: 101 })).toThrow();
  });

  describe('date filter accepts the whole indexed vocabulary (issue #36)', () => {
    /**
     * 128 of the 201 terms `smithsonian_list_terms { field: "date" }` enumerates are
     * not decade-shaped, so every one of these is a real, matchable value the former
     * `"NNNNs"` gate refused at the schema boundary.
     */
    it.each(['-2500', '500-1500', 'BCE 1000s', '21st century', '999-700 BC', '300s'])(
      'passes the non-decade term %s through to the upstream query',
      async (date) => {
        const searchFn = vi.fn().mockResolvedValue({ rows: [makeObjectSummary()], rowCount: 1 });
        vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
          search: searchFn,
        } as unknown as svcModule.SmithsonianService);

        const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
        const input = smithsonianSearchObjects.input.parse({ query: 'test', filters: { date } });
        await smithsonianSearchObjects.handler(input, ctx);

        const calledParams = searchFn.mock.calls[0]?.[0] as { filters: string[] };
        // Always quoted (issue #42) — an unquoted single-token value is parsed for
        // Lucene syntax, so quoting is not conditional on the value containing a space.
        expect(calledParams.filters).toContain(`date:"${date}"`);
      },
    );

    it('still accepts a decade term', () => {
      expect(() =>
        smithsonianSearchObjects.input.parse({ query: 'test', filters: { date: '1920s' } }),
      ).not.toThrow();
    });
  });

  describe('empty query (issue #39)', () => {
    it('substitutes the match-all term when there is no query and no filters', async () => {
      // An entirely empty q is the one input EDAN answers with a raw 400. `*` is the
      // match-all the API accepts, so "everything" resolves instead of failing at the
      // transport layer.
      const searchFn = vi.fn().mockResolvedValue({ rows: [makeObjectSummary()], rowCount: 14 });
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
        search: searchFn,
      } as unknown as svcModule.SmithsonianService);

      const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
      const input = smithsonianSearchObjects.input.parse({ query: '', rows: 3 });
      await smithsonianSearchObjects.handler(input, ctx);

      const calledParams = searchFn.mock.calls[0]?.[0] as { query: string; filters: string[] };
      expect(calledParams.query).toBe('*');
      expect(calledParams.filters).toEqual([]);
    });

    it('leaves an empty query with filters on the filters-only path', async () => {
      // Filters alone already assemble a non-empty q upstream, so this call works
      // today — the substitution must not reach it and turn the filtered browse into
      // a match-all ANDed with the filters.
      const searchFn = vi.fn().mockResolvedValue({ rows: [makeObjectSummary()], rowCount: 5 });
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
        search: searchFn,
      } as unknown as svcModule.SmithsonianService);

      const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
      const input = smithsonianSearchObjects.input.parse({
        query: '',
        filters: { unit_code: 'NASM' },
      });
      await smithsonianSearchObjects.handler(input, ctx);

      const calledParams = searchFn.mock.calls[0]?.[0] as { query: string; filters: string[] };
      expect(calledParams.query).toBe('');
      expect(calledParams.filters).toEqual(['unit_code:"NASM"']);
    });

    it('leaves a whitespace-only query untouched', async () => {
      // Upstream answers a whitespace query with a clean zero, which the handler
      // already surfaces as no_results — no substitution needed.
      const searchFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
        search: searchFn,
      } as unknown as svcModule.SmithsonianService);

      const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
      const input = smithsonianSearchObjects.input.parse({ query: '   ' });
      const err = await smithsonianSearchObjects.handler(input, ctx).catch((e) => e);

      const calledParams = searchFn.mock.calls[0]?.[0] as { query: string };
      expect(calledParams.query).toBe('   ');
      expect(err.data?.reason).toBe('no_results');
    });
  });

  it('format renders record_id, title, museum, and CC0 status', () => {
    const output = {
      objects: [makeObjectSummary()],
      total_count: 100,
    };
    const blocks = smithsonianSearchObjects.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('nasm_TEST001');
    expect(text).toContain('Test Object');
    expect(text).toContain('NASM');
    expect(text).toContain('100');
    expect(text).toContain('CC0');
  });

  it('format renders the object date when present (issue #20)', () => {
    const output = { objects: [makeObjectSummary()], total_count: 1 };
    const blocks = smithsonianSearchObjects.format!(output);
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
    const blocks = smithsonianSearchObjects.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).not.toContain('**Date:**');
    expect(text).toContain('nmnh_NODATE');
  });

  describe('filter values are quoted and escaped (issue #42)', () => {
    it('escapes a quote-bearing culture term instead of truncating the phrase', async () => {
      // `smithsonian_list_terms { field: "culture", contains: "Tomb Age" }` returns this
      // term verbatim as a pass-through-ready value. Unescaped, the inner quote closes
      // the phrase early, EDAN matches nothing, and the caller is told a term with 3
      // retrievable objects has none.
      const searchFn = vi.fn().mockResolvedValue({ rows: [makeObjectSummary()], rowCount: 3 });
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
        search: searchFn,
      } as unknown as svcModule.SmithsonianService);

      const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
      await smithsonianSearchObjects.handler(
        smithsonianSearchObjects.input.parse({
          query: '',
          filters: { culture: 'Early Iron Age, "Tomb Age"' },
        }),
        ctx,
      );

      const calledParams = searchFn.mock.calls[0]?.[0] as { filters: string[] };
      expect(calledParams.filters).toEqual(['culture:"Early Iron Age, \\"Tomb Age\\""']);
    });

    it('quotes a bare wildcard place term so it stays one literal term', async () => {
      // `*` is a literal term in the `place` vocabulary. Emitted unquoted as `place:*`
      // it becomes a wildcard over every record carrying a place — 12.4M hits reported
      // as the total for a term that has 124.
      const searchFn = vi.fn().mockResolvedValue({ rows: [makeObjectSummary()], rowCount: 124 });
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
        search: searchFn,
      } as unknown as svcModule.SmithsonianService);

      const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
      await smithsonianSearchObjects.handler(
        smithsonianSearchObjects.input.parse({ query: '', filters: { place: '*' } }),
        ctx,
      );

      const calledParams = searchFn.mock.calls[0]?.[0] as { filters: string[] };
      expect(calledParams.filters).toEqual(['place:"*"']);
      expect(calledParams.filters).not.toContain('place:*');
    });

    it('leaves the two intentional wildcard literals unquoted', async () => {
      // online_media_type:* and media_usage:CC0 are built as string literals, not via
      // luceneField — the wildcard there is deliberate and must survive the fix.
      const searchFn = vi.fn().mockResolvedValue({ rows: [makeObjectSummary()], rowCount: 1 });
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
        search: searchFn,
      } as unknown as svcModule.SmithsonianService);

      const ctx = createMockContext({ errors: smithsonianSearchObjects.errors });
      await smithsonianSearchObjects.handler(
        smithsonianSearchObjects.input.parse({
          query: 'aircraft',
          filters: { online_only: true, cc0_only: true },
        }),
        ctx,
      );

      const calledParams = searchFn.mock.calls[0]?.[0] as { filters: string[] };
      expect(calledParams.filters).toEqual(['online_media_type:*', 'media_usage:CC0']);
    });
  });
});
