/**
 * @fileoverview Tests for smithsonian_search tool.
 * @module tests/mcp-server/tools/definitions/smithsonian-search.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { smithsonianSearch } from '@/mcp-server/tools/definitions/smithsonian-search.tool.js';
import * as canvasModule from '@/services/canvas-accessor.js';
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
    vi.spyOn(canvasModule, 'getCanvas').mockReturnValue(undefined);
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

  it('builds filter queries from all filter fields', async () => {
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

    const calledParams = searchFn.mock.calls[0]?.[0] as { fq: string[] };
    expect(calledParams.fq).toContain('unit_code:NASM');
    expect(calledParams.fq).toContain('object_type:Aircraft');
    expect(calledParams.fq).toContain('media_usage:CC0');
    expect(calledParams.fq).toContain('online_media_type:*');
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

  it('format includes canvas_id and table_name when present', () => {
    const output = {
      objects: [makeObjectSummary()],
      total_count: 500,
      canvas_id: 'abc1234567',
      table_name: 'smithsonian_search',
    };
    const blocks = smithsonianSearch.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('abc1234567');
    expect(text).toContain('smithsonian_search');
  });
});
