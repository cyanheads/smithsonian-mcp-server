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

  it('throws no_results when the API returns zero rows', async () => {
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianSearch.errors });
    const input = smithsonianSearch.input.parse({ query: 'xyzzy_no_results_ever' });
    await expect(smithsonianSearch.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results' },
    });
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
});
