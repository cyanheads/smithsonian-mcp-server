/**
 * @fileoverview Tests for smithsonian_explore tool.
 * @module tests/mcp-server/tools/definitions/smithsonian-explore.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { smithsonianExplore } from '@/mcp-server/tools/definitions/smithsonian-explore.tool.js';
import * as svcModule from '@/services/smithsonian/smithsonian-service.js';
import type { ObjectSummary } from '@/services/smithsonian/types.js';

function makeSamples(count = 3): ObjectSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    record_id: `nasm_TEST00${i + 1}`,
    title: `Object ${i + 1}`,
    unit_code: i % 2 === 0 ? 'NASM' : 'NMNH',
    museum_name:
      i % 2 === 0 ? 'National Air and Space Museum' : 'National Museum of Natural History',
    is_cc0: true,
    has_media: true,
  }));
}

describe('smithsonianExplore', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns overview for museum mode with short unit code', async () => {
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
    const input = smithsonianExplore.input.parse({ mode: 'culture', value: 'Aztec' });
    const result = await smithsonianExplore.handler(input, ctx);

    expect(result.museum_breakdown.length).toBeGreaterThan(0);
    // Should list NASM and NMNH from the mock data
    const unitCodes = result.museum_breakdown.map((m) => m.unit_code);
    expect(unitCodes).toContain('NASM');
    expect(unitCodes).toContain('NMNH');
  });

  it('throws no_results when search returns empty', async () => {
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianExplore.errors });
    const input = smithsonianExplore.input.parse({ mode: 'medium', value: 'NonexistentMedium' });
    await expect(smithsonianExplore.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results' },
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

  it('passes unit_code filter and empty query for museum mode with short code', async () => {
    const searchFn = vi.fn().mockResolvedValue({ rows: makeSamples(3), rowCount: 150 });
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext();
    const input = smithsonianExplore.input.parse({ mode: 'museum', value: 'NMNH' });
    await smithsonianExplore.handler(input, ctx);

    const calledParams = searchFn.mock.calls[0]?.[0] as { filters: string[]; query: string };
    expect(calledParams.filters).toContain('unit_code:NMNH');
    // Museum mode with short code uses filter only — no free-text query
    expect(calledParams.query).toBe('');
  });

  it('format renders mode, value, total_count, and sample record_ids', () => {
    const output = {
      mode: 'culture',
      value: 'Aztec',
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
    expect(text).toContain('Aztec');
    expect(text).toContain('500');
    expect(text).toContain('nasm_TEST001');
    expect(text).toContain('NASM');
  });
});
