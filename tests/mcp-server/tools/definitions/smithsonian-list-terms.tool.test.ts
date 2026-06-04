/**
 * @fileoverview Tests for smithsonian_list_terms tool.
 * @module tests/mcp-server/tools/definitions/smithsonian-list-terms.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { smithsonianListTerms } from '@/mcp-server/tools/definitions/smithsonian-list-terms.tool.js';
import * as svcModule from '@/services/smithsonian/smithsonian-service.js';

function makeTermsResult(
  terms: Array<{ value: string; count: number }> = [],
  total = terms.length,
) {
  return { terms, total };
}

describe('smithsonianListTerms', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns terms for a valid field', async () => {
    const mockTerms = [
      { value: 'NASM', count: 100000 },
      { value: 'NMNH', count: 80000 },
    ];
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      listTerms: vi.fn().mockResolvedValue(makeTermsResult(mockTerms, 16)),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianListTerms.errors });
    const input = smithsonianListTerms.input.parse({ field: 'unit_code' });
    const result = await smithsonianListTerms.handler(input, ctx);

    expect(result.field).toBe('unit_code');
    expect(result.terms).toHaveLength(2);
    expect(result.terms[0]?.value).toBe('NASM');
    expect(result.terms[0]?.count).toBe(100000);
    expect(result.total).toBe(16);
  });

  it('passes field, start, and rows to the service', async () => {
    const listTermsFn = vi
      .fn()
      .mockResolvedValue(makeTermsResult([{ value: 'Aircraft', count: 5000 }], 200));
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      listTerms: listTermsFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianListTerms.errors });
    const input = smithsonianListTerms.input.parse({ field: 'object_type', start: 10, rows: 25 });
    await smithsonianListTerms.handler(input, ctx);

    expect(listTermsFn).toHaveBeenCalledWith({ field: 'object_type', start: 10, rows: 25 }, ctx);
  });

  it('throws no_terms when the service returns an empty list', async () => {
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      listTerms: vi.fn().mockResolvedValue(makeTermsResult([], 0)),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianListTerms.errors });
    const input = smithsonianListTerms.input.parse({ field: 'culture' });
    await expect(smithsonianListTerms.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_terms' },
    });
  });

  it('defaults start to 0 and rows to 50', async () => {
    const listTermsFn = vi
      .fn()
      .mockResolvedValue(makeTermsResult([{ value: 'Painting', count: 3000 }], 1));
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      listTerms: listTermsFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext();
    const input = smithsonianListTerms.input.parse({ field: 'object_type' });
    await smithsonianListTerms.handler(input, ctx);

    expect(listTermsFn.mock.calls[0]?.[0]).toMatchObject({ start: 0, rows: 50 });
  });

  it('rejects invalid field names', () => {
    expect(() => smithsonianListTerms.input.parse({ field: 'invalid_field' })).toThrow();
  });

  it('rejects rows > 100', () => {
    expect(() => smithsonianListTerms.input.parse({ field: 'unit_code', rows: 101 })).toThrow();
  });

  it('format renders field name, total, and term values with counts', () => {
    const output = {
      field: 'unit_code',
      terms: [
        { value: 'NASM', count: 100000 },
        { value: 'NMNH', count: 80000 },
      ],
      total: 16,
    };
    const blocks = smithsonianListTerms.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('unit_code');
    expect(text).toContain('16');
    expect(text).toContain('NASM');
    expect(text).toContain('100');
    expect(text).toContain('NMNH');
  });
});
