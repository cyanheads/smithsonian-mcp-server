/**
 * @fileoverview Contract-boundary tests — every tool driven through
 * `runToolContract`, which validates arguments, runs the real handler, renders
 * `format()` and enrichment, and builds the dual-surface envelope a client
 * actually receives. The per-tool suites beside this file call handlers
 * directly with pre-parsed input, so they never exercise argument validation,
 * the error envelope, or the `content[]` twin of `structuredContent`.
 * @module tests/mcp-server/tools/definitions/tool-contract.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { createInMemoryStorage, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { smithsonianFindRelated } from '@/mcp-server/tools/definitions/smithsonian-find-related.tool.js';
import { smithsonianGetMedia } from '@/mcp-server/tools/definitions/smithsonian-get-media.tool.js';
import { smithsonianGetObject } from '@/mcp-server/tools/definitions/smithsonian-get-object.tool.js';
import { smithsonianListTerms } from '@/mcp-server/tools/definitions/smithsonian-list-terms.tool.js';
import { smithsonianSearchObjects } from '@/mcp-server/tools/definitions/smithsonian-search-objects.tool.js';
import { initSmithsonianService } from '@/services/smithsonian/smithsonian-service.js';

// ---------------------------------------------------------------------------
// Upstream stubs
// ---------------------------------------------------------------------------

/** A JSON 200 from every upstream path. */
function stubJson(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }),
  );
}

/** A real EDAN 404 — what `/content/{id}` returns for an ID that does not exist. */
function stubNotFound(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => '{"status":404}',
    }),
  );
}

/** A `/search` response carrying `count` identical rows out of `rowCount` matches. */
function searchBody(count: number, rowCount: number): unknown {
  return {
    status: 200,
    responseCode: 1,
    response: {
      rowCount,
      rows: Array.from({ length: count }, (_, i) => ({
        id: `ld1-${i}`,
        title: `Object ${i}`,
        unitCode: 'NASM',
        url: `edanmdm:nasm_TEST${i}`,
        content: {
          descriptiveNonRepeating: {
            record_ID: `nasm_TEST${i}`,
            unit_code: 'NASM',
            metadata_usage: { access: 'CC0' },
            online_media: { mediaCount: 1, media: [{ type: 'Images', thumbnail: 'https://t' }] },
          },
          indexedStructured: { object_type: ['Aircraft'], date: ['1960s'] },
        },
      })),
    },
  };
}

/** The text of the first `content[]` block. */
function text(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return blocks
    .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
    .join('\n')
    .trim();
}

/** The error envelope a failed call puts on `structuredContent`. */
function errorOf(result: { structuredContent?: unknown }): {
  code: number;
  message: string;
  data?: { reason?: string; recovery?: { hint?: string } };
} {
  const sc = result.structuredContent as { error?: unknown } | undefined;
  return sc?.error as ReturnType<typeof errorOf>;
}

/** The `recovery` string a tool declares for one reason. */
function declaredRecovery(
  def: { errors?: readonly { reason: string; recovery: string }[] },
  reason: string,
): string {
  const entry = def.errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`No errors[] entry for reason '${reason}'`);
  return entry.recovery;
}

