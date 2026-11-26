/**
 * @fileoverview Contract-boundary tests — every tool driven through
 * `runToolContract`, which validates arguments, runs the real handler, renders
 * `format()` and enrichment, and builds the dual-surface envelope a client
 * actually receives. The per-tool suites beside this file call handlers
 * directly with pre-parsed input, so they never exercise argument validation,
 * the error envelope, or the `content[]` twin of `structuredContent`. The Open Access
 * mirror block also reads the output schemas a real `tools/list` advertises.
 * @module tests/mcp-server/tools/definitions/tool-contract.test
 */

import { readFileSync } from 'node:fs';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { createInMemoryStorage, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadClampSwitch } from '@/config/server-config.js';
import { smithsonianBrowseCategory } from '@/mcp-server/tools/definitions/smithsonian-browse-category.tool.js';
import { smithsonianFindRelated } from '@/mcp-server/tools/definitions/smithsonian-find-related.tool.js';
import { smithsonianGetMedia } from '@/mcp-server/tools/definitions/smithsonian-get-media.tool.js';
import { smithsonianGetObject } from '@/mcp-server/tools/definitions/smithsonian-get-object.tool.js';
import { smithsonianListTerms } from '@/mcp-server/tools/definitions/smithsonian-list-terms.tool.js';
import { smithsonianSearchObjects } from '@/mcp-server/tools/definitions/smithsonian-search-objects.tool.js';
import { initSmithsonianService } from '@/services/smithsonian/smithsonian-service.js';
import type { RawEDAN } from '@/services/smithsonian/types.js';
import {
  bulkLine,
  FakeBucket,
  openTestMirror,
  type TestMirror,
} from '../../../services/smithsonian/oa-bucket-fake.js';

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

interface AdvertisedProperty {
  additionalProperties?: boolean;
  description?: string;
  maximum?: number;
  properties?: Record<string, AdvertisedProperty>;
  type?: string;
}

/**
 * The input schema `tools/list` advertises: the SDK reads it through the schema's
 * `~standard.jsonSchema.input` at draft 2020-12, and the wire carries its JSON.
 */
