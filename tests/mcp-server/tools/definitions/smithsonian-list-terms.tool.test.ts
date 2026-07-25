/**
 * @fileoverview Tests for smithsonian_list_terms tool.
 * @module tests/mcp-server/tools/definitions/smithsonian-list-terms.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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

  it('does not report truncated on a past-the-end page (issue #30)', async () => {
    // The trigger compared the page length against the full total, so an empty
    // terminal page disclosed truncated: true, shown: 0 — advertising omitted data
    // on a call that had already walked off the end of the vocabulary.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      listTerms: vi.fn().mockResolvedValue(makeTermsResult([], 8683)),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianListTerms.errors });
    const input = smithsonianListTerms.input.parse({ field: 'culture', start: 100000, rows: 5 });
    const result = await smithsonianListTerms.handler(input, ctx);

    expect(result.terms).toEqual([]);
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('does not report truncated on the exact last page (issue #30)', async () => {
    // start(10) + shown(2) === total(12): the terminal page withholds nothing.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      listTerms: vi.fn().mockResolvedValue(makeTermsResult(['Images', '3D Models'], 12)),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianListTerms.errors });
    const input = smithsonianListTerms.input.parse({
      field: 'online_media_type',
      start: 10,
      rows: 5,
    });
    await smithsonianListTerms.handler(input, ctx);

    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('still reports truncated when terms remain past the page (issue #30)', async () => {
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      listTerms: vi.fn().mockResolvedValue(makeTermsResult(['Aztecs', 'Balinese'], 8683)),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianListTerms.errors });
    const input = smithsonianListTerms.input.parse({ field: 'culture', start: 10, rows: 2 });
    await smithsonianListTerms.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(2);
    expect(enrichment.truncationCeiling).toBe(8683);
  });

  it('truncation guidance names start, rows, and contains (issue #23)', async () => {
    // The generic default ("Raise the cap or narrow with filters") names no input a
    // caller can act on. list_terms already declares `notice`, so only the guidance
    // text is at issue here.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      listTerms: vi.fn().mockResolvedValue(makeTermsResult(['Aztecs', 'Balinese'], 8683)),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianListTerms.errors });
    const input = smithsonianListTerms.input.parse({ field: 'culture', rows: 2 });
    const result = await smithsonianListTerms.handler(input, ctx);

    const effectiveOutput = smithsonianListTerms.output.extend(smithsonianListTerms.enrichment!);
    const onTheWire = effectiveOutput.parse({ ...result, ...getEnrichment(ctx) });
    expect(onTheWire.notice).toContain('start');
    expect(onTheWire.notice).toContain('rows');
    expect(onTheWire.notice).toContain('contains');
  });

  it('the filtered-empty notice is never clobbered by truncation guidance (issue #23)', async () => {
    // Both branches write the same enrichment `notice` key, so a reachable overlap
    // would silently drop one. total === 0 makes the truncation trigger impossible,
    // keeping them mutually exclusive — this pins that invariant.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      listTerms: vi.fn().mockResolvedValue(makeTermsResult([], 0)),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianListTerms.errors });
    const input = smithsonianListTerms.input.parse({ field: 'culture', contains: 'zzznope' });
    await smithsonianListTerms.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('zzznope');
    expect(enrichment.truncated).toBeUndefined();
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

  it('threads the contains filter through to the service (issue #21)', async () => {
    const listTermsFn = vi.fn().mockResolvedValue(makeTermsResult(['Greek, Attic'], 1));
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      listTerms: listTermsFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianListTerms.errors });
    const input = smithsonianListTerms.input.parse({ field: 'culture', contains: 'greek' });
    const result = await smithsonianListTerms.handler(input, ctx);

    expect(listTermsFn).toHaveBeenCalledWith(
      { field: 'culture', start: 0, rows: 50, contains: 'greek' },
      ctx,
    );
    expect(result.terms).toEqual(['Greek, Attic']);
    expect(result.total).toBe(1);
  });

  it('returns an empty page with a notice (not no_terms) when contains matches nothing (issue #21)', async () => {
    // A contains filter that resolves to nothing is a successful "no term matches" —
    // an empty page confirming absence plus a notice, not the empty-field error.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      listTerms: vi.fn().mockResolvedValue(makeTermsResult([], 0)),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianListTerms.errors });
    const input = smithsonianListTerms.input.parse({ field: 'culture', contains: 'zzznope' });
    const result = await smithsonianListTerms.handler(input, ctx);

    expect(result.terms).toEqual([]);
    expect(result.total).toBe(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('zzznope');
    expect(enrichment.notice).toContain('culture');
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

  describe('unit_code museum names (issue #37)', () => {
    it('passes the service labels through to the output', async () => {
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
        listTerms: vi.fn().mockResolvedValue({
          terms: ['NASM', 'FSA'],
          total: 2,
          labels: { NASM: 'National Air and Space Museum' },
        }),
      } as unknown as svcModule.SmithsonianService);

      const ctx = createMockContext({ errors: smithsonianListTerms.errors });
      const input = smithsonianListTerms.input.parse({ field: 'unit_code' });
      const result = await smithsonianListTerms.handler(input, ctx);

      expect(result.labels).toEqual({ NASM: 'National Air and Space Museum' });
      // The output must still validate once the enrichment fields are folded in.
      const effectiveOutput = smithsonianListTerms.output.extend(smithsonianListTerms.enrichment!);
      expect(() => effectiveOutput.parse(result)).not.toThrow();
    });

    it('omits labels entirely for a field that has none', async () => {
      // The service returns no map for culture/place/date, and an absent field must
      // stay absent rather than serialize as an empty object.
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
        listTerms: vi.fn().mockResolvedValue(makeTermsResult(['Aztecs'], 1)),
      } as unknown as svcModule.SmithsonianService);

      const ctx = createMockContext({ errors: smithsonianListTerms.errors });
      const input = smithsonianListTerms.input.parse({ field: 'culture' });
      const result = await smithsonianListTerms.handler(input, ctx);

      expect(result).not.toHaveProperty('labels');
    });

    it('format renders the museum name beside each labelled code', () => {
      // format() is the surface Claude Desktop reads; a label that reached only
      // structuredContent would be invisible there.
      const blocks = smithsonianListTerms.format!({
        field: 'unit_code',
        terms: ['NASM', 'FSA'],
        total: 2,
        labels: { NASM: 'National Air and Space Museum' },
      });
      const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
      expect(text).toContain('`NASM` — National Air and Space Museum');
      // A code with no mapped name renders bare, never with a guessed expansion.
      expect(text).toContain('`FSA`');
      expect(text).not.toMatch(/`FSA` —/);
    });

    it('format is unchanged for a field with no labels', () => {
      const blocks = smithsonianListTerms.format!({
        field: 'culture',
        terms: ['Aztecs', 'Roman'],
        total: 2,
      });
      const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
      const termLines = text.split('\n').filter((line) => line.startsWith('- '));
      expect(termLines).toEqual(['- `Aztecs`', '- `Roman`']);
    });
  });
});