describe('tool contract boundary', () => {
  beforeEach(() => {
    vi.stubEnv('SMITHSONIAN_API_KEY', 'test-key-12345');
    initSmithsonianService({} as AppConfig, createInMemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Argument rejection
  // -------------------------------------------------------------------------

  describe('argument rejection', () => {
    it('is InvalidParams (-32602) and names the offending field on both surfaces', async () => {
      const result = await runToolContract(smithsonianListTerms, {
        field: 'object_type',
      } as never);

      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.code).toBe(-32602);
      expect(error.data?.reason).toBe('invalid_arguments');
      expect(error.message).toContain('field');
      expect(text(result)).toContain('field');
      expect(text(result)).toContain('smithsonian_list_terms');
    });

    it('closes the error text with the reason term', async () => {
      const result = await runToolContract(smithsonianListTerms, {
        field: 'object_type',
      } as never);

      expect(text(result)).toContain('(reason invalid_arguments)');
    });

    it('renders an omitted required field as missing, with a synthesized recovery hint', async () => {
      const result = await runToolContract(smithsonianListTerms, {} as never);

      const error = errorOf(result);
      expect(error.code).toBe(-32602);
      expect(error.message).toContain('Missing required field');
      expect(error.data?.recovery?.hint).toBeTruthy();
      expect(text(result)).toContain('Recovery:');
      expect(text(result)).toContain('field');
    });

    it('rejects a numeric bound past its maximum', async () => {
      const result = await runToolContract(smithsonianSearchObjects, {
        query: 'aircraft',
        rows: 101,
      } as never);

      expect(errorOf(result).code).toBe(-32602);
      expect(text(result)).toContain('rows');
    });
  });

  // -------------------------------------------------------------------------
  // Argument pre-validation
  // -------------------------------------------------------------------------

  describe('argument pre-validation', () => {
    it('drops a client-added underscore key instead of rejecting the call', async () => {
      stubJson({ status: 200, response: { terms: ['NASM'] } });

      const result = await runToolContract(smithsonianListTerms, {
        field: 'unit_code',
        _clientNote: 'ignore me',
      } as never);

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ field: 'unit_code' });
    });

    it('rewrites a case-style key alias to the declared spelling', async () => {
      stubJson({ status: 200, response: { terms: ['NASM'] } });

      const result = await runToolContract(smithsonianListTerms, {
        Field: 'unit_code',
      } as never);

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ field: 'unit_code' });
    });

    it('still rejects an undeclared key that names no declared one', async () => {
      stubJson({ status: 200, response: { terms: ['NASM'] } });

      const result = await runToolContract(smithsonianListTerms, {
        field: 'unit_code',
        nonsense: true,
      } as never);

      expect(errorOf(result).code).toBe(-32602);
    });
  });

  // -------------------------------------------------------------------------
  // Declared failures
  // -------------------------------------------------------------------------

  describe('declared failures', () => {
    it('puts a handler-thrown reason and its declared recovery on both surfaces', async () => {
      stubJson({ status: 200, response: { terms: [] } });

      const result = await runToolContract(smithsonianListTerms, { field: 'culture' });

      const error = errorOf(result);
      expect(error.code).toBe(-32001);
      expect(error.data?.reason).toBe('no_terms');
      expect(error.data?.recovery?.hint).toBe(declaredRecovery(smithsonianListTerms, 'no_terms'));
      expect(text(result)).toContain('Recovery:');
      expect(text(result)).toContain('(reason no_terms)');
    });

    it('surfaces an unfiltered zero-match search as no_results', async () => {
      stubJson(searchBody(0, 0));

      const result = await runToolContract(smithsonianSearchObjects, { query: 'zzz-no-such' });

      const error = errorOf(result);
      expect(error.data?.reason).toBe('no_results');
      expect(error.data?.recovery?.hint).toBe(
        declaredRecovery(smithsonianSearchObjects, 'no_results'),
      );
      expect(text(result)).toContain('(reason no_results)');
    });

    // `not_found` is declared on all three ID tools as `thrownBy: 'service'` —
    // SmithsonianService.getContent raises it and resolves the executing tool's
    // own hint, so the marker is only correct while each tool's declared text
    // still reaches the wire.
    it.each([
      ['smithsonian_get_object', smithsonianGetObject, { id: 'nasm_MISSING' }],
      ['smithsonian_get_media', smithsonianGetMedia, { id: 'nasm_MISSING' }],
      ['smithsonian_find_related', smithsonianFindRelated, { id: 'nasm_MISSING' }],
    ] as const)('delivers the service-raised not_found through %s', async (_name, def, input) => {
      stubNotFound();

      const result = await runToolContract(def, input as never);

      const error = errorOf(result);
      expect(error.code).toBe(-32001);
      expect(error.data?.reason).toBe('not_found');
      expect(error.data?.recovery?.hint).toBe(declaredRecovery(def, 'not_found'));
      expect(text(result)).toContain('(reason not_found)');
    });
  });

  // -------------------------------------------------------------------------
  // Success surfaces
  // -------------------------------------------------------------------------

  describe('success surfaces', () => {
    it('carries the same data on structuredContent and content[]', async () => {
      stubJson(searchBody(2, 2));

      const result = await runToolContract(smithsonianSearchObjects, { query: 'aircraft' });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ total_count: 2 });
      const rendered = text(result);
      expect(rendered).toContain('nasm_TEST0');
      expect(rendered).toContain('Object 0');
      expect(rendered).toContain('National Air and Space Museum');
    });

    it('discloses truncation on both surfaces when the cap is reached', async () => {
      stubJson(searchBody(2, 40));

      const result = await runToolContract(smithsonianSearchObjects, {
        query: 'aircraft',
        rows: 2,
      });

      expect(result.structuredContent).toMatchObject({
        truncated: true,
        shown: 2,
        cap: 2,
        truncationCeiling: 40,
      });
      expect(text(result)).toContain('40 objects match');
    });

    it('returns an empty page past the end rather than a failure', async () => {
      stubJson(searchBody(0, 40));

      const result = await runToolContract(smithsonianSearchObjects, {
        query: 'aircraft',
        start: 100,
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ objects: [], total_count: 40 });
    });
  });
});
