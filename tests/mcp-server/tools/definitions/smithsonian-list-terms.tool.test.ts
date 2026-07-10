/**
 * @fileoverview Tests for smithsonian_list_terms tool.
 * @module tests/mcp-server/tools/definitions/smithsonian-list-terms.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { smithsonianListTerms } from '@/mcp-server/tools/definitions/smithsonian-list-terms.tool.js';
import * as svcModule from '@/services/smithsonian/smithsonian-service.js';

function makeTermsResult(terms: string[] = [], total = terms.length) {
  return { terms, total };
}

describe('smithsonianListTerms', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns terms for a valid field', async () => {
    // Upstream terms are bare strings (no per-term counts).
    const mockTerms = ['NASM', 'NMNH'];
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      listTerms: vi.fn().mockResolvedValue(makeTermsResult(mockTerms, 16)),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianListTerms.errors });
    const input = smithsonianListTerms.input.parse({ field: 'unit_code' });
    const result = await smithsonianListTerms.handler(input, ctx);

    expect(result.field).toBe('unit_code');
    expect(result.terms).toEqual(['NASM', 'NMNH']);
    expect(result.terms[0]).toBe('NASM');
    expect(result.total).toBe(16);
  });

  it('passes field, start, and rows to the service', async () => {
    const listTermsFn = vi.fn().mockResolvedValue(makeTermsResult(['Aztecs'], 200));
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      listTerms: listTermsFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianListTerms.errors });
    const input = smithsonianListTerms.input.parse({ field: 'culture', start: 10, rows: 25 });
    await smithsonianListTerms.handler(input, ctx);

    expect(listTermsFn).toHaveBeenCalledWith({ field: 'culture', start: 10, rows: 25 }, ctx);
  });

  it('throws no_terms only when the vocabulary is empty (total 0), carrying the declared recovery hint (issues #14, #16)', async () => {
    // total === 0 is the sole no_terms trigger: the field genuinely has no
    // indexed vocabulary. The declared contract recovery rides data.recovery.hint.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      listTerms: vi.fn().mockResolvedValue(makeTermsResult([], 0)),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianListTerms.errors });
    const input = smithsonianListTerms.input.parse({ field: 'culture' });
    const expectedHint = smithsonianListTerms.errors?.find(
      (e) => e.reason === 'no_terms',
    )?.recovery;
    await expect(smithsonianListTerms.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_terms', recovery: { hint: expectedHint } },
    });
  });

  it('returns an empty terminal page (not no_terms) when start is past the end (issue #16)', async () => {
    // A past-the-end page has an empty slice but a non-zero total — normal
    // pagination completion, not an empty-vocabulary error.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      listTerms: vi.fn().mockResolvedValue(makeTermsResult([], 48)),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianListTerms.errors });
    const input = smithsonianListTerms.input.parse({ field: 'unit_code', start: 9999, rows: 3 });
    const result = await smithsonianListTerms.handler(input, ctx);

    expect(result.field).toBe('unit_code');
    expect(result.terms).toEqual([]);
    expect(result.total).toBe(48);
  });

  it('defaults start to 0 and rows to 50', async () => {
    const listTermsFn = vi.fn().mockResolvedValue(makeTermsResult(['United States of America'], 1));
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      listTerms: listTermsFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext();
    const input = smithsonianListTerms.input.parse({ field: 'place' });
    await smithsonianListTerms.handler(input, ctx);

    expect(listTermsFn.mock.calls[0]?.[0]).toMatchObject({ start: 0, rows: 50 });
  });

  it('rejects invalid field names', () => {
    expect(() => smithsonianListTerms.input.parse({ field: 'invalid_field' })).toThrow();
  });

  it('rejects fields not enumerable upstream (object_type, media_usage)', () => {
    // object_type is WAF-blocked and media_usage is not a terms field — both were
    // removed from the enum, so they must be rejected at input parse.
    expect(() => smithsonianListTerms.input.parse({ field: 'object_type' })).toThrow();
    expect(() => smithsonianListTerms.input.parse({ field: 'media_usage' })).toThrow();
  });

  it('rejects rows > 100', () => {
    expect(() => smithsonianListTerms.input.parse({ field: 'unit_code', rows: 101 })).toThrow();
  });

  it('non-truncated result validates against the effective output schema (issue #13)', async () => {
    // A vocabulary that fits one page: terms.length === total, so no truncation
    // enrichment is written. The framework validates output.extend(enrichment);
    // required-but-unpopulated enrichment fields (the pre-fix contract) threw here.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      listTerms: vi.fn().mockResolvedValue(makeTermsResult(['NASM', 'NMNH'], 2)),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianListTerms.errors });
    const input = smithsonianListTerms.input.parse({ field: 'unit_code', rows: 100 });
    const result = await smithsonianListTerms.handler(input, ctx);

    const effectiveOutput = smithsonianListTerms.output.extend(smithsonianListTerms.enrichment!);
    expect(() => effectiveOutput.parse(result)).not.toThrow();
  });

  it('format renders field name, total, and term values', () => {
    const output = {
      field: 'unit_code',
      terms: ['NASM', 'NMNH'],
      total: 16,
    };
    const blocks = smithsonianListTerms.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('unit_code');
    expect(text).toContain('16');
    expect(text).toContain('NASM');
    expect(text).toContain('NMNH');
  });
});
