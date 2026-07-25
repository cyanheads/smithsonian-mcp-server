/**
 * @fileoverview Tests for smithsonian_browse_category tool.
 * @module tests/mcp-server/tools/definitions/smithsonian-browse-category.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { smithsonianBrowseCategory } from '@/mcp-server/tools/definitions/smithsonian-browse-category.tool.js';
import * as svcModule from '@/services/smithsonian/smithsonian-service.js';
import type { ObjectSummary } from '@/services/smithsonian/types.js';

/**
 * Fixture rows alternate two codes from the live `unit_code` vocabulary. A bare
 * `NMNH` is not indexed — Natural History records carry discipline sub-unit codes.
 */
function makeSamples(count = 3): ObjectSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    record_id: `nasm_TEST00${i + 1}`,
    title: `Object ${i + 1}`,
    unit_code: i % 2 === 0 ? 'NASM' : 'NMNHBIRDS',
    museum_name:
      i % 2 === 0 ? 'National Air and Space Museum' : 'NMNH - Vertebrate Zoology - Birds Division',
    is_cc0: true,
    has_media: true,
  }));
}

/**
 * Read the recovery hint off a thrown browse error, asserting it sits at the one
 * path both wire surfaces are built from. `structuredContent.error.data.recovery.hint`
 * is what structuredContent-reading clients (Claude Code) receive; the framework's
 * error-result builder mirrors that same string into the `content[]` "Recovery:" line
 * for format()-only clients (Claude Desktop), and mirrors it only when the field is a
 * non-empty string — so this assertion is the precondition for the content[] line
 * existing at all. A hint parked anywhere else reaches neither surface (issue #14).
 */
function recoveryHint(err: unknown): string {
  const hint = (err as { data?: { recovery?: { hint?: unknown } } }).data?.recovery?.hint;
  expect(typeof hint).toBe('string');
  expect(hint as string).not.toBe('');
  return hint as string;
}

