/**
 * @fileoverview Tests for smithsonian_explore tool.
 * @module tests/mcp-server/tools/definitions/smithsonian-explore.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
