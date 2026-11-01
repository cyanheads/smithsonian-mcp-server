/**
 * @fileoverview Tests for smithsonian_browse_category tool.
 * @module tests/mcp-server/tools/definitions/smithsonian-browse-category.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createInMemoryStorage,
  createMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadClampSwitch } from '@/config/server-config.js';
import { smithsonianBrowseCategory } from '@/mcp-server/tools/definitions/smithsonian-browse-category.tool.js';
import * as svcModule from '@/services/smithsonian/smithsonian-service.js';
import type { ObjectSummary, TermDescription } from '@/services/smithsonian/types.js';
import { luceneTermsOf } from './tool-result.js';

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
 * Stand in for the service on the zero-match path, where the handler consults the
 * term vocabulary to tell an unresolvable category value from a resolvable one
 * (issue #33) and to find a substring that lists other terms (issue #46). `term`
 * is the answer that lookup returns; passing it explicitly keeps every zero-match
 * test on a deliberate branch rather than on the best-effort catch that a missing
 * method would otherwise fall into.
 */
function makeZeroMatchService(
  search: ReturnType<typeof vi.fn>,
  term: TermDescription | Error = { indexed: false },
): svcModule.SmithsonianService {
  const describeTerm =
    term instanceof Error ? vi.fn().mockRejectedValue(term) : vi.fn().mockResolvedValue(term);
  return { search, describeTerm } as unknown as svcModule.SmithsonianService;
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
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(
      makeZeroMatchService(vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })),
    );

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
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(makeZeroMatchService(searchFn));

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
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(makeZeroMatchService(searchFn));

    const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    const input = smithsonianBrowseCategory.input.parse({ mode: 'medium', value: 'Painting' });
    const err = await smithsonianBrowseCategory.handler(input, ctx).catch((e) => e);

    expect(err.data?.reason).toBe('invalid_category');
    expect(recoveryHint(err)).toContain('smithsonian_search_objects { query: "Painting" }');
  });

  it('throws invalid_category with the culture-mode recovery hint on a true zero-match (issue #31)', async () => {
    const searchFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(makeZeroMatchService(searchFn));

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
    // A value shaped like an indexed term that simply isn't one — the hint carries
    // the resolution step.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(
      makeZeroMatchService(vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })),
    );

    const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    const input = smithsonianBrowseCategory.input.parse({ mode: 'period', value: '1234s' });
    const err = await smithsonianBrowseCategory.handler(input, ctx).catch((e) => e);

    expect(err.data?.reason).toBe('invalid_category');
    expect(recoveryHint(err)).toContain(
      'smithsonian_list_terms { field: "date", contains: "1234s" }',
    );
  });

  it.each([['500-1500'], ['-2500'], ['BCE 1000s'], ['21st century'], ['999-700 BC'], ['300s']])(
    'accepts the non-decade period value %s and applies it as a date term (issue #36)',
    async (value) => {
      // 128 of the 201 indexed `date` terms are not decade-shaped. The former "NNNNs"
      // gate rejected every one of them before the value could reach upstream.
      const searchFn = vi.fn().mockResolvedValue({ rows: makeSamples(1), rowCount: 1 });
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
        search: searchFn,
      } as unknown as svcModule.SmithsonianService);

      const parsed = smithsonianBrowseCategory.input.safeParse({ mode: 'period', value });
      expect(parsed.success).toBe(true);

      const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
      await smithsonianBrowseCategory.handler(
        smithsonianBrowseCategory.input.parse({ mode: 'period', value }),
        ctx,
      );

      // Always quoted (issue #42) — an unquoted single-token value is parsed for
      // Lucene syntax, so quoting is not conditional on the value containing a space.
      expect(luceneTermsOf(searchFn)).toContain(`date:"${value}"`);
    },
  );

  it('leaves every mode unconstrained in shape (issue #36)', () => {
    for (const mode of ['museum', 'culture', 'period', 'medium', 'topic'] as const) {
      expect(smithsonianBrowseCategory.input.safeParse({ mode, value: '1940' }).success).toBe(true);
    }
    expect(
      smithsonianBrowseCategory.input.safeParse({ mode: 'period', value: '1860s' }).success,
    ).toBe(true);
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

    const calledParams = searchFn.mock.calls[0]?.[0] as { query: string };
    // Multi-word culture value must be quoted in the Lucene term
    expect(luceneTermsOf(searchFn)).toContain('culture:"Plains Indian"');
    // Culture mode uses filter only — no free-text query
    expect(calledParams.query).toBe('');
  });

  it('embeds topic filter in q for topic mode', async () => {
    const searchFn = vi.fn().mockResolvedValue({ rows: makeSamples(2), rowCount: 1134 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    const input = smithsonianBrowseCategory.input.parse({ mode: 'topic', value: 'Quilts' });
    const result = await smithsonianBrowseCategory.handler(input, ctx);

    const calledParams = searchFn.mock.calls[0]?.[0] as { query: string };
    // Always quoted, so a topic term carrying a `"` (80 of the 133k do) stays one
    // literal term rather than closing the phrase early.
    expect(luceneTermsOf(searchFn)).toEqual(['topic:"Quilts"']);
    expect(calledParams.query).toBe('');
    expect(result.mode).toBe('topic');
    expect(result.total_count).toBe(1134);
    // topic is not museum mode, so the page breakdown is computed.
    expect(result.museum_breakdown.length).toBeGreaterThan(0);
  });

  it('embeds date filter in q for period mode', async () => {
    const searchFn = vi.fn().mockResolvedValue({ rows: makeSamples(1), rowCount: 1 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext();
    const input = smithsonianBrowseCategory.input.parse({ mode: 'period', value: '1940s' });
    await smithsonianBrowseCategory.handler(input, ctx);

    const calledParams = searchFn.mock.calls[0]?.[0] as { query: string };
    expect(luceneTermsOf(searchFn)).toContain('date:"1940s"');
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

    const calledParams = searchFn.mock.calls[0]?.[0] as { query: string };
    expect(luceneTermsOf(searchFn)).toContain('unit_code:"NASM"');
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

    const calledParams = searchFn.mock.calls[0]?.[0] as { query: string };
    expect(luceneTermsOf(searchFn)).toEqual([`unit_code:"${code}"`]);
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

    expect(luceneTermsOf(searchFn)).toEqual(['unit_code:"NMAfA"']);
  });

  it('a full museum name is filtered, never free-texted, and fails with museum recovery (issues #26, #31)', async () => {
    // Previously a full name fell through to a free-text search whose 1.7M-hit count was
    // reported as the museum's total_count. It must reach the invalid_category contract
    // instead, whose museum-mode recovery names the smithsonian_list_terms unit_code call.
    const searchFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(makeZeroMatchService(searchFn));

    const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    const input = smithsonianBrowseCategory.input.parse({
      mode: 'museum',
      value: 'National Museum of Natural History',
    });
    const err = await smithsonianBrowseCategory.handler(input, ctx).catch((e) => e);

    // #31: a zero-match browse is invalid_category (ValidationError), not no_results.
    expect(err.data?.reason).toBe('invalid_category');
    // #37: `contains` now matches each code's museum name as well as the code, so a
    // museum name resolves through the same filtered call any other value takes —
    // the hint no longer needs to route this shape to the unfiltered 48-code list.
    const hint = recoveryHint(err);
    expect(hint).toContain(
      'smithsonian_list_terms { field: "unit_code", contains: "National Museum of Natural History" }',
    );
    expect(hint).toContain('museum names');

    // #26: the value is filtered as one quoted phrase term, never free-texted. Unquoted,
    // EDAN parses the trailing words as free text and matches ~1.7M records.
    const calledParams = searchFn.mock.calls[0]?.[0] as { query: string };
    expect(calledParams.query).toBe('');
    expect(luceneTermsOf(searchFn)).toEqual(['unit_code:"National Museum of Natural History"']);
  });

  it('keeps the contains substring in the museum hint for a spaceless code (issue #31)', async () => {
    // A mistyped or partial code IS resolvable by substring — every live unit_code is
    // space-free, so `contains` only dead-ends on the museum-name shape handled above.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(
      makeZeroMatchService(vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })),
    );

    const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    const input = smithsonianBrowseCategory.input.parse({ mode: 'museum', value: 'NMNH' });
    const err = await smithsonianBrowseCategory.handler(input, ctx).catch((e) => e);

    expect(err.data?.reason).toBe('invalid_category');
    expect(recoveryHint(err)).toContain(
      'smithsonian_list_terms { field: "unit_code", contains: "NMNH" }',
    );
  });

  describe('indexed-but-empty category values (issue #33)', () => {
    /**
     * Both branches of the same zero match, per mode. `indexed: true` is a value the
     * vocabulary enumerates: `smithsonian_list_terms` hands it straight back, so a
     * hint telling the caller to resolve it there loops them through the identical
     * failing call. `indexed: false` is the resolvable case that hint was written for.
     */
    it.each([
      ['museum', 'FSA', 'unit_code', 'indexed Smithsonian unit code'],
      ['culture', 'Guiana', 'culture', 'indexed culture term'],
      ['period', '1210s', 'date', 'indexed date term'],
      ['topic', 'Quilts', 'topic', 'indexed topic term'],
    ] as const)(
      '%s mode: an indexed value is named as empty, not as unresolvable',
      async (mode, value, field, claim) => {
        const describeTerm = vi.fn().mockResolvedValue({ indexed: true });
        vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
          search: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
          describeTerm,
        } as unknown as svcModule.SmithsonianService);

        const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
        const input = smithsonianBrowseCategory.input.parse({ mode, value });
        const err = await smithsonianBrowseCategory.handler(input, ctx).catch((e) => e);

        expect(err.data?.reason).toBe('invalid_category');
        const hint = recoveryHint(err);
        expect(hint).toContain(claim);
        expect(hint).toContain('matches no retrievable objects');
        // The dead-end the old hint produced: "resolve it, then browse again".
        expect(hint).not.toContain('then browse again with the exact value');
        // No neighbor substring exists here, so the hint must not name a contains
        // search at all — least of all one carrying the failing value (issue #46).
        expect(hint).not.toContain('contains:');
        // Routed somewhere that can succeed instead of back into the same call.
        expect(hint).toContain('smithsonian_search_objects');
        // culture and topic state why no substring is named, and the sentence claims
        // only what the search establishes. It is capped at MAX_NEIGHBOR_PROBES
        // scans, so it can stop with fragments untried (#47); and a fragment over
        // MAX_NEIGHBOR_TERMS is discarded, so a value reaching this branch may have
        // found one and had it rejected as too broad (#48). Either way what is true
        // is that no NARROW set was found — not that no fragment resolved at all.
        if (mode === 'culture' || mode === 'topic') {
          expect(hint).toContain(
            `a bounded search of its fragments found no narrow set of other ${mode} terms to browse`,
          );
          expect(hint).not.toMatch(/no fragment of it/i);
          expect(hint).not.toMatch(/found no different/i);
        }
        // The membership test runs against the mode's own indexed field.
        expect(describeTerm).toHaveBeenCalledWith(field, value, ctx);
      },
    );

    it.each([
      ['culture', 'Guiana, French', { contains: 'Guiana', count: 17 }, '17 other culture terms'],
      [
        'topic',
        'Bell UH-1H Iroquois "Huey" Smokey III',
        { contains: 'Bell UH-1', count: 2 },
        '2 other topic terms',
      ],
      ['topic', 'Quilts--History', { contains: 'Quilts', count: 1 }, 'the one other topic term'],
    ] as const)(
      '%s mode: an indexed value with neighbors routes to the proven substring (issue #46)',
      async (mode, value, neighbors, claim) => {
        vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(
          makeZeroMatchService(vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), {
            indexed: true,
            neighbors,
          }),
        );

        const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
        const input = smithsonianBrowseCategory.input.parse({ mode, value });
        const err = await smithsonianBrowseCategory.handler(input, ctx).catch((e) => e);

        const hint = recoveryHint(err);
        expect(hint).toContain(`contains: "${neighbors.contains}"`);
        expect(hint).toContain(claim);
        // The substring is the service's, never the failing value echoed back.
        expect(hint).not.toContain(`contains: "${value}"`);
      },
    );

    it.each([
      ['museum', 'FSA', 'unit_code'],
      ['period', '1210s', 'date'],
    ] as const)(
      '%s mode routes to the unfiltered vocabulary, with or without neighbors',
      async (mode, value, field) => {
        // Both vocabularies are small enough to list whole (48 unit codes, ~200 date
        // terms), so neither branch ever depended on a substring — a neighbor answer
        // must not introduce one.
        vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(
          makeZeroMatchService(vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), {
            indexed: true,
            neighbors: { contains: value.slice(0, 2), count: 5 },
          }),
        );

        const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
        const input = smithsonianBrowseCategory.input.parse({ mode, value });
        const err = await smithsonianBrowseCategory.handler(input, ctx).catch((e) => e);

        const hint = recoveryHint(err);
        expect(hint).toContain(`smithsonian_list_terms { field: "${field}" }`);
        expect(hint).not.toContain('contains:');
      },
    );

    it.each([
      ['museum', 'NOTACODE', 'is not an exact Smithsonian unit code'],
      ['culture', 'Guianaa', 'is not an exact culture term'],
      ['period', '1210s', 'matched no indexed date term'],
      ['topic', 'Quiltss', 'is not an exact topic term'],
    ] as const)(
      '%s mode: a value outside the vocabulary still gets the resolve-it hint',
      async (mode, value, claim) => {
        vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(
          makeZeroMatchService(vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), {
            indexed: false,
          }),
        );

        const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
        const input = smithsonianBrowseCategory.input.parse({ mode, value });
        const err = await smithsonianBrowseCategory.handler(input, ctx).catch((e) => e);

        const hint = recoveryHint(err);
        expect(hint).toContain(claim);
        expect(hint).toContain(`contains: "${value}"`);
        expect(hint).not.toContain('matches no retrievable objects');
      },
    );

    it('never consults the vocabulary for medium — object_type is not enumerable', async () => {
      const describeTerm = vi.fn().mockResolvedValue({ indexed: true });
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
        search: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        describeTerm,
      } as unknown as svcModule.SmithsonianService);

      const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
      const input = smithsonianBrowseCategory.input.parse({ mode: 'medium', value: 'Painting' });
      const err = await smithsonianBrowseCategory.handler(input, ctx).catch((e) => e);

      expect(describeTerm).not.toHaveBeenCalled();
      // A true answer would otherwise have flipped the hint; medium keeps its harvest.
      expect(recoveryHint(err)).toContain('smithsonian_search_objects { query: "Painting" }');
    });

    it('falls back to the resolve-it hint when the vocabulary lookup throws', async () => {
      // The check is best-effort and failure-path only: an unreachable /terms must not
      // turn a clean invalid_category into a crash.
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(
        makeZeroMatchService(
          vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
          new Error('EDAN unavailable'),
        ),
      );

      const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
      const input = smithsonianBrowseCategory.input.parse({ mode: 'culture', value: 'Guiana' });
      const err = await smithsonianBrowseCategory.handler(input, ctx).catch((e) => e);

      expect(err.data?.reason).toBe('invalid_category');
      expect(recoveryHint(err)).toContain('is not an exact culture term');
    });
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

  it('format renders is_cc0 on both branches, matching the sibling tools (issue #45)', () => {
    // content[] must carry the same information as structuredContent. Rendering the
    // marker only when true made is_cc0: false indistinguishable from a field the
    // renderer never covered — the one branch-asymmetric rendering in the surface.
    const [cc0Sample, restrictedSample] = makeSamples(2);
    const output = {
      mode: 'museum',
      value: 'NMAI',
      total_count: 2,
      sample_objects: [
        {
          record_id: cc0Sample!.record_id,
          title: cc0Sample!.title,
          unit_code: cc0Sample!.unit_code,
          is_cc0: true,
        },
        {
          record_id: restrictedSample!.record_id,
          title: restrictedSample!.title,
          unit_code: restrictedSample!.unit_code,
          is_cc0: false,
        },
      ],
      museum_breakdown: [],
    };
    const text = smithsonianBrowseCategory.format!(output)
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');

    const cc0Line = text.split('\n').find((l) => l.includes(cc0Sample!.record_id)) ?? '';
    const restrictedLine =
      text.split('\n').find((l) => l.includes(restrictedSample!.record_id)) ?? '';
    expect(cc0Line).toContain('**CC0:** Yes');
    expect(restrictedLine).toContain('**CC0:** No');
  });

  it('escapes quote- and backslash-bearing category values (issue #42)', async () => {
    // `smithsonian_list_terms` hands these back as exact, pass-through-ready terms.
    // Unescaped, the inner quote closes the phrase early and EDAN matches nothing.
    const searchFn = vi.fn().mockResolvedValue({ rows: makeSamples(1), rowCount: 3 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    await smithsonianBrowseCategory.handler(
      smithsonianBrowseCategory.input.parse({
        mode: 'culture',
        value: 'Early Iron Age, "Tomb Age"',
      }),
      ctx,
    );

    expect(luceneTermsOf(searchFn)).toEqual(['culture:"Early Iron Age, \\"Tomb Age\\""']);
  });

  it('neutralizes a wildcard category value instead of matching the whole field (issue #42)', async () => {
    // `*` is a literal term in the `place` vocabulary and appears in others. Unquoted,
    // `unit_code:*` matches every record carrying the field and reports that count as
    // the category total.
    const searchFn = vi.fn().mockResolvedValue({ rows: makeSamples(1), rowCount: 124 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
    await smithsonianBrowseCategory.handler(
      smithsonianBrowseCategory.input.parse({ mode: 'culture', value: '*' }),
      ctx,
    );

    expect(luceneTermsOf(searchFn)).toEqual(['culture:"*"']);
  });

  describe('upstream markup and entities (issue #49)', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    it('decodes sample titles in output and format() — the real service, not a stand-in', async () => {
      vi.stubEnv('SMITHSONIAN_API_KEY', 'test-key-12345');
      const body = {
        status: 200,
        responseCode: 1,
        response: {
          rows: [
            {
              id: 'ld1-markup',
              title: 'Pregnant Women&#39;s Concerns &amp; Vaccination',
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
      // Only /search is answered; any other upstream path fails loudly.
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string) => {
          if (new URL(url).pathname !== '/openaccess/api/v1.0/search') {
            throw new Error('unmocked fetch');
          }
          return {
            ok: true,
            status: 200,
            json: async () => body,
            text: async () => JSON.stringify(body),
          };
        }),
      );
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(
        new svcModule.SmithsonianService(createInMemoryStorage()),
      );

      const ctx = createMockContext({ errors: smithsonianBrowseCategory.errors });
      const input = smithsonianBrowseCategory.input.parse({ mode: 'museum', value: 'SLA_SRO' });
      const result = await smithsonianBrowseCategory.handler(input, ctx);

      expect(result.sample_objects[0]?.title).toBe("Pregnant Women's Concerns & Vaccination");
      const text = smithsonianBrowseCategory.format!(result)
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('');
      expect(text).toContain("Pregnant Women's Concerns & Vaccination");
      expect(text).not.toContain('&#39;');
      expect(text).not.toContain('&amp;');
    });
  });

  describe('page-size clamp (issue #63)', () => {
    /**
     * A category of `total` objects served the way EDAN pages it: each call returns
     * the `rows` objects from `start`, so the requests the tool sends decide what
     * comes back.
     */
    function routeCategory(total: number) {
      const search = vi
        .fn()
        .mockImplementation(async ({ rows, start }: { rows: number; start: number }) => ({
          rows: Array.from({ length: Math.max(0, Math.min(rows, total - start)) }, (_, i) => ({
            ...makeSamples(1)[0]!,
            record_id: `quilt_${start + i}`,
          })),
          rowCount: total,
        }));
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
        search,
      } as unknown as svcModule.SmithsonianService);
      return search;
    }

    /** Every text block of a result, the trailer that carries the notice included. */
    function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
      return result.content.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n');
    }

    /** The `rows` property as `tools/list` advertises it, serialized as on the wire. */
    function advertisedRows(): Record<string, unknown> {
      const schema = smithsonianBrowseCategory.input['~standard'].jsonSchema.input({
        target: 'draft-2020-12',
      }) as { properties: Record<string, unknown> };
      return JSON.parse(JSON.stringify(schema.properties.rows));
    }

    const CLAMP = 'rows 1500 exceeds the cap of 1000; the page was served with rows 1000.';

    it('serves rows 1500 at 1000 upstream and leads the paging guidance with the clamp sentence', async () => {
      const search = routeCategory(2694);

      const result = await runToolContract(smithsonianBrowseCategory, {
        mode: 'topic',
        value: 'Quilts',
        rows: 1500,
      });

      expect(result.isError).not.toBe(true);
      expect(search.mock.calls.map(([params]) => params.rows)).toEqual([1000]);
      const sc = result.structuredContent as {
        sample_objects: unknown[];
        truncated?: boolean;
        cap?: number;
        notice?: string;
      };
      expect(sc.sample_objects).toHaveLength(1000);
      expect(sc).toMatchObject({ truncated: true, cap: 1000 });
      expect(sc.notice?.startsWith(`${CLAMP} 2694 objects match this category`)).toBe(true);
      expect(sc.notice).toContain('the next page starts at 1000');
      expect(textOf(result)).toContain(CLAMP);
      expect(textOf(result)).toContain('the next page starts at 1000');
    });

    it('carries the clamp sentence alone when the clamped page holds the whole category', async () => {
      routeCategory(3);

      const result = await runToolContract(smithsonianBrowseCategory, {
        mode: 'topic',
        value: 'Quilts',
        rows: 1500,
      });

      const sc = result.structuredContent as { truncated?: boolean; notice?: string };
      expect(sc.truncated).toBeUndefined();
      expect(sc.notice).toBe(CLAMP);
      expect(textOf(result)).toContain(CLAMP);
    });

    it('serves rows 1000 as asked, with no clamp sentence', async () => {
      const search = routeCategory(2694);

      const result = await runToolContract(smithsonianBrowseCategory, {
        mode: 'topic',
        value: 'Quilts',
        rows: 1000,
      });

      expect(search.mock.calls.map(([params]) => params.rows)).toEqual([1000]);
      const sc = result.structuredContent as { cap?: number; notice?: string };
      expect(sc.cap).toBe(1000);
      expect(sc.notice).toContain('the next page starts at 1000');
      expect(sc.notice).not.toContain('exceeds the cap');
    });

    it('reaches every object exactly once when a clamped caller follows the named next start', async () => {
      const total = 2694;
      const search = routeCategory(total);
      const seen: string[] = [];
      let start = 0;
      for (let page = 0; page < 5; page++) {
        const result = await runToolContract(smithsonianBrowseCategory, {
          mode: 'topic',
          value: 'Quilts',
          rows: 1500,
          start,
        });
        const sc = result.structuredContent as {
          sample_objects: Array<{ record_id: string }>;
          truncated?: boolean;
          notice?: string;
        };
        seen.push(...sc.sample_objects.map((o) => o.record_id));
        if (!sc.truncated) break;
        const next = start + sc.sample_objects.length;
        expect(sc.notice).toContain(`the next page starts at ${next}`);
        start = next;
      }

      expect(seen).toHaveLength(total);
      expect(new Set(seen).size).toBe(total);
      expect(search.mock.calls.map(([params]) => [params.start, params.rows])).toEqual([
        [0, 1000],
        [1000, 1000],
        [2000, 1000],
      ]);
    });

    it('advertises rows with no maximum and the clamp wording by default', () => {
      const rows = advertisedRows();
      expect(rows).toMatchObject({ type: 'integer', minimum: 1, default: 10 });
      expect(rows.maximum).toBeUndefined();
      expect(rows.description).toContain('A value above 1000 is served at 1000 with a notice.');
    });

    describe('with SMITHSONIAN_CLAMP_LIMITS=false', () => {
      beforeEach(() => {
        vi.stubEnv('SMITHSONIAN_CLAMP_LIMITS', 'false');
        loadClampSwitch();
      });
      afterEach(() => {
        vi.unstubAllEnvs();
        loadClampSwitch();
      });

      it('rejects rows 1001 before any upstream call and serves rows 1000', async () => {
        const search = routeCategory(2694);

        const rejected = await runToolContract(smithsonianBrowseCategory, {
          mode: 'topic',
          value: 'Quilts',
          rows: 1001,
        });
        expect(rejected.isError).toBe(true);
        expect(rejected.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
        });
        expect(textOf(rejected)).toContain('rows');
        expect(search).not.toHaveBeenCalled();

        const served = await runToolContract(smithsonianBrowseCategory, {
          mode: 'topic',
          value: 'Quilts',
          rows: 1000,
        });
        expect(served.isError).not.toBe(true);
        expect(search.mock.calls.map(([params]) => params.rows)).toEqual([1000]);
      });

      it('advertises maximum 1000 and the strict wording', () => {
        const rows = advertisedRows();
        expect(rows).toMatchObject({ type: 'integer', maximum: 1000, default: 10 });
        expect(rows.description).toBe('Number of sample objects to return (default 10, max 1000).');
      });
    });
  });
});