describe('smithsonianBrowseCategory', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns overview for museum mode', async () => {
    const searchFn = vi.fn().mockResolvedValue({ rows: makeSamples(3), rowCount: 150 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    const input = smithsonianBrowseCategory.input.parse({ mode: 'museum', value: 'NASM' });
    const result = await smithsonianBrowseCategory.handler(input, ctx);

    expect(result.mode).toBe('museum');
    expect(result.value).toBe('NASM');
    expect(result.total_count).toBe(150);
    expect(result.sample_objects).toHaveLength(3);
    // museum mode: no breakdown
    expect(result.museum_breakdown).toHaveLength(0);
  });

  it('returns museum_breakdown for culture mode', async () => {
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: makeSamples(4), rowCount: 80 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    const input = smithsonianBrowseCategory.input.parse({ mode: 'culture', value: 'Aztecs' });
    const result = await smithsonianBrowseCategory.handler(input, ctx);

    expect(result.museum_breakdown.length).toBeGreaterThan(0);
    // Should list both codes carried by the mock rows
    const unitCodes = result.museum_breakdown.map((m) => m.unit_code);
    expect(unitCodes).toContain('NASM');
    expect(unitCodes).toContain('NMNHBIRDS');
  });

  it('throws invalid_category with the medium-mode recovery hint on a true zero-match (issue #31)', async () => {
    // A zero-match browse means the value is not a usable indexed term, so the error is
    // invalid_category (ValidationError), not a missing-object NotFound. object_type is not
    // enumerable through smithsonian_list_terms, so with no harvest to fall back on the
    // medium hint routes to a free-text smithsonian_search_objects whose result
    // object_type values are the vocabulary to inspect.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    const input = smithsonianBrowseCategory.input.parse({
      mode: 'medium',
      value: 'NonexistentMedium',
    });
    const err = await smithsonianBrowseCategory.handler(input, ctx).catch((e) => e);

    expect(err.data?.reason).toBe('invalid_category');
    const hint = recoveryHint(err);
    expect(hint).toContain('smithsonian_search_objects { query: "NonexistentMedium" }');
    expect(hint).toContain('object_type');
  });

  it('names harvested object_type candidates in the medium recovery hint (issue #31)', async () => {
    // object_type is the one browse dimension smithsonian_list_terms cannot enumerate, so
    // the zero-match path re-runs the value as an unfiltered free-text search and names the
    // object types that actually co-occur with it — the filtered-zero harvest #15 added to
    // smithsonian_search_objects. Candidates are listed, never auto-selected.
    const searchFn = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [
          { ...makeSamples(1)[0], object_type: 'Paintings' },
          { ...makeSamples(1)[0], object_type: 'Drawings' },
          { ...makeSamples(1)[0], object_type: 'Paintings' },
          { ...makeSamples(1)[0], object_type: undefined },
        ],
        rowCount: 3,
      });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    const input = smithsonianBrowseCategory.input.parse({ mode: 'medium', value: 'Painting' });
    const err = await smithsonianBrowseCategory.handler(input, ctx).catch((e) => e);

    expect(err.data?.reason).toBe('invalid_category');
    const hint = recoveryHint(err);
    // Distinct, in first-seen order, undefined types dropped.
    expect(hint).toContain('Paintings, Drawings');
    expect(hint).not.toContain('Paintings, Drawings, Paintings');
    // The harvest re-query is the free-text search the static hint would have told the
    // caller to run: the value as query, no filters.
    expect(searchFn.mock.calls[1]?.[0]).toMatchObject({
      query: 'Painting',
      filters: [],
      start: 0,
    });
  });

  it.each([
    ['an empty harvest', { rows: [], rowCount: 0 }, undefined],
    ['a throwing harvest', undefined, new Error('EDAN unavailable')],
  ])('falls back to the static medium hint on %s (issue #31)', async (_label, resolved, thrown) => {
    // Harvesting is best-effort and failure-path only — it must never turn a clean
    // invalid_category into a crash.
    const searchFn = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
    if (thrown) searchFn.mockRejectedValueOnce(thrown);
    else searchFn.mockResolvedValueOnce(resolved);
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    const input = smithsonianBrowseCategory.input.parse({ mode: 'medium', value: 'Painting' });
    const err = await smithsonianBrowseCategory.handler(input, ctx).catch((e) => e);

    expect(err.data?.reason).toBe('invalid_category');
    expect(recoveryHint(err)).toContain('smithsonian_search_objects { query: "Painting" }');
  });

  it('throws invalid_category with the culture-mode recovery hint on a true zero-match (issue #31)', async () => {
    const searchFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    const input = smithsonianBrowseCategory.input.parse({
      mode: 'culture',
      value: 'Nonexistent Culture',
    });
    const err = await smithsonianBrowseCategory.handler(input, ctx).catch((e) => e);

    expect(err.data?.reason).toBe('invalid_category');
    expect(recoveryHint(err)).toContain(
      'smithsonian_list_terms { field: "culture", contains: "Nonexistent Culture" }',
    );
    // The object_type harvest is medium-only — the enumerable modes route to list_terms.
    expect(searchFn).toHaveBeenCalledTimes(1);
  });

  it('throws invalid_category with the period-mode recovery hint on a true zero-match (issue #31)', async () => {
    // A well-formed decade that simply isn't indexed. The "NNNNs" requirement is enforced
    // at the schema boundary, so the hint carries only the resolution step.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    const input = smithsonianBrowseCategory.input.parse({ mode: 'period', value: '1234s' });
    const err = await smithsonianBrowseCategory.handler(input, ctx).catch((e) => e);

    expect(err.data?.reason).toBe('invalid_category');
    expect(recoveryHint(err)).toContain(
      'smithsonian_list_terms { field: "date", contains: "1234s" }',
    );
  });

  it.each([['1940'], ['40s'], ['1940S'], ['1940-1949'], ['nineteen forties']])(
    'rejects period value %s at the schema boundary (issue #31)',
    (value) => {
      // `value` is polymorphic across the four modes, so the decade format can't be a
      // field-level .regex() — it is validated on the input object for period only. A
      // malformed value is rejected before it reaches upstream as a guaranteed-zero query.
      const parsed = smithsonianBrowseCategory.input.safeParse({ mode: 'period', value });
      expect(parsed.success).toBe(false);
      const issue = parsed.error?.issues[0];
      expect(issue?.path).toEqual(['value']);
      expect(issue?.message).toContain('NNNNs');
    },
  );

  it('accepts a well-formed decade and leaves the other modes unconstrained (issue #31)', () => {
    expect(
      smithsonianBrowseCategory.input.safeParse({ mode: 'period', value: '1860s' }).success,
    ).toBe(true);
    // Only period carries the decade shape — a museum code or object type may look like
    // anything the vocabulary contains.
    for (const mode of ['museum', 'culture', 'medium'] as const) {
      expect(smithsonianBrowseCategory.input.safeParse({ mode, value: '1940' }).success).toBe(true);
    }
  });

  it('embeds culture filter in q for culture mode', async () => {
    const searchFn = vi.fn().mockResolvedValue({ rows: makeSamples(1), rowCount: 1 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext();
    const input = smithsonianBrowseCategory.input.parse({
      mode: 'culture',
      value: 'Plains Indian',
    });
    await smithsonianBrowseCategory.handler(input, ctx);

    const calledParams = searchFn.mock.calls[0]?.[0] as { filters: string[]; query: string };
    // Multi-word culture value must be quoted in the Lucene term
    expect(calledParams.filters).toContain('culture:"Plains Indian"');
    // Culture mode uses filter only — no free-text query
    expect(calledParams.query).toBe('');
  });

  it('embeds date filter in q for period mode', async () => {
    const searchFn = vi.fn().mockResolvedValue({ rows: makeSamples(1), rowCount: 1 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext();
    const input = smithsonianBrowseCategory.input.parse({ mode: 'period', value: '1940s' });
    await smithsonianBrowseCategory.handler(input, ctx);

    const calledParams = searchFn.mock.calls[0]?.[0] as { filters: string[]; query: string };
    expect(calledParams.filters).toContain('date:1940s');
    expect(calledParams.query).toBe('');
  });

  it('passes unit_code filter and empty query for museum mode', async () => {
    const searchFn = vi.fn().mockResolvedValue({ rows: makeSamples(3), rowCount: 150 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext();
    const input = smithsonianBrowseCategory.input.parse({ mode: 'museum', value: 'NASM' });
    await smithsonianBrowseCategory.handler(input, ctx);

    const calledParams = searchFn.mock.calls[0]?.[0] as { filters: string[]; query: string };
    expect(calledParams.filters).toContain('unit_code:NASM');
    // Museum mode uses the filter only — no free-text query
    expect(calledParams.query).toBe('');
  });

  it.each([
    ['NMNHBIRDS', 'a code longer than the old 8-character gate'],
    ['CFCHFOLKLIFE', 'the longest live code'],
    ['OCIO_DPO3D', 'underscore and digit — rejected by the old letters-only regex'],
    ['OFEO-SG', 'a hyphenated code'],
    ['SI', 'the shortest live code'],
  ])('museum mode filters on %s verbatim — %s (issue #26)', async (code) => {
    const searchFn = vi.fn().mockResolvedValue({ rows: makeSamples(2), rowCount: 20 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    const input = smithsonianBrowseCategory.input.parse({ mode: 'museum', value: code });
    await smithsonianBrowseCategory.handler(input, ctx);

    const calledParams = searchFn.mock.calls[0]?.[0] as { filters: string[]; query: string };
    expect(calledParams.filters).toEqual([`unit_code:${code}`]);
    expect(calledParams.query).toBe('');
  });

  it('preserves unit_code case — NMAfA must not be folded to NMAFA (issue #26)', async () => {
    // EDAN matches unit_code case-sensitively: unit_code:NMAFA returns nothing.
    const searchFn = vi.fn().mockResolvedValue({ rows: makeSamples(1), rowCount: 113 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext();
    const input = smithsonianBrowseCategory.input.parse({ mode: 'museum', value: 'NMAfA' });
    await smithsonianBrowseCategory.handler(input, ctx);

    const calledParams = searchFn.mock.calls[0]?.[0] as { filters: string[]; query: string };
    expect(calledParams.filters).toEqual(['unit_code:NMAfA']);
  });

  it('a full museum name is filtered, never free-texted, and fails with museum recovery (issues #26, #31)', async () => {
    // Previously a full name fell through to a free-text search whose 1.7M-hit count was
    // reported as the museum's total_count. It must reach the invalid_category contract
    // instead, whose museum-mode recovery names the smithsonian_list_terms unit_code call.
    const searchFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    const input = smithsonianBrowseCategory.input.parse({
      mode: 'museum',
      value: 'National Museum of Natural History',
    });
    const err = await smithsonianBrowseCategory.handler(input, ctx).catch((e) => e);

    // #31: a zero-match browse is invalid_category (ValidationError), not no_results.
    expect(err.data?.reason).toBe('invalid_category');
    // A museum name can't be a `contains` substring of any code, so the hint names the
    // unfiltered vocabulary rather than a call that returns an empty term list.
    const hint = recoveryHint(err);
    expect(hint).toContain('smithsonian_list_terms { field: "unit_code" }');
    expect(hint).not.toContain('contains:');

    // #26: the value is filtered as one quoted phrase term, never free-texted. Unquoted,
    // EDAN parses the trailing words as free text and matches ~1.7M records.
    const calledParams = searchFn.mock.calls[0]?.[0] as { filters: string[]; query: string };
    expect(calledParams.query).toBe('');
    expect(calledParams.filters).toEqual(['unit_code:"National Museum of Natural History"']);
  });

  it('keeps the contains substring in the museum hint for a spaceless code (issue #31)', async () => {
    // A mistyped or partial code IS resolvable by substring — every live unit_code is
    // space-free, so `contains` only dead-ends on the museum-name shape handled above.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    const input = smithsonianBrowseCategory.input.parse({ mode: 'museum', value: 'NMNH' });
    const err = await smithsonianBrowseCategory.handler(input, ctx).catch((e) => e);

    expect(err.data?.reason).toBe('invalid_category');
    expect(recoveryHint(err)).toContain(
      'smithsonian_list_terms { field: "unit_code", contains: "NMNH" }',
    );
  });

  it('non-truncated result validates against the effective output schema (issue #13)', async () => {
    // sample_objects.length === rowCount, so no truncation enrichment is written.
    // The framework validates output.extend(enrichment); required-but-unpopulated
    // enrichment fields (the pre-fix contract) threw on this path.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: makeSamples(3), rowCount: 3 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    const input = smithsonianBrowseCategory.input.parse({
      mode: 'museum',
      value: 'NASM',
      rows: 10,
    });
    const result = await smithsonianBrowseCategory.handler(input, ctx);

    const effectiveOutput = smithsonianBrowseCategory.output.extend(
      smithsonianBrowseCategory.enrichment!,
    );
    expect(() => effectiveOutput.parse(result)).not.toThrow();
  });

  it('defaults start to 0 and forwards it to the service (issue #24)', async () => {
    const searchFn = vi.fn().mockResolvedValue({ rows: makeSamples(3), rowCount: 150 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    await smithsonianBrowseCategory.handler(
      smithsonianBrowseCategory.input.parse({ mode: 'medium', value: 'Paintings' }),
      ctx,
    );
    expect(searchFn.mock.calls[0]?.[0]).toMatchObject({ start: 0 });

    await smithsonianBrowseCategory.handler(
      smithsonianBrowseCategory.input.parse({ mode: 'medium', value: 'Paintings', start: 25 }),
      ctx,
    );
    // The offset must reach upstream — it was hard-coded to 0 before this input existed.
    expect(searchFn.mock.calls[1]?.[0]).toMatchObject({ start: 25 });
  });

  it('pages contiguously — page(0,5) ++ page(5,5) equals page(0,10) by record_id (issue #24)', async () => {
    // Reconstruction is the load-bearing proof: a "page 2 differs from page 1" check
    // also passes when a gap silently drops objects. Upstream is modelled as a stable
    // ordered sequence sliced by start/rows, which the live API was verified to be.
    const fullSeq: ObjectSummary[] = Array.from({ length: 40 }, (_, i) => ({
      record_id: `nmai_SEQ${String(i + 1).padStart(3, '0')}`,
      title: `Painting ${i + 1}`,
      unit_code: 'NMAI',
      museum_name: 'National Museum of the American Indian',
      is_cc0: true,
      has_media: false,
    }));
    const searchFn = vi.fn().mockImplementation((params: { rows: number; start: number }) =>
      Promise.resolve({
        rows: fullSeq.slice(params.start, params.start + params.rows),
        rowCount: fullSeq.length,
      }),
    );
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    const page1 = await smithsonianBrowseCategory.handler(
      smithsonianBrowseCategory.input.parse({
        mode: 'medium',
        value: 'Paintings',
        rows: 5,
        start: 0,
      }),
      ctx,
    );
    const page2 = await smithsonianBrowseCategory.handler(
      smithsonianBrowseCategory.input.parse({
        mode: 'medium',
        value: 'Paintings',
        rows: 5,
        start: 5,
      }),
      ctx,
    );
    const both = await smithsonianBrowseCategory.handler(
      smithsonianBrowseCategory.input.parse({
        mode: 'medium',
        value: 'Paintings',
        rows: 10,
        start: 0,
      }),
      ctx,
    );

    const ids1 = page1.sample_objects.map((o) => o.record_id);
    const ids2 = page2.sample_objects.map((o) => o.record_id);
    expect([...ids1, ...ids2]).toEqual(both.sample_objects.map((o) => o.record_id));
    // Gap-free and overlap-free, not merely distinct.
    expect(ids1).not.toEqual(ids2);
  });

  it('returns a successful empty page when start is past the end, not invalid_category (issue #24)', async () => {
    // Adding `start` newly makes a past-the-end page reachable — the defect class #29
    // fixes in smithsonian_search_objects. The guard must read the true rowCount, so a
    // caller is never told to fix a category value that was already correct.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: [], rowCount: 11129 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    const input = smithsonianBrowseCategory.input.parse({
      mode: 'medium',
      value: 'Paintings',
      start: 20000,
    });
    const result = await smithsonianBrowseCategory.handler(input, ctx);

    expect(result.sample_objects).toEqual([]);
    expect(result.total_count).toBe(11129);
    expect(result.museum_breakdown).toEqual([]);
  });

  it('still errors when the category genuinely matches nothing, even at a deep start (issues #24, #31)', async () => {
    // rowCount === 0 is a real zero-match (unusable category value), distinct from a
    // past-the-end empty page (rowCount > 0). A deep start must not mask it as a
    // successful empty page — it stays invalid_category.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    const input = smithsonianBrowseCategory.input.parse({
      mode: 'medium',
      value: 'Painting',
      start: 500,
    });
    await expect(smithsonianBrowseCategory.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_category' },
    });
  });

  it('does not report truncated on the true last page or past the end (issue #24)', async () => {
    // start(10) + shown(2) === rowCount(12). The page-local trigger misfires here on
    // every page but the first, because a last page is always shorter than the total.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: makeSamples(2), rowCount: 12 }),
    } as unknown as svcModule.SmithsonianService);

    const lastPageCtx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    await smithsonianBrowseCategory.handler(
      smithsonianBrowseCategory.input.parse({
        mode: 'medium',
        value: 'Paintings',
        rows: 10,
        start: 10,
      }),
      lastPageCtx,
    );
    expect(getEnrichment(lastPageCtx).truncated).toBeUndefined();

    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: [], rowCount: 12 }),
    } as unknown as svcModule.SmithsonianService);
    const pastEndCtx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    await smithsonianBrowseCategory.handler(
      smithsonianBrowseCategory.input.parse({
        mode: 'medium',
        value: 'Paintings',
        rows: 10,
        start: 9999,
      }),
      pastEndCtx,
    );
    expect(getEnrichment(pastEndCtx).truncated).toBeUndefined();
  });

  it('still reports truncated when objects remain past the page (issue #24)', async () => {
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: makeSamples(10), rowCount: 11129 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    await smithsonianBrowseCategory.handler(
      smithsonianBrowseCategory.input.parse({
        mode: 'medium',
        value: 'Paintings',
        rows: 10,
        start: 20,
      }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(10);
    expect(enrichment.truncationCeiling).toBe(11129);
  });

  it('explore truncation guidance names start and survives the enrichment schema (issue #23)', async () => {
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: makeSamples(10), rowCount: 11129 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    const result = await smithsonianBrowseCategory.handler(
      smithsonianBrowseCategory.input.parse({ mode: 'medium', value: 'Paintings', rows: 10 }),
      ctx,
    );

    const effectiveOutput = smithsonianBrowseCategory.output.extend(
      smithsonianBrowseCategory.enrichment!,
    );
    const onTheWire = effectiveOutput.parse({ ...result, ...getEnrichment(ctx) });
    expect(onTheWire.notice).toContain('start');
    expect(onTheWire.notice).not.toBe(
      'Results capped at 10; showing 10. Raise the cap or narrow with filters.',
    );
  });

  it('describes sample_objects as the requested page, not the first page (issue #24)', () => {
    // The sample is page-relative once start exists; the shipped descriptions are the
    // whole change here, so they are asserted directly.
    const schema = z.toJSONSchema(smithsonianBrowseCategory.output) as {
      properties: { sample_objects: { description?: string } };
    };
    const description = schema.properties.sample_objects.description ?? '';
    expect(description).not.toMatch(/first page/i);
    expect(description).toMatch(/requested page/i);
    expect(smithsonianBrowseCategory.description).not.toMatch(/first page/i);
  });

  it('format renders mode, value, total_count, and sample record_ids', () => {
    const output = {
      mode: 'culture',
      value: 'Aztecs',
      total_count: 500,
      sample_objects: makeSamples(2).map((o) => ({
        record_id: o.record_id,
        title: o.title,
        unit_code: o.unit_code,
        is_cc0: o.is_cc0,
      })),
      museum_breakdown: [
        { unit_code: 'NASM', museum_name: 'National Air and Space Museum', count: 2 },
      ],
    };
    const blocks = smithsonianBrowseCategory.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('culture');
    expect(text).toContain('Aztecs');
    expect(text).toContain('500');
    expect(text).toContain('nasm_TEST001');
    expect(text).toContain('NASM');
  });
});
