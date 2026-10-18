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
  it.each([0, 1, 2, 3])('wires media-type filtering at cap/end boundaries: %s', async (start) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => searchBody(start < 2 ? 1 : 0, 2),
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await runToolContract(smithsonianSearchObjects, {
      query: '',
      filters: { online_media_type: '3D Models' },
      rows: 1,
      start,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      total_count: 2,
      objects: start < 2 ? [expect.any(Object)] : [],
    });
    expect(text(result)).toContain('2 total results');
    expect((result.structuredContent as { truncated?: boolean }).truncated === true).toBe(
      start === 0,
    );
    expect(text(result).includes('2 objects match')).toBe(start === 0);
    const params = new URL(fetchMock.mock.calls[0]![0]).searchParams;
    expect(params.get('rows')).toBe('1');
    expect(params.get('start')).toBe(String(start));
    expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get('q')).toBe(
      'online_media_type:"3D Models"',
    );
  });

  it('rejects invalid media-type input before accessing upstream', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await runToolContract(smithsonianSearchObjects, {
      query: '',
      filters: { online_media_type: false },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('online_media_type');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('relays specimen fields through both object wire surfaces', async () => {
    stubJson({
      response: {
        title: 'Lampropeltis triangulum',
        content: {
          indexedStructured: {
            scientific_name: ['Lampropeltis triangulum', 'Other name'],
            tax_kingdom: ['Animalia'],
            tax_phylum: ['Chordata'],
            tax_class: ['Reptilia'],
            tax_order: ['Squamata'],
            tax_family: ['Colubrinae', 'Other family'],
            geoLocation: [
              {
                Other: { type: 'Locality', content: 'El Copé' },
                points: {
                  point: {
                    latitude: { type: 'decimal', content: '8.6194' },
                    longitude: { type: 'decimal', content: '-80.5792' },
                  },
                },
              },
            ],
          },
        },
      },
    });
    const result = await runToolContract(smithsonianGetObject, { id: 'nmnhvz_10292842' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      scientific_names: ['Lampropeltis triangulum', 'Other name'],
      taxonomy: { family: ['Colubrinae', 'Other family'] },
      coordinates: [{ latitude: 8.6194, longitude: -80.5792, locality: 'El Copé' }],
    });
    for (const value of [
      'Other name',
      'Animalia',
      'Chordata',
      'Reptilia',
      'Squamata',
      'Colubrinae',
      'Other family',
      '8.6194',
      '-80.5792',
      'El Copé',
    ])
      expect(text(result)).toContain(value);
  });

  it.each([0, 100, 200, 201])(
    'wires scientific_name as a hard filter at offset %s',
    async (start) => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => searchBody(start < 200 ? 100 : 0, 200),
      });
      vi.stubGlobal('fetch', fetchMock);
      const result = await runToolContract(smithsonianSearchObjects, {
        query: '',
        filters: { scientific_name: 'Crotalus "horridus"\\name', unit_code: 'NMNHHERPS' },
        rows: 100,
        start,
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        total_count: 200,
      });
      expect((result.structuredContent as { objects: unknown[] }).objects).toHaveLength(
        start < 200 ? 100 : 0,
      );
      expect(text(result)).toContain('200 total results');
      expect((result.structuredContent as { truncated?: boolean }).truncated === true).toBe(
        start === 0,
      );
      expect(text(result).includes('200 objects match')).toBe(start === 0);
      const params = new URL(fetchMock.mock.calls[0]![0]).searchParams;
      expect(params.get('rows')).toBe('100');
      expect(params.get('start')).toBe(String(start));
      expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get('q')).toBe(
        'unit_code:"NMNHHERPS" AND scientific_name:"Crotalus \\"horridus\\"\\\\name"',
      );
    },
  );

  it('routes an empty scientific-name result to object scientific_names', async () => {
    stubJson(searchBody(0, 0));
    const result = await runToolContract(smithsonianSearchObjects, {
      query: '',
      filters: { scientific_name: 'Invented name' },
    });
    expect(errorOf(result).data?.reason).toBe('invalid_filter');
    expect(errorOf(result).data?.recovery?.hint).toContain(
      'smithsonian_get_object.scientific_names',
    );
    expect(text(result)).toContain('smithsonian_get_object.scientific_names');
  });

  it('rejects invalid scientific-name input before upstream access', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await runToolContract(smithsonianSearchObjects, {
      query: '',
      filters: { scientific_name: false },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('scientific_name');
    expect(fetchMock).not.toHaveBeenCalled();
  });
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
    // SmithsonianService.getContent raises it with the reason alone and the
    // framework fills the executing tool's own hint, so the marker is only correct
    // while each tool's declared text still reaches the wire.
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
