/**
 * @fileoverview Tests for smithsonian_list_terms tool.
 * @module tests/mcp-server/tools/definitions/smithsonian-list-terms.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createInMemoryStorage,
  createMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadClampSwitch } from '@/config/server-config.js';
import { smithsonianListTerms } from '@/mcp-server/tools/definitions/smithsonian-list-terms.tool.js';
import * as svcModule from '@/services/smithsonian/smithsonian-service.js';

function makeTermsResult(terms: string[] = [], total = terms.length) {
  return { terms, total };
}

describe('smithsonianListTerms', () => {
  it('routes media terms to search without inventing a browse mode', () => {
    const guidance = smithsonianListTerms.output.shape.terms.element.description;
    expect(guidance).toContain('online_media_type values feed search only');
    expect(guidance).toContain('no media-type or place mode');
  });
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

    const result = await runToolContract(smithsonianListTerms, { field: 'culture' });
    const expectedHint = smithsonianListTerms.errors?.find(
      (e) => e.reason === 'no_terms',
    )?.recovery;
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'no_terms', recovery: { hint: expectedHint } } },
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

  it('enumerates the topic vocabulary, narrowed by contains', async () => {
    // topic is enumerable upstream (133,113 terms) and is the vocabulary behind
    // smithsonian_search_objects filters.topic and browse mode "topic".
    const listTermsFn = vi
      .fn()
      .mockResolvedValue(makeTermsResult(['Quilts', 'Quilts--History'], 2));
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      listTerms: listTermsFn,
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianListTerms.errors });
    const input = smithsonianListTerms.input.parse({ field: 'topic', contains: 'quilt' });
    const result = await smithsonianListTerms.handler(input, ctx);

    expect(listTermsFn).toHaveBeenCalledWith(
      { field: 'topic', start: 0, rows: 50, contains: 'quilt' },
      ctx,
    );
    expect(result.field).toBe('topic');
    expect(result.terms).toEqual(['Quilts', 'Quilts--History']);
  });

  it('rejects fields not enumerable upstream (object_type, media_usage)', () => {
    // object_type is WAF-blocked and media_usage is not a terms field — both were
    // removed from the enum, so they must be rejected at input parse.
    expect(() => smithsonianListTerms.input.parse({ field: 'object_type' })).toThrow();
    expect(() => smithsonianListTerms.input.parse({ field: 'media_usage' })).toThrow();
  });

  describe('page-size clamp (issue #63)', () => {
    /**
     * The real service's listTerms over a stubbed vocabulary of `size` terms, so the
     * rows the tool serves reach the actual slice.
     */
    function serveVocabulary(size: number) {
      const service = new svcModule.SmithsonianService(createInMemoryStorage());
      vi.spyOn(
        service as unknown as { vocabulary: () => Promise<string[]> },
        'vocabulary',
      ).mockResolvedValue(Array.from({ length: size }, (_, i) => `term ${i}`));
      const listTerms = vi.spyOn(service, 'listTerms');
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(service);
      return listTerms;
    }

    /** Every text block of a result, the trailer that carries the notice included. */
    function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
      return result.content.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n');
    }

    /** The `rows` property as `tools/list` advertises it, serialized as on the wire. */
    function advertisedRows(): Record<string, unknown> {
      const schema = smithsonianListTerms.input['~standard'].jsonSchema.input({
        target: 'draft-2020-12',
      }) as { properties: Record<string, unknown> };
      return JSON.parse(JSON.stringify(schema.properties.rows));
    }

    const CLAMP = 'rows 50000 exceeds the cap of 40000; the page was served with rows 40000.';

    it('slices 40,000 terms for rows 50000 and leads the paging guidance with the clamp sentence', async () => {
      const listTerms = serveVocabulary(45_000);

      const result = await runToolContract(smithsonianListTerms, { field: 'topic', rows: 50_000 });

      expect(result.isError).not.toBe(true);
      expect(listTerms.mock.calls[0]?.[0]).toMatchObject({ start: 0, rows: 40_000 });
      const sc = result.structuredContent as {
        terms: string[];
        total: number;
        truncated?: boolean;
        cap?: number;
        notice?: string;
      };
      expect(sc.terms).toHaveLength(40_000);
      expect(sc.terms.at(-1)).toBe('term 39999');
      expect(sc).toMatchObject({ total: 45_000, truncated: true, cap: 40_000 });
      expect(sc.notice?.startsWith(`${CLAMP} 45000 terms match`)).toBe(true);
      expect(sc.notice).toContain('start: 40000');
      expect(textOf(result)).toContain(CLAMP);
      expect(textOf(result)).toContain('start: 40000');
    });

    it('composes the clamp sentence with the filtered-empty notice', async () => {
      serveVocabulary(10);

      const result = await runToolContract(smithsonianListTerms, {
        field: 'topic',
        rows: 50_000,
        contains: 'zzznope',
      });

      const sc = result.structuredContent as { truncated?: boolean; notice?: string };
      expect(sc.truncated).toBeUndefined();
      expect(sc.notice).toBe(
        `${CLAMP} No term in the "topic" vocabulary contains "zzznope". Broaden or re-spell the substring, or omit contains to browse the full vocabulary.`,
      );
      expect(textOf(result)).toContain(CLAMP);
    });

    it('serves rows 40000 as asked, with no clamp sentence', async () => {
      const listTerms = serveVocabulary(45_000);

      const result = await runToolContract(smithsonianListTerms, { field: 'topic', rows: 40_000 });

      expect(listTerms.mock.calls[0]?.[0]).toMatchObject({ rows: 40_000 });
      const sc = result.structuredContent as { terms: string[]; cap?: number; notice?: string };
      expect(sc.terms).toHaveLength(40_000);
      expect(sc.cap).toBe(40_000);
      expect(sc.notice).toContain('start: 40000');
      expect(sc.notice).not.toContain('exceeds the cap');
    });

    it('advertises rows with no maximum and the clamp wording by default', () => {
      const rows = advertisedRows();
      expect(rows).toMatchObject({ type: 'integer', minimum: 1, default: 50 });
      expect(rows.maximum).toBeUndefined();
      expect(rows.description).toContain('A value above 40000 is served at 40000 with a notice.');
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

      it('rejects rows 40001 before the vocabulary is read and serves rows 40000', async () => {
        const listTerms = serveVocabulary(45_000);

        const rejected = await runToolContract(smithsonianListTerms, {
          field: 'topic',
          rows: 40_001,
        });
        expect(rejected.isError).toBe(true);
        expect(rejected.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
        });
        expect(textOf(rejected)).toContain('rows');
        expect(listTerms).not.toHaveBeenCalled();

        const served = await runToolContract(smithsonianListTerms, {
          field: 'topic',
          rows: 40_000,
        });
        expect(served.isError).not.toBe(true);
        expect(listTerms.mock.calls[0]?.[0]).toMatchObject({ rows: 40_000 });
      });

      it('advertises maximum 40000 and the strict wording', () => {
        const rows = advertisedRows();
        expect(rows).toMatchObject({ type: 'integer', maximum: 40_000, default: 50 });
        expect(rows.description).toBe(
          'Number of terms to return per page (default 50, max 40000).',
        );
      });
    });
  });

  it('escapes the caller-supplied contains substring inside the Markdown notice', async () => {
    // The framework renders a notice as Markdown and escapes nothing, so a raw
    // `*` in the echoed substring would turn the rest of the sentence italic.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      listTerms: vi.fn().mockResolvedValue(makeTermsResult([], 0)),
    } as unknown as svcModule.SmithsonianService);

    const result = await runToolContract(smithsonianListTerms, {
      field: 'culture',
      contains: 'zz*nope*',
    });

    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toContain('contains "zz\\*nope\\*".');
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

  describe('host-level 404 on the terms endpoint (issue #51)', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    it('reports an outage, distinguishable from the empty-vocabulary path', async () => {
      // The real service over a stubbed fetch — the reclassification lives in the
      // service's retry closure, so a service stand-in cannot exercise it.
      vi.stubEnv('SMITHSONIAN_API_KEY', 'test-key-12345');
      // Only /terms/culture is answered; any other upstream path fails loudly.
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string) => {
          if (new URL(url).pathname !== '/openaccess/api/v1.0/terms/culture') {
            throw new Error('unmocked fetch');
          }
          return {
            ok: false,
            status: 404,
            statusText: 'Not Found',
            headers: { get: () => null },
            text: async () => "404 Not Found: Requested route ('api.si.edu') does not exist.",
          };
        }),
      );
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(
        new svcModule.SmithsonianService(createInMemoryStorage()),
      );

      const ctx = createMockContext({
        errors: smithsonianListTerms.errors,
        tenantId: 'test-tenant',
      });
      const input = smithsonianListTerms.input.parse({ field: 'culture' });

      vi.useFakeTimers();
      const promise = smithsonianListTerms.handler(input, ctx).catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      const err = (await promise) as { code: number; data?: Record<string, unknown> };
      vi.useRealTimers();

      // /terms/{field} exists whenever the service does, so this is never a
      // statement about `culture` — and never the tool's own no_terms.
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data?.reason).toBe('upstream_unavailable');
      expect(err.data?.reason).not.toBe('no_terms');
    });
  });
});