function advertisedInput(def: { input: unknown }): {
  properties: Record<string, AdvertisedProperty>;
} {
  const std = (
    def.input as {
      '~standard': { jsonSchema: { input: (options: { target: string }) => unknown } };
    }
  )['~standard'];
  return JSON.parse(JSON.stringify(std.jsonSchema.input({ target: 'draft-2020-12' })));
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
        url: 'edanmdm:nmnhvz_10292842',
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

    describe('with SMITHSONIAN_CLAMP_LIMITS=false', () => {
      afterEach(() => {
        vi.unstubAllEnvs();
        loadClampSwitch();
      });

      it('rejects a numeric bound past its maximum', async () => {
        vi.stubEnv('SMITHSONIAN_CLAMP_LIMITS', 'false');
        loadClampSwitch();
        const fetchMock = vi.fn().mockRejectedValue(new Error('unmocked fetch'));
        vi.stubGlobal('fetch', fetchMock);

        const result = await runToolContract(smithsonianSearchObjects, {
          query: 'aircraft',
          rows: 1001,
        });

        expect(errorOf(result).code).toBe(-32602);
        expect(errorOf(result).data?.reason).toBe('invalid_arguments');
        expect(text(result)).toContain('rows');
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('advertises the search rows cap as the schema maximum', () => {
        vi.stubEnv('SMITHSONIAN_CLAMP_LIMITS', 'false');
        loadClampSwitch();

        const rows = advertisedInput(smithsonianSearchObjects).properties.rows;
        expect(rows).toMatchObject({ type: 'integer', maximum: 1000 });
      });
    });

    it('advertises the search rows field with no maximum by default', () => {
      const rows = advertisedInput(smithsonianSearchObjects).properties.rows;
      expect(rows?.type).toBe('integer');
      expect(rows).not.toHaveProperty('maximum');
      expect(rows?.description).toContain('1000');
    });

    it.each(['unit_cod', 'unitCode'])(
      'rejects the unknown filters key %s by name before any upstream request',
      async (key) => {
        const fetchMock = vi.fn().mockRejectedValue(new Error('unmocked fetch'));
        vi.stubGlobal('fetch', fetchMock);

        const result = await runToolContract(smithsonianSearchObjects, {
          query: 'quilt',
          filters: { [key]: 'NMAH' },
          rows: 3,
        } as never);

        const error = errorOf(result);
        expect(error.code).toBe(-32602);
        expect(error.data?.reason).toBe('invalid_arguments');
        const accepted =
          'unit_code, object_type, date, culture, place, topic, name, online_only, scientific_name, online_media_type, cc0_only';
        for (const surface of [error.data?.recovery?.hint ?? '', text(result)]) {
          expect(surface).toContain(`filters.${key}`);
          expect(surface).toContain(accepted);
        }
        expect(text(result)).toContain('Recovery:');
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it('advertises the search filters object as closed', () => {
      const filters = advertisedInput(smithsonianSearchObjects).properties.filters;
      expect(filters?.additionalProperties).toBe(false);
      expect(Object.keys(filters?.properties ?? {})).toContain('unit_code');
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

    describe('record_id as an alias of id (issue #84)', () => {
      const RECORD_TOOLS = [
        ['smithsonian_get_object', smithsonianGetObject],
        ['smithsonian_get_media', smithsonianGetMedia],
        ['smithsonian_find_related', smithsonianFindRelated],
      ] as const;

      /** A CC0 record with one CC0 image and two related-object signals. */
      const RECORD = {
        response: {
          id: 'ld1-alias',
          title: 'Alias test object',
          unitCode: 'NASM',
          url: 'edanmdm:nasm_ALIAS1',
          content: {
            descriptiveNonRepeating: {
              record_ID: 'nasm_ALIAS1',
              unit_code: 'NASM',
              metadata_usage: { access: 'CC0' },
              online_media: {
                mediaCount: 1,
                media: [
                  {
                    type: 'Images',
                    idsId: 'NASM-ALIAS1-0001',
                    content: 'https://ids.si.edu/ids/deliveryService?id=NASM-ALIAS1-0001',
                    thumbnail: 'https://ids.si.edu/ids/deliveryService?id=NASM-ALIAS1-0001&max=150',
                    usage: { access: 'CC0' },
                  },
                ],
              },
            },
            indexedStructured: { object_type: ['Aircraft'], date: ['1960s'] },
          },
        },
      };

      /** `/content/{id}` serves {@link RECORD} and `/search` one row; returns the fetch mock. */
      function stubRecordRoutes() {
        const fetchMock = vi.fn(async (url: string | URL) => {
          const body = new URL(String(url)).pathname.includes('/content/')
            ? RECORD
            : searchBody(1, 1);
          return {
            ok: true,
            status: 200,
            json: async () => body,
            text: async () => JSON.stringify(body),
          };
        });
        vi.stubGlobal('fetch', fetchMock);
        return fetchMock;
      }

      /** The `/content/{id}` paths a fetch mock was asked for. */
      function contentPaths(fetchMock: ReturnType<typeof stubRecordRoutes>): string[] {
        return fetchMock.mock.calls
          .map(([url]) => new URL(String(url)).pathname)
          .filter((path) => path.includes('/content/'));
      }

      it.each(RECORD_TOOLS)('%s answers record_id exactly as it answers id', async (_name, def) => {
        const byIdFetch = stubRecordRoutes();
        const byId = await runToolContract(def, { id: 'nasm_ALIAS1' } as never);

        // A fresh service, so the response cache cannot answer the aliased call.
        initSmithsonianService({} as AppConfig, createInMemoryStorage());
        const byAliasFetch = stubRecordRoutes();
        const byAlias = await runToolContract(def, { record_id: 'nasm_ALIAS1' } as never);

        expect(byId.isError).toBeFalsy();
        expect(byAlias.isError).toBeFalsy();
        expect(byAlias.structuredContent).toStrictEqual(byId.structuredContent);
        expect(byAlias.content).toStrictEqual(byId.content);
        expect(contentPaths(byAliasFetch)).toEqual(contentPaths(byIdFetch));
        expect(contentPaths(byAliasFetch)).toEqual([
          expect.stringMatching(/\/content\/edanmdm%3Anasm_ALIAS1$/),
        ]);
      });

      it.each(RECORD_TOOLS)(
        '%s rejects record_id sent beside id, naming it an alias, before any upstream request',
        async (_name, def) => {
          const fetchMock = vi.fn().mockRejectedValue(new Error('unmocked fetch'));
          vi.stubGlobal('fetch', fetchMock);

          const result = await runToolContract(def, {
            id: 'nasm_ALIAS1',
            record_id: 'nasm_OTHER',
          } as never);

          const error = errorOf(result);
          expect(error.code).toBe(-32602);
          expect(error.data?.reason).toBe('invalid_arguments');
          for (const surface of [error.data?.recovery?.hint ?? '', text(result)]) {
            expect(surface).toContain('record_id is an alias of id; send one of them, not both.');
          }
          expect(fetchMock).not.toHaveBeenCalled();
        },
      );

      it.each(RECORD_TOOLS)('%s still advertises id alone', (_name, def) => {
        const schema = advertisedInput(def) as ReturnType<typeof advertisedInput> & {
          required?: string[];
        };
        expect(Object.keys(schema.properties)).not.toContain('record_id');
        expect(schema.required).toEqual(['id']);
      });
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

    // A refused key fails every tool's first read. Forbidden is not a baseline code, so
    // each tool declares the reason its service raises and advertises it in the contract.
    it.each([
      ['smithsonian_search_objects', smithsonianSearchObjects, { query: 'aircraft' }],
      ['smithsonian_list_terms', smithsonianListTerms, { field: 'culture' }],
      ['smithsonian_get_object', smithsonianGetObject, { id: 'nasm_TEST001' }],
      ['smithsonian_get_media', smithsonianGetMedia, { id: 'nasm_TEST001' }],
      ['smithsonian_browse_category', smithsonianBrowseCategory, { mode: 'museum', value: 'NASM' }],
      ['smithsonian_find_related', smithsonianFindRelated, { id: 'nasm_TEST001' }],
    ] as const)('declares and delivers api_key_rejected through %s', async (_name, def, input) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(
          async () =>
            new Response(JSON.stringify({ error: { code: 'API_KEY_INVALID' } }), {
              status: 403,
              statusText: 'Forbidden',
              headers: { 'Content-Type': 'application/json' },
            }),
        ),
      );

      const result = await runToolContract(def, input as never);

      const error = errorOf(result);
      expect(error.code).toBe(-32005);
      expect(error.data?.reason).toBe('api_key_rejected');
      expect(error.data?.recovery?.hint).toBe(declaredRecovery(def, 'api_key_rejected'));
      expect(text(result)).toContain('(reason api_key_rejected)');
    });

    describe('search calls named by get_media recoveries run as written', () => {
      /** The `smithsonian_search_objects { … }` call a recovery names, parsed into its arguments. */
      function namedSearch(recovery: string): Record<string, unknown> {
        const start = recovery.indexOf('smithsonian_search_objects {');
        expect(start, recovery).toBeGreaterThanOrEqual(0);
        const open = recovery.indexOf('{', start);
        let end = open;
        for (let depth = 0; end < recovery.length; end++) {
          if (recovery[end] === '{') depth++;
          else if (recovery[end] === '}' && --depth === 0) break;
        }
        const literal = recovery.slice(open, end + 1).replace(/([{,]\s*)(\w+):/g, '$1"$2":');
        return JSON.parse(literal) as Record<string, unknown>;
      }

      it.each([
        ['no_models', { online_media_type: '3D Models' }],
        ['not_cc0', { cc0_only: true }],
      ] as const)('the declared %s recovery names a search that runs', async (reason, filters) => {
        const args = namedSearch(declaredRecovery(smithsonianGetMedia, reason));
        expect(args).toMatchObject({ filters });
        stubJson(searchBody(1, 1));

        const result = await runToolContract(smithsonianSearchObjects, args as never);

        expect(result.isError).toBeFalsy();
      });

      it('the 3D-mode not_cc0 hint names a search that runs', async () => {
        stubJson({
          response: {
            id: 'ld1-restricted-3d',
            title: 'Restricted 3D object',
            unitCode: 'NMNHPALEO',
            url: 'edanmdm:nmnhpaleo_RESTRICTED3D',
            content: {
              descriptiveNonRepeating: {
                record_ID: 'nmnhpaleo_RESTRICTED3D',
                unit_code: 'NMNHPALEO',
                online_media: {
                  mediaCount: 1,
                  media: [
                    {
                      id: '3d_package:restricted',
                      type: '3d_voyager',
                      usage: { access: 'Usage Conditions Apply' },
                    },
                  ],
                },
              },
            },
          },
        });
        const failed = await runToolContract(smithsonianGetMedia, {
          id: 'nmnhpaleo_RESTRICTED3D',
          media: '3d',
        });
        expect(errorOf(failed).data?.reason).toBe('not_cc0');
        const hint = errorOf(failed).data?.recovery?.hint ?? '';
        expect(text(failed)).toContain(hint);

        const args = namedSearch(hint);
        expect(args).toMatchObject({ filters: { online_media_type: '3D Models' } });
        stubJson(searchBody(1, 1));
        const result = await runToolContract(smithsonianSearchObjects, args as never);

        expect(result.isError).toBeFalsy();
      });
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

// ---------------------------------------------------------------------------
// Open Access mirror provenance (issue #66)
// ---------------------------------------------------------------------------

/**
 * Real `metadata/edan/` lines: eight `edanmdm` records and one `ead_component` from the
 * 2026-10-26 publish, then two `edanmdm` records from the 2026-11-23 publish.
 */
const FIXTURE_LINES = readFileSync(
  new URL('../../../services/smithsonian/fixtures/oa-bulk-lines.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter(Boolean);
const FIXTURE_RECORDS = FIXTURE_LINES.map((line) => JSON.parse(line) as RawEDAN).filter(
  (record) => record.type === 'edanmdm',
);

/** The live API's path under the default base URL. */
const EDAN_PATH = '/openaccess/api/v1.0';

type EdanEndpoint = 'search' | 'content';

/**
 * Stub the live Smithsonian API, routed by hostname and pathname: `/search` answers with the
 * fixture records, `/content/{id}` with the fixture record that id names. Every other request
 * rejects as unmocked; `requests` lists the ones an endpoint answered.
 */
function stubEdan() {
  const answered: Array<{ endpoint: EdanEndpoint; url: URL }> = [];
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(input);
    if (url.hostname !== 'api.si.edu') throw new Error('unmocked fetch');
    if (url.pathname === `${EDAN_PATH}/search`) {
      answered.push({ endpoint: 'search', url });
      return Response.json({
        status: 200,
        response: { rows: FIXTURE_RECORDS, rowCount: FIXTURE_RECORDS.length },
      });
    }
    const contentPrefix = `${EDAN_PATH}/content/`;
    const id = url.pathname.startsWith(contentPrefix)
      ? decodeURIComponent(url.pathname.slice(contentPrefix.length))
      : undefined;
    const record = FIXTURE_RECORDS.find((r) => r.url === id);
    if (!record) throw new Error('unmocked fetch');
    answered.push({ endpoint: 'content', url });
    return Response.json({ status: 200, response: record });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    requests: (endpoint: EdanEndpoint) =>
      answered.filter((r) => r.endpoint === endpoint).map((r) => r.url),
  };
}

/** The fields these tests read off a successful `structuredContent`. */
interface Answer {
  mirror_snapshot?: string;
  notice?: string;
  objects?: Array<{ record_id: string }>;
  record_id?: string;
  sample_objects?: Array<{ record_id: string }>;
  sources?: string[];
  total_count?: number;
}

const answerOf = (result: { structuredContent?: unknown }) => result.structuredContent as Answer;

/** The `content[]` line that opens with `**<label>:**`, or undefined. */
function trailer(result: { content?: unknown }, label: string): string | undefined {
  return text(result)
    .split('\n')
    .find((line) => line.startsWith(`**${label}:**`));
}

describe('Open Access mirror provenance (issue #66)', () => {
  const SNAPSHOT = '2026-10-26T07:25:06.000Z';
  const MIRROR_SENTENCE =
    "Rows served from the Smithsonian Open Access mirror (snapshot of 2026-10-26) are in mirror order, not the live API's.";

  let t: TestMirror;

  beforeAll(async () => {
    const bucket = new FakeBucket();
    vi.stubGlobal('fetch', bucket.fetch);
    t = openTestMirror();
    bucket.put('metadata/edan/aaa/00.txt', FIXTURE_LINES.slice(0, 5));
    bucket.put('metadata/edan/bbb/00.txt', FIXTURE_LINES.slice(5));
    // 1,001 records under unit BIG: one past the 1,000-row page cap, so a clamped page truncates.
    bucket.put(
      'metadata/edan/big/00.txt',
      Array.from({ length: 1001 }, (_, i) =>
        bulkLine(`big_${i}`, {
          unitCode: 'BIG',
          content: { descriptiveNonRepeating: { unit_code: 'BIG', record_ID: `big_${i}` } },
        }),
      ),
    );
    await t.mirror.runSync({ mode: 'init' });
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    vi.stubEnv('SMITHSONIAN_API_KEY', 'test-key-12345');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  /** Each read the mirror can answer, plus a free-text search it cannot; run with it on and off. */
  const CALLS = {
    get_object: () => runToolContract(smithsonianGetObject, { id: 'nasm_A19820121000' }),
    get_media: () => runToolContract(smithsonianGetMedia, { id: 'nasm_A19820121000' }),
    find_related: () => runToolContract(smithsonianFindRelated, { id: 'nmnhvz_14945304' }),
    browse: () =>
      runToolContract(smithsonianBrowseCategory, { mode: 'museum', value: 'NMNHFISHES', rows: 1 }),
    filter_only_search: () =>
      runToolContract(smithsonianSearchObjects, {
        query: '',
        filters: { online_only: true, cc0_only: true },
        rows: 2,
      }),
    clamped_filter_only_search: () =>
      runToolContract(smithsonianSearchObjects, {
        query: '',
        filters: { unit_code: 'BIG' },
        rows: 5000,
      }),
    free_text_search: () => runToolContract(smithsonianSearchObjects, { query: 'missile' }),
  };

  describe('mirror on', () => {
    beforeEach(() => {
      initSmithsonianService({} as AppConfig, createInMemoryStorage(), t.reader);
    });

    it.each([
      ['smithsonian_get_object', CALLS.get_object],
      ['smithsonian_get_media', CALLS.get_media],
    ])(
      '%s reads a mirrored id with no EDAN request and names the mirror on both surfaces',
      async (_name, run) => {
        const edan = stubEdan();

        const result = await run();

        expect(result.isError).toBeFalsy();
        expect(edan.fetchMock).not.toHaveBeenCalled();
        const answer = answerOf(result);
        expect(answer.record_id).toBe('nasm_A19820121000');
        expect(answer.sources).toEqual(['oa_mirror']);
        expect(answer.mirror_snapshot).toBe(SNAPSHOT);
        expect(trailer(result, 'Sources')).toBe('**Sources:** `oa_mirror`');
        expect(trailer(result, 'Mirror snapshot')).toBe(`**Mirror snapshot:** \`${SNAPSHOT}\``);
      },
    );

    it('reads the find_related anchor from the mirror; only its free-text name fan-out goes live', async () => {
      const edan = stubEdan();

      const result = await CALLS.find_related();

      expect(result.isError).toBeFalsy();
      expect(edan.requests('content')).toHaveLength(0);
      expect(edan.requests('search').map((url) => url.searchParams.get('q'))).toEqual([
        'Albatross Philippine Expedition, 1907-1910',
      ]);
      expect(edan.fetchMock).toHaveBeenCalledTimes(1);
      const answer = answerOf(result);
      expect(answer.sources).toEqual(['oa_mirror', 'edan_api']);
      expect(answer.mirror_snapshot).toBe(SNAPSHOT);
      expect(trailer(result, 'Sources')).toBe('**Sources:** `oa_mirror`, `edan_api`');
      expect(trailer(result, 'Mirror snapshot')).toBe(`**Mirror snapshot:** \`${SNAPSHOT}\``);
    });

    it('serves a browse page with no EDAN request, the facet count, and the mirror sentence last', async () => {
      const edan = stubEdan();

      const result = await CALLS.browse();

      expect(result.isError).toBeFalsy();
      expect(edan.fetchMock).not.toHaveBeenCalled();
      const answer = answerOf(result);
      expect(answer.total_count).toBe(2);
      expect(answer.sample_objects?.map((o) => o.record_id)).toEqual(['nmnhvz_14945304']);
      expect(answer.sources).toEqual(['oa_mirror']);
      expect(answer.mirror_snapshot).toBe(SNAPSHOT);
      expect(answer.notice).toMatch(/^2 objects match this category; /);
      expect(answer.notice?.slice(-MIRROR_SENTENCE.length)).toBe(MIRROR_SENTENCE);
      expect(text(result)).toContain(answer.notice);
    });

    it('serves a filter-only search with no EDAN request, the facet count, and the mirror sentence last', async () => {
      const edan = stubEdan();

      const result = await CALLS.filter_only_search();

      expect(result.isError).toBeFalsy();
      expect(edan.fetchMock).not.toHaveBeenCalled();
      const answer = answerOf(result);
      expect(answer.total_count).toBe(3);
      expect(answer.objects?.map((o) => o.record_id)).toEqual([
        'nasm_A19820121000',
        'nmnhvz_14945304',
      ]);
      expect(answer.sources).toEqual(['oa_mirror']);
      expect(answer.mirror_snapshot).toBe(SNAPSHOT);
      expect(answer.notice).toMatch(/^3 objects match; this page shows 2 from offset 0\. /);
      expect(answer.notice?.slice(-MIRROR_SENTENCE.length)).toBe(MIRROR_SENTENCE);
      expect(text(result)).toContain(answer.notice);
    });

    it('serves an on_view_only filter-only search with no EDAN request, its total the facet count (issue #74)', async () => {
      const edan = stubEdan();
      const facetCount = (await t.store.raw())
        .prepare<{ n: number }>("SELECT n FROM terms WHERE field = 'on_view' AND value = 'true'")
        .get()?.n;

      const result = await runToolContract(smithsonianSearchObjects, {
        query: '',
        filters: { on_view_only: true },
      });

      expect(result.isError).toBeFalsy();
      expect(edan.fetchMock).not.toHaveBeenCalled();
      const answer = answerOf(result);
      expect(facetCount).toBe(1);
      expect(answer.total_count).toBe(facetCount);
      expect(answer.objects?.map((o) => o.record_id)).toEqual(['nasm_A19820121000']);
      expect(answer.sources).toEqual(['oa_mirror']);
    });

    it('reads on_view and current_exhibitions from the mirrored doc on both surfaces (issue #74)', async () => {
      const edan = stubEdan();

      const result = await CALLS.get_object();

      expect(edan.fetchMock).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({
        on_view: true,
        current_exhibitions: [{ building: 'HAZY' }],
      });
      const lines = text(result).split('\n');
      const at = lines.indexOf('**On view:** Yes');
      expect(at).toBeGreaterThan(-1);
      expect(lines[at + 1]).toBe('- HAZY');
    });

    it('reads the labeled physical description of nmnhvz_14945304 from the stored doc as from the full line (issue #79)', async () => {
      const mirrored = stubEdan();
      const fromDoc = await runToolContract(smithsonianGetObject, { id: 'nmnhvz_14945304' });
      expect(mirrored.fetchMock).not.toHaveBeenCalled();
      expect(answerOf(fromDoc).sources).toEqual(['oa_mirror']);

      initSmithsonianService({} as AppConfig, createInMemoryStorage());
      const live = stubEdan();
      const fromLine = await runToolContract(smithsonianGetObject, { id: 'nmnhvz_14945304' });
      expect(live.requests('content')).toHaveLength(1);

      for (const result of [fromDoc, fromLine]) {
        expect(
          (result.structuredContent as { physical_description: unknown }).physical_description,
        ).toStrictEqual([
          { label: 'Depth (m)', value: '763 - 763' },
          { label: 'Prep Count', value: '2' },
          { label: 'Preparation', value: 'Polyester' },
        ]);
        expect(text(result)).toContain(
          '**Physical description:**\n- Depth (m): 763 - 763\n- Prep Count: 2\n- Preparation: Polyester',
        );
      }
    });

    it('composes a clamped, truncated filter-only notice as clamp, guidance, then mirror sentence', async () => {
      const edan = stubEdan();

      const result = await CALLS.clamped_filter_only_search();

      expect(result.isError).toBeFalsy();
      expect(edan.fetchMock).not.toHaveBeenCalled();
      const answer = answerOf(result);
      expect(answer.total_count).toBe(1001);
      expect(answer.objects).toHaveLength(1000);
      expect(result.structuredContent).toMatchObject({
        truncated: true,
        shown: 1000,
        cap: 1000,
        truncationCeiling: 1001,
      });
      const notice = answer.notice ?? '';
      const clamp = notice.indexOf(
        'rows 5000 exceeds the cap of 1000; the page was served with rows 1000.',
      );
      const guidance = notice.indexOf('1001 objects match; this page shows 1000 from offset 0.');
      expect(clamp).toBe(0);
      expect(guidance).toBeGreaterThan(clamp);
      expect(notice.indexOf(MIRROR_SENTENCE)).toBeGreaterThan(guidance);
      expect(notice.slice(-MIRROR_SENTENCE.length)).toBe(MIRROR_SENTENCE);
      expect(text(result)).toContain(notice);
    });

    it('sends a free-text search live, naming only edan_api and no snapshot', async () => {
      const edan = stubEdan();

      const result = await CALLS.free_text_search();

      expect(result.isError).toBeFalsy();
      expect(edan.requests('search').map((url) => url.searchParams.get('q'))).toEqual(['missile']);
      expect(edan.fetchMock).toHaveBeenCalledTimes(1);
      expect(answerOf(result).sources).toEqual(['edan_api']);
      expect(result.structuredContent).not.toHaveProperty('mirror_snapshot');
      expect(trailer(result, 'Sources')).toBe('**Sources:** `edan_api`');
      expect(trailer(result, 'Mirror snapshot')).toBeUndefined();
      expect(text(result)).not.toContain('Open Access mirror');
    });
  });

  describe('mirror off', () => {
    beforeEach(() => {
      initSmithsonianService({} as AppConfig, createInMemoryStorage());
    });

    it.each(Object.entries(CALLS))(
      '%s goes live and carries neither field nor a Sources line',
      async (_name, run) => {
        const edan = stubEdan();

        const result = await run();

        expect(result.isError).toBeFalsy();
        expect(edan.fetchMock).toHaveBeenCalled();
        expect(result.structuredContent).not.toHaveProperty('sources');
        expect(result.structuredContent).not.toHaveProperty('mirror_snapshot');
        expect(JSON.stringify(result.structuredContent)).not.toContain('Open Access mirror');
        expect(trailer(result, 'Sources')).toBeUndefined();
        expect(trailer(result, 'Mirror snapshot')).toBeUndefined();
        expect(text(result)).not.toContain('Open Access mirror');
      },
    );
  });

  describe('smithsonian_get_media images mode on mirrored records (issue #83)', () => {
    /**
     * Mirror-served images-mode output as the release before the `media` input wrote it, byte
     * for byte: `structuredContent` as an object whose key order is its JSON, and the
     * `content[]` text.
     */
    const RELEASED: Array<[name: string, input: object, structured: object, text: string]> = [
      [
        'every image of nasm_A19820121000',
        { id: 'nasm_A19820121000' },
        {
          record_id: 'nasm_A19820121000',
          title: 'Missile, Cruise, Air-launched, Flight Test, AGM-86B ALCM',
          is_cc0: true,
          cc0_image_count: 2,
          images: [
            {
              media_id: 'NASM-A19820121000-NASM2019-00593',
              is_cc0: true,
              alt_text: 'Metallic gray flight test model with US AIR FORCE inscription',
              description:
                'Flight test model #2 of cruise missile designed to be air-launched from B-52 and B1B bombers.',
              thumbnail_url:
                'https://ids.si.edu/ids/download?id=NASM-A19820121000-NASM2019-00593_thumb',
              screen_url:
                'https://ids.si.edu/ids/download?id=NASM-A19820121000-NASM2019-00593_screen',
              high_res_jpeg: {
                url: 'https://ids.si.edu/ids/download?id=NASM-A19820121000-NASM2019-00593.jpg',
                width: 8272,
                height: 6200,
              },
              high_res_tiff: {
                url: 'https://ids.si.edu/ids/download?id=NASM-A19820121000-NASM2019-00593.tif',
                width: 8272,
                height: 6200,
              },
            },
            {
              media_id: 'NASM-A19820121000cp17',
              is_cc0: true,
              description:
                'Flight test model #2 of cruise missile designed to be air-launched from B-52 and B1B bombers.',
              thumbnail_url: 'https://ids.si.edu/ids/download?id=NASM-A19820121000cp17_thumb',
              screen_url: 'https://ids.si.edu/ids/download?id=NASM-A19820121000cp17_screen',
              high_res_jpeg: {
                url: 'https://ids.si.edu/ids/deliveryService?id=NASM-A19820121000cp17',
              },
            },
          ],
          sources: ['oa_mirror'],
          mirror_snapshot: SNAPSHOT,
        },
        [
          '# Media: Missile, Cruise, Air-launched, Flight Test, AGM-86B ALCM',
          '**ID:** `nasm_A19820121000` | **Object CC0:** Yes',
          '**Images:** 2 of 2 CC0 image(s)',
          '',
          '### Image: NASM-A19820121000-NASM2019-00593',
          '**CC0:** Yes',
          '**Alt:** Metallic gray flight test model with US AIR FORCE inscription',
          '**Description:** Flight test model #2 of cruise missile designed to be air-launched from B-52 and B1B bombers.',
          '**Thumbnail:** ![Thumbnail](<https://ids.si.edu/ids/download?id=NASM-A19820121000-NASM2019-00593_thumb>)',
          '**Screen:** [Screen size](<https://ids.si.edu/ids/download?id=NASM-A19820121000-NASM2019-00593_screen>)',
          '**JPEG:** [Full-size JPEG](<https://ids.si.edu/ids/download?id=NASM-A19820121000-NASM2019-00593.jpg>) (8272×6200px)',
          '**TIFF:** [Archival TIFF](<https://ids.si.edu/ids/download?id=NASM-A19820121000-NASM2019-00593.tif>) (8272×6200px)',
          '### Image: NASM-A19820121000cp17',
          '**CC0:** Yes',
          '**Description:** Flight test model #2 of cruise missile designed to be air-launched from B-52 and B1B bombers.',
          '**Thumbnail:** ![Thumbnail](<https://ids.si.edu/ids/download?id=NASM-A19820121000cp17_thumb>)',
          '**Screen:** [Screen size](<https://ids.si.edu/ids/download?id=NASM-A19820121000cp17_screen>)',
          '**JPEG:** [Full-size JPEG](<https://ids.si.edu/ids/deliveryService?id=NASM-A19820121000cp17>)',
          '',
          '',
          '**Sources:** `oa_mirror`',
          `**Mirror snapshot:** \`${SNAPSHOT}\``,
        ].join('\n'),
      ],
      [
        'a truncated page of hac_FJP.1987.074',
        { id: 'hac_FJP.1987.074', start: 0, limit: 1 },
        {
          record_id: 'hac_FJP.1987.074',
          title: 'Bouquet holder, flowers and leaves motif, curlicue handle',
          is_cc0: true,
          cc0_image_count: 2,
          images: [
            {
              media_id: 'SG-FJP-1987-074_001',
              is_cc0: true,
              thumbnail_url: 'https://ids.si.edu/ids/download?id=SG-FJP-1987-074_001_thumb',
              screen_url: 'https://ids.si.edu/ids/download?id=SG-FJP-1987-074_001_screen',
              high_res_jpeg: {
                url: 'https://ids.si.edu/ids/download?id=SG-FJP-1987-074_001.jpg',
                width: 2993,
                height: 4084,
              },
              high_res_tiff: {
                url: 'https://ids.si.edu/ids/download?id=SG-FJP-1987-074_001.tif',
                width: 2993,
                height: 4084,
              },
            },
          ],
          truncated: true,
          shown: 1,
          cap: 1,
          truncationCeiling: 2,
          notice:
            '2 CC0 images; this page shows 1 from start 0. Retrieve the next page with start: 1, or omit limit to return every remaining image.',
          sources: ['oa_mirror'],
          mirror_snapshot: SNAPSHOT,
        },
        [
          '# Media: Bouquet holder, flowers and leaves motif, curlicue handle',
          '**ID:** `hac_FJP.1987.074` | **Object CC0:** Yes',
          '**Images:** 1 of 2 CC0 image(s)',
          '',
          '### Image: SG-FJP-1987-074_001',
          '**CC0:** Yes',
          '**Thumbnail:** ![Thumbnail](<https://ids.si.edu/ids/download?id=SG-FJP-1987-074_001_thumb>)',
          '**Screen:** [Screen size](<https://ids.si.edu/ids/download?id=SG-FJP-1987-074_001_screen>)',
          '**JPEG:** [Full-size JPEG](<https://ids.si.edu/ids/download?id=SG-FJP-1987-074_001.jpg>) (2993×4084px)',
          '**TIFF:** [Archival TIFF](<https://ids.si.edu/ids/download?id=SG-FJP-1987-074_001.tif>) (2993×4084px)',
          '',
          '',
          '**Sources:** `oa_mirror`',
          `**Mirror snapshot:** \`${SNAPSHOT}\``,
          '**truncated:** true',
          '**shown:** 1',
          '**cap:** 1',
          '**truncationCeiling:** 2',
          '> 2 CC0 images; this page shows 1 from start 0. Retrieve the next page with start: 1, or omit limit to return every remaining image.',
        ].join('\n'),
      ],
      [
        'no_media on dpo_3d_200085',
        { id: 'dpo_3d_200085' },
        {
          error: {
            code: -32001,
            message: 'Object "dpo_3d_200085" has no digitized online media.',
            data: {
              record_id: 'dpo_3d_200085',
              title: 'Homo neanderthalensis',
              reason: 'no_media',
              recovery: {
                hint: 'The physical object may not have been digitized. Use smithsonian_search_objects to find similar objects with media.',
              },
            },
          },
        },
        [
          'Error: Object "dpo_3d_200085" has no digitized online media.',
          '',
          'Recovery: The physical object may not have been digitized. Use smithsonian_search_objects to find similar objects with media.',
          '',
          '(reason no_media)',
        ].join('\n'),
      ],
    ];

    beforeEach(() => {
      initSmithsonianService({} as AppConfig, createInMemoryStorage(), t.reader);
    });

    it.each(RELEASED)(
      '%s, media omitted, is byte-identical to the release on both surfaces',
      async (_name, input, structured, expected) => {
        const edan = stubEdan();

        const result = await runToolContract(smithsonianGetMedia, input as never);

        expect(edan.fetchMock).not.toHaveBeenCalled();
        expect(JSON.stringify(result.structuredContent)).toBe(JSON.stringify(structured));
        expect(text(result)).toBe(expected);
      },
    );

    it.each(RELEASED)(
      '%s, media "images", is byte-identical to the release on both surfaces',
      async (_name, input, structured, expected) => {
        const edan = stubEdan();

        const result = await runToolContract(smithsonianGetMedia, {
          ...input,
          media: 'images',
        } as never);

        expect(edan.fetchMock).not.toHaveBeenCalled();
        expect(JSON.stringify(result.structuredContent)).toBe(JSON.stringify(structured));
        expect(text(result)).toBe(expected);
      },
    );

    const NO_IMAGES_HINT =
      'This object\'s online media is 3d_voyager, none of it images. Call smithsonian_get_media { id: "dpo_3d_200122", media: "3d" } for its 3D model files.';

    it.each([
      ['mirror-served', true],
      ['live', false],
    ])(
      'fails dpo_3d_200122 no_images on a %s read, naming the media "3d" call on both surfaces',
      async (_name, mirrored) => {
        if (!mirrored) initSmithsonianService({} as AppConfig, createInMemoryStorage());
        const edan = stubEdan();

        const result = await runToolContract(smithsonianGetMedia, { id: 'dpo_3d_200122' });

        expect(edan.requests('content')).toHaveLength(mirrored ? 0 : 1);
        const error = errorOf(result);
        expect(error.data?.reason).toBe('no_images');
        expect(error.data?.recovery?.hint).toBe(NO_IMAGES_HINT);
        expect(text(result)).toContain(`Recovery: ${NO_IMAGES_HINT}`);
        expect(text(result)).toContain('(reason no_images)');
      },
    );

    it('returns the same dpo_3d_200122 models from a mirror-served read as from a live one', async () => {
      const mirrored = stubEdan();
      const fromMirror = await runToolContract(smithsonianGetMedia, {
        id: 'dpo_3d_200122',
        media: '3d',
      });
      expect(mirrored.fetchMock).not.toHaveBeenCalled();

      initSmithsonianService({} as AppConfig, createInMemoryStorage());
      const live = stubEdan();
      const fromLive = await runToolContract(smithsonianGetMedia, {
        id: 'dpo_3d_200122',
        media: '3d',
      });
      expect(live.requests('content')).toHaveLength(1);

      const { sources, mirror_snapshot, ...served } = fromMirror.structuredContent as Record<
        string,
        unknown
      >;
      expect(sources).toEqual(['oa_mirror']);
      expect(mirror_snapshot).toBe(SNAPSHOT);
      expect(served).toStrictEqual(fromLive.structuredContent);
      expect((served.models as Array<{ files: unknown[] }>)[0]?.files).toHaveLength(7);
      expect(text(fromMirror)).toContain(text(fromLive));
    });

    it('returns the dpo_3d_200122 package and its seven files on both surfaces from a live read', async () => {
      initSmithsonianService({} as AppConfig, createInMemoryStorage());
      const edan = stubEdan();

      const result = await runToolContract(smithsonianGetMedia, {
        id: 'dpo_3d_200122',
        media: '3d',
      });

      expect(edan.requests('content')).toHaveLength(1);
      expect(result.isError).toBeFalsy();
      const answer = result.structuredContent as {
        cc0_image_count: number;
        cc0_model_count: number;
        images: unknown[];
        models: Array<{
          media_id: string;
          viewer_url?: string;
          files: Array<{ url: string; filename?: string; size_bytes?: number }>;
        }>;
      };
      expect(answer).toMatchObject({ cc0_image_count: 0, cc0_model_count: 1, images: [] });
      const model = answer.models[0];
      expect(model?.media_id).toBe('3d_package:c0bc58e6-b172-4543-ad58-50261aea523c');
      expect(model?.files).toHaveLength(7);
      expect(model?.files.find((f) => f.filename === 'TYCHO-print_ready.zip')).toMatchObject({
        category: 'Watertight',
        file_type: 'zip',
        model_file_type: 'stl',
        units: 'm',
        draco_compressed: false,
        size_bytes: 25027679,
      });
      const rendered = text(result);
      expect(rendered).toContain('### Model: 3d_package:c0bc58e6-b172-4543-ad58-50261aea523c');
      expect(rendered).toContain(`**Viewer:** [Voyager 3D viewer](<${model?.viewer_url}>)`);
      for (const file of model?.files ?? []) {
        expect(rendered).toContain(`- [${file.filename}](<${file.url}>)`);
        expect(rendered).toContain(`Size: ${file.size_bytes} bytes`);
      }
    });
  });

  describe('advertised outputSchema', () => {
    /**
     * One tool's advertised output schema. Every property is optional at the root, since a
     * failed call carries `error` alone; the success branch of `anyOf` (the one that excludes
     * `error`) lists the keys a successful call requires.
     */
    interface AdvertisedOutput {
      anyOf?: Array<{ not?: unknown; required?: string[] }>;
      properties: Record<string, unknown>;
    }

    let advertised: Map<string, AdvertisedOutput>;

    beforeAll(async () => {
      // The handler writes these into process.env; stubbing them first lets unstubAllEnvs restore them.
      vi.stubEnv('IS_SERVERLESS', 'true');
      vi.stubEnv('MCP_TRANSPORT_TYPE', 'http');
      vi.stubEnv('MCP_LOG_LEVEL', 'error');
      const handler = createWorkerHandler({
        name: 'smithsonian-mcp-server',
        tools: [
          smithsonianSearchObjects,
          smithsonianBrowseCategory,
          smithsonianFindRelated,
          smithsonianGetObject,
          smithsonianGetMedia,
          smithsonianListTerms,
        ],
      });
      const response = await handler.fetch(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2026-07-28',
            'Mcp-Method': 'tools/list',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientCapabilities': {},
              },
            },
          }),
        }),
        { LOG_LEVEL: 'error' } as never,
        { waitUntil() {}, passThroughOnException() {} } as never,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        result: { tools: Array<{ name: string; outputSchema: AdvertisedOutput }> };
      };
      advertised = new Map(body.result.tools.map((tool) => [tool.name, tool.outputSchema]));
    });

    /** Each tool's other advertised output keys: its fields, other enrichment, and `error`. */
    const PAGE_ENRICHMENT = ['truncated', 'shown', 'cap', 'truncationCeiling', 'notice'];

    it.each([
      ['smithsonian_search_objects', ['objects', 'total_count', ...PAGE_ENRICHMENT, 'error']],
      [
        'smithsonian_browse_category',
        [
          'mode',
          'value',
          'total_count',
          'sample_objects',
          'museum_breakdown',
          ...PAGE_ENRICHMENT,
          'error',
        ],
      ],
      [
        'smithsonian_find_related',
        ['anchor', 'related', 'search_signals_used', 'signals', ...PAGE_ENRICHMENT, 'error'],
      ],
      [
        'smithsonian_get_object',
        [
          'record_id',
          'title',
          'unit_code',
          'museum_name',
          'holding_museum_name',
          'dates',
          'description',
          'notes',
          'scientific_names',
          'taxonomy',
          'coordinates',
          'makers',
          'physical_description',
          'place',
          'culture',
          'topics',
          'indexed',
          'exhibitions',
          'on_view',
          'current_exhibitions',
          'sets',
          'credit_line',
          'identifiers',
          'object_rights',
          'is_cc0',
          'record_link',
          'media_summary',
          'error',
        ],
      ],
      [
        'smithsonian_get_media',
        [
          'record_id',
          'title',
          'is_cc0',
          'cc0_image_count',
          'images',
          'cc0_model_count',
          'models',
          ...PAGE_ENRICHMENT,
          'error',
        ],
      ],
    ])(
      '%s advertises exactly sources and mirror_snapshot beyond its own keys, both optional',
      (name, own) => {
        const schema = advertised.get(name);

        expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(
          [...own, 'sources', 'mirror_snapshot'].sort(),
        );
        const success = schema?.anyOf?.find((branch) => branch.not !== undefined);
        expect(success?.required).toContain(own[0]);
        expect(success?.required).not.toContain('sources');
        expect(success?.required).not.toContain('mirror_snapshot');
        expect(schema?.properties.sources).toMatchObject({
          type: 'array',
          items: { type: 'string', enum: ['oa_mirror', 'edan_api'] },
        });
        expect(schema?.properties.mirror_snapshot).toMatchObject({ type: 'string' });
      },
    );

    it('smithsonian_list_terms advertises neither field', () => {
      expect(
        Object.keys(advertised.get('smithsonian_list_terms')?.properties ?? {}).sort(),
      ).toEqual(['field', 'terms', 'total', 'labels', ...PAGE_ENRICHMENT, 'error'].sort());
    });

    it('smithsonian_get_media keeps the release required list; models and cc0_model_count are optional (issue #83)', () => {
      const schema = advertised.get('smithsonian_get_media');
      const success = schema?.anyOf?.find((branch) => branch.not !== undefined);

      expect(success?.required).toEqual([
        'record_id',
        'title',
        'is_cc0',
        'cc0_image_count',
        'images',
      ]);
      expect(schema?.properties.cc0_model_count).toMatchObject({ type: 'number' });
      expect(schema?.properties.models).toMatchObject({
        type: 'array',
        items: {
          type: 'object',
          required: ['media_id', 'is_cc0', 'files'],
          properties: {
            files: { type: 'array', items: { type: 'object', required: ['url'] } },
          },
        },
      });
    });
  });
});
