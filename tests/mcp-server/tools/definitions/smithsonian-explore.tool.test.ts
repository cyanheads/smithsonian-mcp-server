/**
 * @fileoverview Tests for smithsonian_explore tool.
 * @module tests/mcp-server/tools/definitions/smithsonian-explore.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { smithsonianExplore } from '@/mcp-server/tools/definitions/smithsonian-explore.tool.js';
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

describe('smithsonianExplore', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns overview for museum mode', async () => {
    const searchFn = vi.fn().mockResolvedValue({ rows: makeSamples(3), rowCount: 150 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianExplore.errors });
    const input = smithsonianExplore.input.parse({ mode: 'museum', value: 'NASM' });
    const result = await smithsonianExplore.handler(input, ctx);

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

    const ctx = createMockContext({ errors: smithsonianExplore.errors });
    const input = smithsonianExplore.input.parse({ mode: 'culture', value: 'Aztecs' });
    const result = await smithsonianExplore.handler(input, ctx);

    expect(result.museum_breakdown.length).toBeGreaterThan(0);
    // Should list both codes carried by the mock rows
    const unitCodes = result.museum_breakdown.map((m) => m.unit_code);
    expect(unitCodes).toContain('NASM');
    expect(unitCodes).toContain('NMNHBIRDS');
  });

  it('throws no_results when search returns empty', async () => {
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianExplore.errors });
    const input = smithsonianExplore.input.parse({ mode: 'medium', value: 'NonexistentMedium' });
    const expectedHint = smithsonianExplore.errors?.find(
      (e) => e.reason === 'no_results',
    )?.recovery;
    await expect(smithsonianExplore.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results', recovery: { hint: expectedHint } },
    });
  });

  it('embeds culture filter in q for culture mode', async () => {
    const searchFn = vi.fn().mockResolvedValue({ rows: makeSamples(1), rowCount: 1 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext();
    const input = smithsonianExplore.input.parse({ mode: 'culture', value: 'Plains Indian' });
    await smithsonianExplore.handler(input, ctx);

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
    const input = smithsonianExplore.input.parse({ mode: 'period', value: '1940s' });
    await smithsonianExplore.handler(input, ctx);

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
    const input = smithsonianExplore.input.parse({ mode: 'museum', value: 'NASM' });
    await smithsonianExplore.handler(input, ctx);

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

    const ctx = createMockContext({ errors: smithsonianExplore.errors });
    const input = smithsonianExplore.input.parse({ mode: 'museum', value: code });
    await smithsonianExplore.handler(input, ctx);

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
    const input = smithsonianExplore.input.parse({ mode: 'museum', value: 'NMAfA' });
    await smithsonianExplore.handler(input, ctx);

    const calledParams = searchFn.mock.calls[0]?.[0] as { filters: string[]; query: string };
    expect(calledParams.filters).toEqual(['unit_code:NMAfA']);
  });

  it('a full museum name is filtered, never free-texted, and fails actionably (issue #26)', async () => {
    // Previously a full name fell through to a free-text search whose 1.7M-hit count
    // was reported as the museum's total_count. It must reach the no_results contract
    // instead, whose recovery already points at smithsonian_list_terms.
    const searchFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianExplore.errors });
    const input = smithsonianExplore.input.parse({
      mode: 'museum',
      value: 'National Museum of Natural History',
    });
    const expectedHint = smithsonianExplore.errors?.find(
      (e) => e.reason === 'no_results',
    )?.recovery;

    await expect(smithsonianExplore.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results', recovery: { hint: expectedHint } },
    });

    const calledParams = searchFn.mock.calls[0]?.[0] as { filters: string[]; query: string };
    expect(calledParams.query).toBe('');
    // Quoted as one phrase term. Unquoted, EDAN parses the trailing words as free text
    // and the query matches ~1.7M records across the catalog.
    expect(calledParams.filters).toEqual(['unit_code:"National Museum of Natural History"']);
  });

  it('non-truncated result validates against the effective output schema (issue #13)', async () => {
    // sample_objects.length === rowCount, so no truncation enrichment is written.
    // The framework validates output.extend(enrichment); required-but-unpopulated
    // enrichment fields (the pre-fix contract) threw on this path.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: makeSamples(3), rowCount: 3 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianExplore.errors });
    const input = smithsonianExplore.input.parse({ mode: 'museum', value: 'NASM', rows: 10 });
    const result = await smithsonianExplore.handler(input, ctx);

    const effectiveOutput = smithsonianExplore.output.extend(smithsonianExplore.enrichment!);
    expect(() => effectiveOutput.parse(result)).not.toThrow();
  });

  it('defaults start to 0 and forwards it to the service (issue #24)', async () => {
    const searchFn = vi.fn().mockResolvedValue({ rows: makeSamples(3), rowCount: 150 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianExplore.errors });
    await smithsonianExplore.handler(
      smithsonianExplore.input.parse({ mode: 'medium', value: 'Paintings' }),
      ctx,
    );
    expect(searchFn.mock.calls[0]?.[0]).toMatchObject({ start: 0 });

    await smithsonianExplore.handler(
      smithsonianExplore.input.parse({ mode: 'medium', value: 'Paintings', start: 25 }),
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

    const ctx = createMockContext({ errors: smithsonianExplore.errors });
    const page1 = await smithsonianExplore.handler(
      smithsonianExplore.input.parse({ mode: 'medium', value: 'Paintings', rows: 5, start: 0 }),
      ctx,
    );
    const page2 = await smithsonianExplore.handler(
      smithsonianExplore.input.parse({ mode: 'medium', value: 'Paintings', rows: 5, start: 5 }),
      ctx,
    );
    const both = await smithsonianExplore.handler(
      smithsonianExplore.input.parse({ mode: 'medium', value: 'Paintings', rows: 10, start: 0 }),
      ctx,
    );

    const ids1 = page1.sample_objects.map((o) => o.record_id);
    const ids2 = page2.sample_objects.map((o) => o.record_id);
    expect([...ids1, ...ids2]).toEqual(both.sample_objects.map((o) => o.record_id));
    // Gap-free and overlap-free, not merely distinct.
    expect(ids1).not.toEqual(ids2);
  });

  it('returns a successful empty page when start is past the end, not no_results (issue #24)', async () => {
    // Adding `start` newly makes a past-the-end page reachable — the defect class #29
    // fixes in smithsonian_search. The guard must read the true rowCount, so a caller
    // is never told to fix a category value that was already correct.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: [], rowCount: 11129 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianExplore.errors });
    const input = smithsonianExplore.input.parse({
      mode: 'medium',
      value: 'Paintings',
      start: 20000,
    });
    const result = await smithsonianExplore.handler(input, ctx);

    expect(result.sample_objects).toEqual([]);
    expect(result.total_count).toBe(11129);
    expect(result.museum_breakdown).toEqual([]);
  });

  it('still throws no_results when the category genuinely matches nothing (issue #24)', async () => {
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianExplore.errors });
    const input = smithsonianExplore.input.parse({
      mode: 'medium',
      value: 'Painting',
      start: 500,
    });
    await expect(smithsonianExplore.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results' },
    });
  });

  it('does not report truncated on the true last page or past the end (issue #24)', async () => {
    // start(10) + shown(2) === rowCount(12). The page-local trigger misfires here on
    // every page but the first, because a last page is always shorter than the total.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: makeSamples(2), rowCount: 12 }),
    } as unknown as svcModule.SmithsonianService);

    const lastPageCtx = createMockContext({ errors: smithsonianExplore.errors });
    await smithsonianExplore.handler(
      smithsonianExplore.input.parse({
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
    const pastEndCtx = createMockContext({ errors: smithsonianExplore.errors });
    await smithsonianExplore.handler(
      smithsonianExplore.input.parse({
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

    const ctx = createMockContext({ errors: smithsonianExplore.errors });
    await smithsonianExplore.handler(
      smithsonianExplore.input.parse({ mode: 'medium', value: 'Paintings', rows: 10, start: 20 }),
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

    const ctx = createMockContext({ errors: smithsonianExplore.errors });
    const result = await smithsonianExplore.handler(
      smithsonianExplore.input.parse({ mode: 'medium', value: 'Paintings', rows: 10 }),
      ctx,
    );

    const effectiveOutput = smithsonianExplore.output.extend(smithsonianExplore.enrichment!);
    const onTheWire = effectiveOutput.parse({ ...result, ...getEnrichment(ctx) });
    expect(onTheWire.notice).toContain('start');
    expect(onTheWire.notice).not.toBe(
      'Results capped at 10; showing 10. Raise the cap or narrow with filters.',
    );
  });

  it('describes sample_objects as the requested page, not the first page (issue #24)', () => {
    // The sample is page-relative once start exists; the shipped descriptions are the
    // whole change here, so they are asserted directly.
    const schema = z.toJSONSchema(smithsonianExplore.output) as {
      properties: { sample_objects: { description?: string } };
    };
    const description = schema.properties.sample_objects.description ?? '';
    expect(description).not.toMatch(/first page/i);
    expect(description).toMatch(/requested page/i);
    expect(smithsonianExplore.description).not.toMatch(/first page/i);
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
    const blocks = smithsonianExplore.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('culture');
    expect(text).toContain('Aztecs');
    expect(text).toContain('500');
    expect(text).toContain('nasm_TEST001');
    expect(text).toContain('NASM');
  });
});
