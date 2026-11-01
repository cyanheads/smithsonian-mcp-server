/**
 * @fileoverview Tests for SmithsonianService — HTTP layer mocked via vi.stubGlobal.
 * @module tests/services/smithsonian/smithsonian-service.test
 */

import { readFileSync } from 'node:fs';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  createInMemoryStorage,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { smithsonianFindRelated } from '@/mcp-server/tools/definitions/smithsonian-find-related.tool.js';
import { smithsonianGetMedia } from '@/mcp-server/tools/definitions/smithsonian-get-media.tool.js';
import { smithsonianGetObject } from '@/mcp-server/tools/definitions/smithsonian-get-object.tool.js';
import { smithsonianSearchObjects } from '@/mcp-server/tools/definitions/smithsonian-search-objects.tool.js';
import type { FacetFilter } from '@/services/smithsonian/oa-mirror.js';
import {
  hasActiveLuceneSyntax,
  initSmithsonianService,
  luceneField,
  SmithsonianService,
  toPlainText,
} from '@/services/smithsonian/smithsonian-service.js';
import type {
  RawContentResponse,
  RawEDAN,
  RawSearchResponse,
} from '@/services/smithsonian/types.js';
import { FakeBucket, openTestMirror, type TestMirror } from './oa-bucket-fake.js';

describe('query syntax scanner', () => {
  it.each(['Wright AND Flyer', 'NOT Flyer', 'Wright && Flyer', 'name:Wright', '(Wright (Flyer))'])(
    'recognizes active syntax: %s',
    (query) => {
      expect(hasActiveLuceneSyntax(query)).toBe(true);
    },
  );

  it.each([
    '"OR"',
    '"(literal)"',
    '\\OR',
    'ORange',
    '"unfinished',
    'name\\:Wright',
    'plain\\\\text',
  ])('preserves literal syntax: %s', (query) => {
    expect(hasActiveLuceneSyntax(query)).toBe(false);
  });

  it.each(['line', 'lines', 'unclosed phrase', 'operator prefixes'])(
    'scans caller text within CPU bounds: %s',
    (shape) => {
      const samples = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000].map((size) => ({
        cpuPerScan: Number.POSITIVE_INFINITY,
        query:
          shape === 'line'
            ? `${'\\('.repeat(size / 2)}\n`
            : shape === 'lines'
              ? '\\(\n'.repeat(Math.ceil(size / 3))
              : shape === 'unclosed phrase'
                ? `"${'((\\"'.repeat(Math.ceil(size / 4))}`
                : 'ORange ANDerson NOTice\n'.repeat(Math.ceil(size / 22)),
      }));
      const measure = (sample: (typeof samples)[number]) => {
        const start = process.threadCpuUsage();
        let runs = 0;
        let cpu = 0;
        // Accumulate measurable CPU even on clocks that report coarse ticks.
        do {
          expect(hasActiveLuceneSyntax(sample.query)).toBe(false);
          runs++;
          const elapsed = process.threadCpuUsage(start);
          cpu = elapsed.user + elapsed.system;
          expect(cpu).toBeLessThan(1_000_000);
        } while (cpu < 20_000);
        expect(cpu / runs).toBeLessThan(100_000);
        sample.cpuPerScan = Math.min(sample.cpuPerScan, cpu / runs);
      };
      // Establish the absolute bound before advancing to each doubled size.
      for (const sample of samples) measure(sample);
      const alternate = [0, 6, 1, 5, 2, 4, 3].map((index) => samples[index]!);
      for (const order of [alternate, alternate.toReversed()]) {
        for (const sample of order) measure(sample);
      }
      const ratio = () => samples.at(-1)!.cpuPerScan / samples[0]!.cpuPerScan;
      if (ratio() >= 256) {
        for (const order of [alternate, alternate.toReversed(), alternate]) {
          for (const sample of order) measure(sample);
        }
      }
      expect(ratio()).toBeLessThan(256);
    },
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(storage: StorageService = createInMemoryStorage()): SmithsonianService {
  return new SmithsonianService(storage);
}

/**
 * A context carrying a tenant, required by every storage-backed path — the term
 * vocabulary cache reads and writes tenant-scoped keys (issue #38). Real contexts
 * always carry one ('default' on stdio); the bare mock does not.
 */
function makeTenantContext() {
  return createMockContext({ tenantId: 'test-tenant' });
}

/**
 * The recovery text `smithsonian_get_object` declares for `not_found`. All three
 * ID tools declare the same entry, and the framework fills it from whichever one is
 * executing, so asserting through one contract covers the shared service path.
 */
const NOT_FOUND_RECOVERY = smithsonianGetObject.errors?.find(
  (e) => e.reason === 'not_found',
)?.recovery;

/** Build a minimal search response with one row. */
function makeSearchResponse(
  overrides: Partial<RawSearchResponse['response']> = {},
): RawSearchResponse {
  return {
    status: 200,
    responseCode: 1,
    response: {
      rows: [
        {
          id: 'ld1-abc',
          title: 'Test Object',
          unitCode: 'NASM',
          type: 'edanmdm',
          url: 'edanmdm:nasm_TEST001',
          content: {
            descriptiveNonRepeating: {
              record_ID: 'nasm_TEST001',
              unit_code: 'NASM',
              data_source: 'National Air and Space Museum',
              metadata_usage: { access: 'CC0' },
              online_media: {
                mediaCount: 1,
                media: [
                  {
                    type: 'Images',
                    usage: { access: 'CC0' },
                    thumbnail: 'https://ids.si.edu/thumb',
                  },
                ],
              },
            },
            indexedStructured: {
              object_type: ['Aircraft'],
              culture: ['American'],
              date: ['1960s'],
            },
            freetext: {
              notes: [{ label: 'Summary', content: 'A test aircraft.' }],
            },
          },
        },
      ],
      rowCount: 42,
      ...overrides,
    },
  };
}

/** Build a minimal content response. */
function makeContentResponse(recordId: string, isCC0 = true): RawContentResponse {
  return {
    status: 200,
    responseCode: 1,
    response: {
      id: 'ld1-abc',
      title: 'Test Object',
      unitCode: 'NASM',
      type: 'edanmdm',
      url: `edanmdm:${recordId}`,
      content: {
        descriptiveNonRepeating: {
          record_ID: recordId,
          unit_code: 'NASM',
          metadata_usage: { access: isCC0 ? 'CC0' : 'Usage Conditions Apply' },
          online_media: {
            mediaCount: 1,
            media: [
              {
                id: 'media:TEST001',
                idsId: 'NASM-TEST001',
                type: 'Images',
                usage: { access: isCC0 ? 'CC0' : 'Usage Conditions Apply' },
                content: 'https://ids.si.edu/ids/deliveryService?id=NASM-TEST001',
                thumbnail: 'https://ids.si.edu/ids/deliveryService?id=NASM-TEST001_thumb',
                altTextAccessibility: 'Test aircraft on display.',
                resources: [
                  {
                    label: 'High-resolution JPEG',
                    url: 'https://ids.si.edu/ids/download?id=NASM-TEST001.jpg',
                    width: 8000,
                    height: 5000,
                  },
                  {
                    label: 'Screen Image',
                    url: 'https://ids.si.edu/ids/download?id=NASM-TEST001_screen',
                  },
                ],
              },
            ],
          },
        },
        freetext: {
          notes: [{ label: 'Summary', content: 'A test object description.' }],
        },
        indexedStructured: { culture: ['American'], object_type: ['Aircraft'] },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

function mockFetch(response: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => response,
      text: async () => JSON.stringify(response),
    }),
  );
}

/**
 * Mock fetch returning HTTP 429 with the real API's error body shape.
 * The live Smithsonian API returns HTTP 429 (not HTTP 200) for rate limits.
 * fetchWithTimeout reads `response.ok === false` and throws RateLimited before
 * the service layer ever parses the body.
 */
function mockFetch429(): void {
  const errorBody = JSON.stringify({
    error: {
      code: 'OVER_RATE_LIMIT',
      message:
        'You have exceeded your rate limit. Try again later or contact us at https://api.si.edu:443/contact/ for assistance',
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: { get: (name: string) => (name === 'retry-after' ? '40' : null) },
      text: async () => errorBody,
      json: async () => JSON.parse(errorBody),
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SmithsonianService', () => {
  beforeEach(() => {
    vi.stubEnv('SMITHSONIAN_API_KEY', 'test-key-12345');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('search()', () => {
    it('returns normalized ObjectSummary rows and rowCount', async () => {
      mockFetch(makeSearchResponse());
      const svc = makeService();
      const ctx = makeTenantContext();
      const result = await svc.search({ query: 'aircraft', rows: 10, start: 0 }, ctx);
      expect(result.rowCount).toBe(42);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.record_id).toBe('nasm_TEST001');
      expect(result.rows[0]?.title).toBe('Test Object');
      expect(result.rows[0]?.unit_code).toBe('NASM');
      expect(result.rows[0]?.is_cc0).toBe(true);
      expect(result.rows[0]?.has_media).toBe(true);
      // date is normalized from indexedStructured.date[0], like object_type (issue #20).
      expect(result.rows[0]?.date).toBe('1960s');
    });

    it('sends api key as X-Api-Key header — not in the URL', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => makeSearchResponse(),
        text: async () => JSON.stringify(makeSearchResponse()),
      });
      vi.stubGlobal('fetch', fetchMock);
      const svc = makeService();
      const ctx = makeTenantContext();
      await svc.search({ query: 'test', rows: 5, start: 0 }, ctx);
      const calledUrl = (fetchMock.mock.calls[0] as [string])[0];
      const calledInit = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
      // Key must not appear in the URL query string
      expect(calledUrl).not.toContain('api_key');
      expect(calledUrl).not.toContain('test-key-12345');
      // Key must be present in the X-Api-Key header
      const headers = calledInit?.headers as Record<string, string> | undefined;
      expect(headers?.['X-Api-Key']).toBe('test-key-12345');
    });

    const NASM: FacetFilter[] = [{ field: 'unit_code', value: 'NASM' }];

    it.each([
      ['Wright OR Flyer', NASM, '(Wright OR Flyer) AND unit_code:"NASM"'],
      ['(Wright Flyer)', NASM, '((Wright Flyer)) AND unit_code:"NASM"'],
      ['', NASM, 'unit_code:"NASM"'],
      ['*', NASM, 'unit_code:"NASM"'],
      ['totem pole', [], 'totem pole'],
    ])(
      'preserves existing explicit and filter-only query behavior: %s',
      async (query, filters, expected) => {
        const fetchMock = vi
          .fn()
          .mockResolvedValue({ ok: true, status: 200, json: async () => makeSearchResponse() });
        vi.stubGlobal('fetch', fetchMock);
        await makeService().search({ query, filters, rows: 1, start: 0 }, makeTenantContext());
        expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get('q')).toBe(expected);
      },
    );

    it.each([
      'totem pole',
      '"Wright OR Flyer"',
      '"(Wright Flyer)"',
      'Wright \\(Flyer\\)',
      '"Wright \\" OR Flyer"',
      'Wright \\OR Flyer',
    ])('keeps implicit or literal query matching when filtering: %s', async (query) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: async () => makeSearchResponse() });
      vi.stubGlobal('fetch', fetchMock);
      await makeService().search({ query, filters: NASM, rows: 1, start: 0 }, makeTenantContext());
      expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get('q')).toBe(
        `${query} AND unit_code:"NASM"`,
      );
    });

    it('embeds filters into q as ANDed Lucene constraints', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => makeSearchResponse(),
        text: async () => JSON.stringify(makeSearchResponse()),
      });
      vi.stubGlobal('fetch', fetchMock);
      const svc = makeService();
      const ctx = makeTenantContext();
      await svc.search(
        { query: 'test', rows: 5, start: 0, filters: [...NASM, { field: 'cc0' }] },
        ctx,
      );
      const calledUrl = (fetchMock.mock.calls[0] as [string])[0];
      // Filters must appear in q, not as separate fq params
      expect(calledUrl).not.toContain('fq=');
      const qs = new URL(calledUrl).searchParams;
      const q = qs.get('q') ?? '';
      // Plain terms stay ungrouped so EDAN preserves implicit matching.
      expect(q).toBe('test AND unit_code:"NASM" AND media_usage:CC0');
    });

    it('throws on API_KEY_MISSING error-in-200', async () => {
      mockFetch({ error: { code: 'API_KEY_MISSING', message: 'No api_key was supplied.' } });
      const svc = makeService();
      const ctx = makeTenantContext();
      await expect(svc.search({ query: 'test', rows: 5, start: 0 }, ctx)).rejects.toThrow(
        /API key missing/i,
      );
    });

    it('API_KEY_MISSING error-in-200 uses InternalError code — not retryable', async () => {
      mockFetch({ error: { code: 'API_KEY_MISSING', message: 'No api_key was supplied.' } });
      const svc = makeService();
      const ctx = makeTenantContext();
      const err = await svc.search({ query: 'test', rows: 5, start: 0 }, ctx).catch((e) => e);
      // InternalError (-32603) is NOT in withRetry's retryable set — config errors surface immediately.
      expect(err.code).toBe(JsonRpcErrorCode.InternalError);
    });

    it('OVER_RATE_LIMIT error-in-200 uses ServiceUnavailable code — retryable', async () => {
      // withRetry retries on ServiceUnavailable with exponential backoff (base 2s, max 3 retries).
      // Use fake timers to skip the delay and exhaust retries instantly.
      vi.useFakeTimers();
      mockFetch({
        error: { code: 'OVER_RATE_LIMIT', message: 'Rate limit exceeded.' },
      });
      const svc = makeService();
      const ctx = makeTenantContext();
      const promise = svc.search({ query: 'test', rows: 5, start: 0 }, ctx).catch((e) => e);
      // Advance time past all backoff intervals (2s + 4s + 8s = 14s)
      await vi.runAllTimersAsync();
      const err = await promise;
      vi.useRealTimers();
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    });

    it('HTTP 429 response uses RateLimited code — real API shape', async () => {
      // The live Smithsonian API returns HTTP 429 (not HTTP 200) for rate limits.
      // fetchWithTimeout maps 429 → RateLimited (-32003) before the service body parser runs.
      // RateLimited is in withRetry's TRANSIENT_CODES — use fake timers to exhaust retries.
      vi.useFakeTimers();
      mockFetch429();
      const svc = makeService();
      const ctx = makeTenantContext();
      const promise = svc.search({ query: 'test', rows: 5, start: 0 }, ctx).catch((e) => e);
      await vi.runAllTimersAsync();
      const err = await promise;
      vi.useRealTimers();
      expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    });

    it('handles sparse row — missing optional fields do not throw', async () => {
      const sparseResponse: RawSearchResponse = {
        status: 200,
        responseCode: 1,
        response: {
          rows: [{ id: 'ld1-sparse', title: 'Sparse Object', unitCode: 'NMNH', type: 'edanmdm' }],
          rowCount: 1,
        },
      };
      mockFetch(sparseResponse);
      const svc = makeService();
      const ctx = makeTenantContext();
      const result = await svc.search({ query: 'sparse', rows: 5, start: 0 }, ctx);
      // record_id falls back to the raw id when record_ID and url are absent
      expect(result.rows[0]?.record_id).toBe('ld1-sparse');
      expect(result.rows[0]?.is_cc0).toBe(false);
      expect(result.rows[0]?.has_media).toBe(false);
      // No indexedStructured on the sparse row → date stays undefined (issue #20).
      expect(result.rows[0]?.date).toBeUndefined();
    });
  });

  describe('getContent()', () => {
    it('returns the raw EDAN object directly from response', async () => {
      mockFetch(makeContentResponse('nasm_TEST001'));
      const svc = makeService();
      const ctx = makeTenantContext();
      const { record: raw } = await svc.getContent('nasm_TEST001', ctx);
      expect(raw.title).toBe('Test Object');
      expect(raw.content?.descriptiveNonRepeating?.record_ID).toBe('nasm_TEST001');
    });

    it('prepends edanmdm: prefix when missing', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => makeContentResponse('nasm_TEST001'),
        text: async () => JSON.stringify(makeContentResponse('nasm_TEST001')),
      });
      vi.stubGlobal('fetch', fetchMock);
      const svc = makeService();
      const ctx = makeTenantContext();
      await svc.getContent('nasm_TEST001', ctx);
      const calledUrl = (fetchMock.mock.calls[0] as [string])[0];
      expect(calledUrl).toContain('edanmdm%3Anasm_TEST001');
    });

    it('throws notFound with reason "not_found" when response is absent', async () => {
      mockFetch({ status: 200, responseCode: 1, response: null });
      const svc = makeService();
      const ctx = makeTenantContext();
      const err = await svc.getContent('nasm_MISSING', ctx).catch((e) => e);
      expect(err.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err.message).toMatch(/No Smithsonian object/i);
      // The declared not_found contract must be carried in data (issue #10).
      expect(err.data?.reason).toBe('not_found');
      expect(err.data?.recordId).toBe('nasm_MISSING');
      // The service carries no recovery; the framework fills the executing tool's
      // declared hint from the reason.
      expect(err.data?.recovery).toBeUndefined();
    });

    it("carries the calling tool's declared recovery hint when response is absent (issue #25)", async () => {
      // Resolved from the real tool contract, not a copied string — so a contract
      // reword can't silently drift away from what reaches the wire.
      mockFetch({ status: 200, responseCode: 1, response: null });
      initSmithsonianService({} as AppConfig, createInMemoryStorage());
      const result = await runToolContract(smithsonianGetObject, { id: 'nasm_MISSING' });
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'not_found', recovery: { hint: NOT_FOUND_RECOVERY } } },
      });
    });

    it('HTTP 404 from content endpoint surfaces as notFound — not retried', async () => {
      // fetchWithTimeout throws NotFound on HTTP 404; getContent re-wraps it with record context.
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          headers: { get: () => null },
          text: async () => '{"error":{"code":"NOT_FOUND","message":"Record not found"}}',
        }),
      );
      const svc = makeService();
      const ctx = makeTenantContext();
      const err = await svc.getContent('nasm_MISSING', ctx).catch((e) => e);
      expect(err.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err.message).toMatch(/nasm_MISSING/i);
      // Live-exercised path (real HTTP 404 → real notFound factory): reason must be present.
      expect(err.data?.reason).toBe('not_found');
    });

    it('carries the declared recovery hint on the HTTP 404 rewrap path too (issue #25)', async () => {
      // The 404 catch/rewrap is a second, independent throw site — both must resolve.
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          headers: { get: () => null },
          text: async () => '{"error":{"code":"NOT_FOUND","message":"Record not found"}}',
        }),
      );
      initSmithsonianService({} as AppConfig, createInMemoryStorage());
      const result = await runToolContract(smithsonianGetObject, { id: 'nasm_MISSING' });
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'not_found', recovery: { hint: NOT_FOUND_RECOVERY } } },
      });
    });

    it('reads object from response directly — not response.rows[0] (content endpoint shape)', async () => {
      // The content endpoint shape: { response: <object> }
      // NOT the search shape: { response: { rows: [<object>] } }
      // If the code mistakenly accessed .rows[0], title would be undefined.
      const contentShape: RawContentResponse = {
        status: 200,
        responseCode: 1,
        response: {
          id: 'ld1-direct',
          title: 'Direct Response Object',
          unitCode: 'SAAM',
          content: {
            descriptiveNonRepeating: {
              record_ID: 'saam_DIRECT001',
              metadata_usage: { access: 'CC0' },
            },
          },
        },
      };
      mockFetch(contentShape);
      const svc = makeService();
      const ctx = makeTenantContext();
      const { record: raw } = await svc.getContent('saam_DIRECT001', ctx);
      // Asserts the envelope was unwrapped at `response`, not `response.rows[0]`
      expect(raw.title).toBe('Direct Response Object');
      expect(raw.content?.descriptiveNonRepeating?.record_ID).toBe('saam_DIRECT001');
    });
  });

  describe('toFullObject()', () => {
    it.each([
      ['90', '180', 'decimal', 'decimal', true],
      ['-90', '-180', 'decimal', 'decimal', true],
      ['8.6194123456789', '-80.5792123456789', 'decimal', 'decimal', true],
      ['1', '181', 'decimal', 'decimal', false],
      ['1', '-181', 'decimal', 'decimal', false],
      ['1', '', 'decimal', 'decimal', false],
      ['1', '2', 'degrees', 'decimal', false],
      ['1', '2', 'decimal', 'degrees', false],
    ])(
      'preserves only valid reported decimal coordinate pairs: %s %s %s %s',
      (latitude, longitude, latType, lonType, valid) => {
        const full = makeService().toFullObject({
          content: {
            indexedStructured: {
              geoLocation: [
                {
                  Other: { type: 'Country', content: 'No locality' },
                  points: {
                    point: {
                      latitude: { type: latType, content: latitude },
                      longitude: { type: lonType, content: longitude },
                    },
                  },
                },
              ],
            },
          },
        });
        expect(full.coordinates).toEqual(
          valid ? [{ latitude: Number(latitude), longitude: Number(longitude) }] : [],
        );
      },
    );
    it('preserves specimen names, ranks, sparse decimal points and same-entry locality', () => {
      const full = makeService().toFullObject({
        content: {
          indexedStructured: {
            scientific_name: ['Gonocephalus chamaeleontinus', 'Gonocephalus kuhlii'],
            tax_kingdom: ['Animalia'],
            tax_family: ['Agamidae', 'Other family'],
            geoLocation: [
              { Other: { type: 'Locality', content: 'Mount Gede, Tjibodas' } },
              {
                Other: { type: 'Locality', content: 'El Copé' },
                points: {
                  point: {
                    latitude: { type: 'decimal', content: '8.6194' },
                    longitude: { type: 'decimal', content: '-80.5792' },
                  },
                },
              },
              {
                points: {
                  point: {
                    latitude: { type: 'decimal', content: '0' },
                    longitude: { type: 'decimal', content: '0' },
                  },
                },
              },
            ],
          },
        },
      });
      expect(full.scientific_names).toEqual([
        'Gonocephalus chamaeleontinus',
        'Gonocephalus kuhlii',
      ]);
      expect(full.taxonomy).toEqual({
        kingdom: ['Animalia'],
        family: ['Agamidae', 'Other family'],
      });
      expect(full.coordinates).toEqual([
        { latitude: 8.6194, longitude: -80.5792, locality: 'El Copé' },
        { latitude: 0, longitude: 0 },
      ]);
      expect(makeService().toFullObject({})).toMatchObject({
        scientific_names: [],
        coordinates: [],
      });
      expect(makeService().toFullObject({}).taxonomy).toBeUndefined();
    });

    it.each(['', ' ', 'NaN', 'Infinity', '0x10', '12oops', '91', '-91'])(
      'omits invalid specimen latitude without substituting zero: %s',
      (value) => {
        const full = makeService().toFullObject({
          content: {
            indexedStructured: {
              geoLocation: [
                {
                  points: {
                    point: {
                      latitude: { type: 'decimal', content: value },
                      longitude: { type: 'decimal', content: '0' },
                    },
                  },
                },
              ],
            },
          },
        });
        expect(full.coordinates).toEqual([]);
      },
    );
    it.each([
      'Summary',
      'Extended Physical Description',
      'Brief Description',
      'Description',
      'Description (Brief)',
      'Citation',
    ])('preserves recognized prose: %s', (label) => {
      const full = makeService().toFullObject({
        content: { freetext: { notes: [{ label, content: 'Useful prose' }] } },
      });
      expect(full.description).toBe('Useful prose');
    });

    it('keeps administrative and repeated notes labeled without inventing prose', () => {
      const full = makeService().toFullObject({
        content: {
          freetext: {
            notes: [
              { label: 'Record Last Modified', content: '12 Jan 2026' },
              { label: 'Location', content: 'Currently not on view' },
              { label: 'Specimen Count', content: '2' },
              { label: 'Location', content: '<b>Storage</b> &amp;#39;' },
              { content: 'Unlabeled' },
              { label: 'Empty', content: '' },
            ],
          },
        },
      });
      expect(full.description).toBeUndefined();
      expect(full.notes).toEqual([
        { label: 'Record Last Modified', content: '12 Jan 2026' },
        { label: 'Location', content: 'Currently not on view' },
        { label: 'Specimen Count', content: '2' },
        { label: 'Location', content: 'Storage &#39;' },
        { label: 'Note', content: 'Unlabeled' },
      ]);
      expect(makeService().toFullObject({}).notes).toEqual([]);
    });
    it('normalizes all metadata fields correctly', () => {
      const svc = makeService();
      const raw = makeContentResponse('nasm_TEST001').response!;
      const full = svc.toFullObject(raw);
      expect(full.record_id).toBe('nasm_TEST001');
      expect(full.title).toBe('Test Object');
      expect(full.is_cc0).toBe(true);
      expect(full.description).toBe('A test object description.');
      expect(full.culture).toEqual(['American']);
      expect(full.media_summary.count).toBe(1);
      expect(full.media_summary.cc0_image_count).toBe(1);
      expect(full.media_summary.has_cc0_images).toBe(true);
    });

    it('cc0_image_count counts only CC0 image-type items — reconciles with get_media', () => {
      // Mirrors the real nasm_A19700102000 shape: CC0 images alongside CC0
      // non-image media (3D models). `count` is the raw total; `cc0_image_count`
      // is what get_media returns, so the two legitimately differ.
      const svc = makeService();
      const raw: RawEDAN = {
        title: 'Mixed Media Object',
        unitCode: 'NASM',
        content: {
          descriptiveNonRepeating: {
            record_ID: 'nasm_MIXED',
            metadata_usage: { access: 'CC0' },
            online_media: {
              mediaCount: 3,
              media: [
                { id: 'a', type: 'Images', usage: { access: 'CC0' } },
                { id: 'b', type: '3d_voyager', usage: { access: 'CC0' } },
                { id: 'c', type: 'Images', usage: { access: 'Usage Conditions Apply' } },
              ],
            },
          },
        },
      };
      const full = svc.toFullObject(raw);
      expect(full.media_summary.count).toBe(3);
      // Only the CC0 image-type item counts: the 3D model (non-image) and the
      // non-CC0 image are both excluded — matching smithsonian_get_media.
      expect(full.media_summary.cc0_image_count).toBe(1);
      expect(full.media_summary.has_cc0_images).toBe(true);
      // toImageItems returns both image-type items; CC0 filtering happens in get_media.
      expect(svc.toImageItems(raw)).toHaveLength(2);
    });

    it('has_cc0_images is false when CC0 media are all non-image (e.g. 3D models)', () => {
      const svc = makeService();
      const raw: RawEDAN = {
        title: '3D Only',
        unitCode: 'NASM',
        content: {
          descriptiveNonRepeating: {
            record_ID: 'nasm_3DONLY',
            online_media: {
              mediaCount: 1,
              media: [{ id: 'x', type: '3d_voyager', usage: { access: 'CC0' } }],
            },
          },
        },
      };
      const full = svc.toFullObject(raw);
      expect(full.media_summary.count).toBe(1);
      expect(full.media_summary.cc0_image_count).toBe(0);
      expect(full.media_summary.has_cc0_images).toBe(false);
    });

    it('dedupes topics across the indexed and freetext blocks, first-seen order (issue #35)', () => {
      // Real siris_sil_1161076 shape: the indexed facet is usually the trailing
      // segment of the freetext LCSH string, and identical values appear in both,
      // so the raw concatenation repeats terms verbatim.
      const svc = makeService();
      const raw: RawEDAN = {
        title: 'Hopi Star Quilt',
        unitCode: 'SIL',
        content: {
          descriptiveNonRepeating: { record_ID: 'siris_sil_1161076' },
          indexedStructured: { topic: ['Hopi quilts', 'Star quilts', 'Quilts', 'History'] },
          freetext: {
            topic: [
              { label: 'Topic', content: 'Quilts--History' },
              { label: 'Topic', content: 'Indian quilts--History' },
              { label: 'Topic', content: 'Star quilts' },
              { label: 'Topic', content: 'Hopi quilts' },
              { label: 'Topic', content: 'Indian quilts' },
              { label: 'Topic', content: 'Quilts' },
            ],
          },
        },
      };
      const full = svc.toFullObject(raw);
      // Ten raw entries collapse to the distinct set, indexed block first. The
      // subdivided LCSH forms are distinct strings from the bare facets, so both survive.
      expect(full.topics).toEqual([
        'Hopi quilts',
        'Star quilts',
        'Quilts',
        'History',
        'Quilts--History',
        'Indian quilts--History',
        'Indian quilts',
      ]);
    });

    it('excludes Dimensions-labeled physicalDescription entries from materials (issue #9)', () => {
      // Real freetext shape of nasm_A19740798000: a "Materials" entry alongside a
      // "Dimensions" entry. The measurement must land in `dimensions` only, never
      // duplicated into `materials`.
      const svc = makeService();
      const raw: RawEDAN = {
        title: 'Command Module',
        unitCode: 'NASM',
        content: {
          descriptiveNonRepeating: { record_ID: 'nasm_A19740798000' },
          freetext: {
            physicalDescription: [
              {
                label: 'Materials',
                content:
                  'Command Module: Aluminum alloy, stainless steel, and titanium structures.',
              },
              {
                label: 'Dimensions',
                content: 'Overall: 12 ft. 10 in. wide x 34 ft. 2 in. deep (391.16 x 1041.4cm)',
              },
            ],
          },
        },
      };
      const full = svc.toFullObject(raw);
      expect(full.materials).toEqual([
        'Command Module: Aluminum alloy, stainless steel, and titanium structures.',
      ]);
      expect(full.dimensions).toEqual([
        'Overall: 12 ft. 10 in. wide x 34 ft. 2 in. deep (391.16 x 1041.4cm)',
      ]);
    });

    it('excludes Dimensions from materials with a Medium label; Measurements also routes to dimensions', () => {
      // Real freetext shape of chndm_1901-39-3309: a "Medium" entry (material prose)
      // alongside a "Dimensions" entry. "Measurements" is the other live dimension
      // label observed in sampling — it must route to dimensions too.
      const svc = makeService();
      const raw: RawEDAN = {
        title: 'Drawing',
        unitCode: 'CHNDM',
        content: {
          descriptiveNonRepeating: { record_ID: 'chndm_1901-39-3309' },
          freetext: {
            physicalDescription: [
              { label: 'Medium', content: 'Brush and gouache on paperboard' },
              { label: 'Dimensions', content: '40.8 x 25.8 cm (16 1/16 x 10 3/16 in.)' },
              { label: 'Measurements', content: 'Framed: 50 x 35 cm' },
            ],
          },
        },
      };
      const full = svc.toFullObject(raw);
      expect(full.materials).toEqual(['Brush and gouache on paperboard']);
      expect(full.dimensions).toEqual([
        '40.8 x 25.8 cm (16 1/16 x 10 3/16 in.)',
        'Framed: 50 x 35 cm',
      ]);
    });

    it('keeps a generic "Physical Description" entry in materials — no label signal to route it', () => {
      // Inherent limit: a generic "Physical Description" label carries no signal to
      // separate material prose from measurement prose, so it stays in materials.
      const svc = makeService();
      const raw: RawEDAN = {
        title: 'Generic',
        unitCode: 'NMAH',
        content: {
          descriptiveNonRepeating: { record_ID: 'nmah_GENERIC' },
          freetext: {
            physicalDescription: [
              { label: 'Physical Description', content: 'Carved oak, 30 cm tall' },
            ],
          },
        },
      };
      const full = svc.toFullObject(raw);
      expect(full.materials).toEqual(['Carved oak, 30 cm tall']);
      expect(full.dimensions).toEqual([]);
    });
  });

  describe('museum_name resolution', () => {
    /**
     * The vocabulary `smithsonian_list_terms { field: "unit_code" }` returns — every
     * code a live record can carry. Kept whole so a future upstream addition shows up
     * here as a failing row rather than a silent raw-code echo on the wire.
     */
    const LIVE_UNIT_CODES = [
      'AAA',
      'AAG',
      'ACAH',
      'ACM',
      'ACMA',
      'CFCHFOLKLIFE',
      'CHNDM',
      'CHSDM',
      'EEPA',
      'FBR',
      'FSA',
      'HAC',
      'HMSG',
      'HSFA',
      'NAA',
      'NASM',
      'NASMAC',
      'NMAA',
      'NMAAHC',
      'NMAH',
      'NMAI',
      'NMAIA',
      'NMAfA',
      'NMNHANTHRO',
      'NMNHBIRDS',
      'NMNHBOTANY',
      'NMNHEDUCATION',
      'NMNHENTO',
      'NMNHFISHES',
      'NMNHHERPS',
      'NMNHINV',
      'NMNHMAMMALS',
      'NMNHMINSCI',
      'NMNHPALEO',
      'NPG',
      'NPM',
      'NPMA',
      'NZP',
      'OCIO_DPO3D',
      'OFEO-SG',
      'SAAM',
      'SAAMPAIK',
      'SI',
      'SIA',
      'SIL',
      'SILAF',
      'SILNMAHTL',
      'SLA_SRO',
    ];

    /** Codes with no primary-sourced name — a guessed expansion would be a fabricated fact. */
    const UNSOURCED_CODES = ['FSA', 'NASMAC', 'NMAIA', 'SAAMPAIK'];

    it('resolves every sourced live unit code to a name, not the raw code (issue #27)', () => {
      const svc = makeService();
      for (const code of LIVE_UNIT_CODES.filter((c) => !UNSOURCED_CODES.includes(c))) {
        expect(svc.toSummary({ unitCode: code }).museum_name, `unit_code ${code}`).not.toBe(code);
      }
    });

    it('echoes the raw code for the four unsourced archive codes — never a guessed name', () => {
      const svc = makeService();
      for (const code of UNSOURCED_CODES) {
        expect(svc.toSummary({ unitCode: code }).museum_name).toBe(code);
      }
    });

    it('names NMNH sub-units at discipline level, not just "Natural History"', () => {
      const svc = makeService();
      expect(svc.toSummary({ unitCode: 'NMNHBIRDS' }).museum_name).toBe(
        'NMNH - Vertebrate Zoology - Birds Division',
      );
      expect(svc.toSummary({ unitCode: 'NMNHPALEO' }).museum_name).toBe(
        'NMNH - Paleobiology Dept.',
      );
    });

    it('matches codes case-sensitively — NMAfA carries a lowercase f upstream', () => {
      const svc = makeService();
      expect(svc.toSummary({ unitCode: 'NMAfA' }).museum_name).toBe(
        'National Museum of African Art',
      );
      expect(svc.toSummary({ unitCode: 'NMAFA' }).museum_name).toBe('NMAFA');
    });

    it('drops the retired FSG and bare NMNH keys — neither can match a live record', () => {
      const svc = makeService();
      // FSG was the pre-2019 Freer/Sackler code; the unit is indexed as NMAA now.
      expect(svc.toSummary({ unitCode: 'FSG' }).museum_name).toBe('FSG');
      expect(svc.toSummary({ unitCode: 'NMAA' }).museum_name).toBe('National Museum of Asian Art');
      // Bare NMNH is superseded by the eleven NMNH* discipline sub-units.
      expect(svc.toSummary({ unitCode: 'NMNH' }).museum_name).toBe('NMNH');
    });
  });

  describe('toImageItems()', () => {
    it('extracts CC0 images with resolution URLs', () => {
      const svc = makeService();
      const raw = makeContentResponse('nasm_TEST001').response!;
      const images = svc.toImageItems(raw);
      expect(images).toHaveLength(1);
      expect(images[0]?.media_id).toBe('NASM-TEST001');
      expect(images[0]?.is_cc0).toBe(true);
      expect(images[0]?.high_res_jpeg?.url).toContain('.jpg');
      expect(images[0]?.screen_url).toContain('_screen');
    });

    it('returns empty array when no media present', () => {
      const svc = makeService();
      const raw = { title: 'No Media', unitCode: 'NMNH', content: {} };
      const images = svc.toImageItems(raw);
      expect(images).toHaveLength(0);
    });
  });

  describe('isCC0()', () => {
    it('returns true for CC0 objects', () => {
      const svc = makeService();
      const raw = makeContentResponse('nasm_TEST001', true).response!;
      expect(svc.isCC0(raw)).toBe(true);
    });

    it('returns false for non-CC0 objects', () => {
      const svc = makeService();
      const raw = makeContentResponse('nasm_TEST001', false).response!;
      expect(svc.isCC0(raw)).toBe(false);
    });
  });

  describe('listTerms()', () => {
    it('parses the real string-array terms response and slices client-side', async () => {
      // Mirrors the live upstream shape: response = { message, terms: string[] }.
      // No per-term counts, no rowCount — upstream ignores rows/start and returns
      // the full vocabulary, so the service pages by slicing the array itself.
      const fullVocab = ['AAA', 'AAG', 'ACAH', 'ACM', 'CHNDM', 'FSG', 'HMSG', 'NASM'];
      mockFetch({
        status: 200,
        responseCode: 1,
        response: { message: 'search terms returned successfully', terms: fullVocab },
      });
      const svc = makeService();
      const ctx = makeTenantContext();
      const result = await svc.listTerms({ field: 'unit_code', start: 2, rows: 3 }, ctx);
      // total is the full vocabulary size; terms is only the requested page
      expect(result.total).toBe(8);
      expect(result.terms).toEqual(['ACAH', 'ACM', 'CHNDM']);
    });

    it('sends no rows/start to upstream — pagination is client-side only', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 200, response: { terms: ['AAA', 'AAG'] } }),
        text: async () => JSON.stringify({ status: 200, response: { terms: ['AAA', 'AAG'] } }),
      });
      vi.stubGlobal('fetch', fetchMock);
      const svc = makeService();
      const ctx = makeTenantContext();
      await svc.listTerms({ field: 'unit_code', start: 5, rows: 10 }, ctx);
      const calledUrl = (fetchMock.mock.calls[0] as [string])[0];
      // Upstream ignores rows/start; the URL must not carry them (avoids implying
      // server-side pagination that does not exist).
      expect(calledUrl).not.toContain('rows=');
      expect(calledUrl).not.toContain('start=');
      expect(calledUrl).toContain('/terms/unit_code');
    });

    it('returns an empty page but real total when start is past the end', async () => {
      mockFetch({ status: 200, responseCode: 1, response: { terms: ['AAA', 'AAG'] } });
      const svc = makeService();
      const ctx = makeTenantContext();
      const result = await svc.listTerms({ field: 'unit_code', start: 50, rows: 10 }, ctx);
      expect(result.total).toBe(2);
      expect(result.terms).toEqual([]);
    });

    it('handles an absent terms array without throwing', async () => {
      // e.g. an unsupported field returning { response: { message } } and no terms.
      mockFetch({ status: 200, responseCode: 1, response: { message: 'no terms' } });
      const svc = makeService();
      const ctx = makeTenantContext();
      const result = await svc.listTerms({ field: 'unit_code', start: 0, rows: 50 }, ctx);
      expect(result.total).toBe(0);
      expect(result.terms).toEqual([]);
    });

    it('filters the vocabulary by a case-insensitive contains substring (issue #21)', async () => {
      // Upstream returns the full vocabulary; contains narrows it in-process. "greek"
      // must match every term containing it in any case, and nothing else.
      const fullVocab = [
        'Abyssinian',
        'Greek, Attic',
        'African American',
        'Greek, Hellenistic',
        'ANCIENT GREEK',
        'Roman',
      ];
      mockFetch({ status: 200, responseCode: 1, response: { terms: fullVocab } });
      const svc = makeService();
      const ctx = makeTenantContext();
      const result = await svc.listTerms(
        { field: 'culture', start: 0, rows: 50, contains: 'greek' },
        ctx,
      );
      // total is the post-filter match count, not the full vocabulary size.
      expect(result.total).toBe(3);
      expect(result.terms).toEqual(['Greek, Attic', 'Greek, Hellenistic', 'ANCIENT GREEK']);
    });

    it('paginates over the filtered set when contains is set (issue #21)', async () => {
      const fullVocab = ['Greek A', 'Greek B', 'Greek C', 'Roman', 'Greek D'];
      mockFetch({ status: 200, responseCode: 1, response: { terms: fullVocab } });
      const svc = makeService();
      const ctx = makeTenantContext();
      const result = await svc.listTerms(
        { field: 'culture', start: 1, rows: 2, contains: 'greek' },
        ctx,
      );
      // 4 terms match "greek"; start/rows slice the FILTERED set, not the raw vocab.
      expect(result.total).toBe(4);
      expect(result.terms).toEqual(['Greek B', 'Greek C']);
    });

    it('returns an empty page with total 0 when contains matches nothing (issue #21)', async () => {
      const fullVocab = ['Aztec', 'Roman', 'Egyptian'];
      mockFetch({ status: 200, responseCode: 1, response: { terms: fullVocab } });
      const svc = makeService();
      const ctx = makeTenantContext();
      const result = await svc.listTerms(
        { field: 'culture', start: 0, rows: 50, contains: 'greek' },
        ctx,
      );
      // An empty result confirms absence — no term in the vocabulary contains "greek".
      expect(result.total).toBe(0);
      expect(result.terms).toEqual([]);
    });

    it('leaves the full vocabulary unchanged when contains is absent (issue #21)', async () => {
      const fullVocab = ['AAA', 'AAG', 'ACAH', 'ACM'];
      mockFetch({ status: 200, responseCode: 1, response: { terms: fullVocab } });
      const svc = makeService();
      const ctx = makeTenantContext();
      const result = await svc.listTerms({ field: 'unit_code', start: 0, rows: 50 }, ctx);
      expect(result.total).toBe(4);
      expect(result.terms).toEqual(fullVocab);
    });
  });

  describe('unit_code labels (issue #37)', () => {
    /** Two mapped codes sharing a name, one case-sensitive code, two unmapped codes. */
    const UNIT_CODES = ['AAA', 'CHNDM', 'CHSDM', 'FSA', 'NASM', 'NASMAC', 'NMAfA'];

    it('returns the museum name for every mapped code on the page', async () => {
      mockFetch({ status: 200, responseCode: 1, response: { terms: UNIT_CODES } });
      const result = await makeService().listTerms(
        { field: 'unit_code', start: 0, rows: 50 },
        makeTenantContext(),
      );
      expect(result.labels?.AAA).toBe('Archives of American Art');
      expect(result.labels?.NASM).toBe('National Air and Space Museum');
      expect(result.labels?.NMAfA).toBe('National Museum of African Art');
    });

    it('omits unmapped codes from labels while still returning them in terms', async () => {
      // The four unattributed archive codes have no primary-sourced name, so they
      // must be absent from the map rather than carry a guessed or echoed value.
      mockFetch({ status: 200, responseCode: 1, response: { terms: UNIT_CODES } });
      const result = await makeService().listTerms(
        { field: 'unit_code', start: 0, rows: 50 },
        makeTenantContext(),
      );
      expect(result.terms).toContain('FSA');
      expect(result.terms).toContain('NASMAC');
      expect(result.labels).not.toHaveProperty('FSA');
      expect(result.labels).not.toHaveProperty('NASMAC');
    });

    it('labels only the codes on the requested page', async () => {
      mockFetch({ status: 200, responseCode: 1, response: { terms: UNIT_CODES } });
      const result = await makeService().listTerms(
        { field: 'unit_code', start: 4, rows: 1 },
        makeTenantContext(),
      );
      expect(result.terms).toEqual(['NASM']);
      expect(Object.keys(result.labels ?? {})).toEqual(['NASM']);
    });

    it('matches contains against the museum name, not just the code', async () => {
      // No unit code contains "National Air and Space" as a substring, so this
      // resolves only because the label participates in the match.
      mockFetch({ status: 200, responseCode: 1, response: { terms: UNIT_CODES } });
      const result = await makeService().listTerms(
        { field: 'unit_code', start: 0, rows: 50, contains: 'National Air and Space' },
        makeTenantContext(),
      );
      expect(result.terms).toEqual(['NASM']);
      expect(result.total).toBe(1);
      expect(result.labels).toEqual({ NASM: 'National Air and Space Museum' });
    });

    it('returns every code whose name matches, and keeps code matching intact', async () => {
      mockFetch({ status: 200, responseCode: 1, response: { terms: UNIT_CODES } });
      const svc = makeService();
      const ctx = makeTenantContext();
      // Two codes carry the Cooper Hewitt name; both must come back.
      const byName = await svc.listTerms(
        { field: 'unit_code', start: 0, rows: 50, contains: 'cooper hewitt' },
        ctx,
      );
      expect(byName.terms).toEqual(['CHNDM', 'CHSDM']);
      // A code substring that appears in no name still matches the code itself.
      const byCode = await svc.listTerms(
        { field: 'unit_code', start: 0, rows: 50, contains: 'NASM' },
        ctx,
      );
      expect(byCode.terms).toEqual(['NASM', 'NASMAC']);
    });

    it('returns no labels map for a field other than unit_code', async () => {
      // "Museum" appears in several museum names, so a field that leaked label
      // matching would over-match here as well as carry the map.
      mockFetch({
        status: 200,
        responseCode: 1,
        response: { terms: ['Aztecs', 'NASM', 'Roman'] },
      });
      const result = await makeService().listTerms(
        { field: 'culture', start: 0, rows: 50, contains: 'museum' },
        makeTenantContext(),
      );
      expect(result.labels).toBeUndefined();
      expect(result.terms).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  describe('describeTerm()', () => {
    const VOCAB = ['AAA', 'AAG', 'NASM', 'NMAfA'];

    it('is an exact membership test — a substring of a term is not a term', async () => {
      // The reason `contains` cannot stand in: it would report a hit for "AA".
      mockFetch({ status: 200, responseCode: 1, response: { terms: VOCAB } });
      const svc = makeService();
      const ctx = makeTenantContext();
      expect((await svc.describeTerm('unit_code', 'AAA', ctx)).indexed).toBe(true);
      expect((await svc.describeTerm('unit_code', 'AA', ctx)).indexed).toBe(false);
    });

    it('matches case-sensitively, as EDAN itself resolves a term', async () => {
      // NMAfA carries a lowercase f upstream; NMAFA matches nothing there, and a
      // case-insensitive check would wrongly call it indexed.
      mockFetch({ status: 200, responseCode: 1, response: { terms: VOCAB } });
      const svc = makeService();
      const ctx = makeTenantContext();
      expect((await svc.describeTerm('unit_code', 'NMAfA', ctx)).indexed).toBe(true);
      expect((await svc.describeTerm('unit_code', 'NMAFA', ctx)).indexed).toBe(false);
    });

    it('reports no neighbors for a value outside the vocabulary', async () => {
      // An unindexed value takes the resolve-it hint, which passes the value itself
      // as the substring — so there is nothing to prove and nothing to return.
      mockFetch({ status: 200, responseCode: 1, response: { terms: VOCAB } });
      expect(
        await makeService().describeTerm('unit_code', 'NOTACODE', makeTenantContext()),
      ).toEqual({ indexed: false });
    });

    describe('neighbor substrings (issues #46, #47, #48)', () => {
      it('keeps the value itself when it already lists other terms', async () => {
        // The short vocabularies (culture, place) work this way, and the pre-#46 hint
        // was correct for them — "Guiana" is inside "Guiana, French".
        mockFetch({
          status: 200,
          responseCode: 1,
          response: { terms: ['Guiana', 'Guiana, French', 'French Guiana', 'Aztecs'] },
        });
        expect(await makeService().describeTerm('culture', 'Guiana', makeTenantContext())).toEqual({
          indexed: true,
          neighbors: { contains: 'Guiana', count: 2 },
        });
      });

      it('stops the cut at the shared head of an LCSH subdivision', async () => {
        // 'Quilting' shares a stem but not the substring, so it is not a neighbor —
        // the count is what a `contains: "Quilts"` call would return, minus the value.
        mockFetch({
          status: 200,
          responseCode: 1,
          response: { terms: ['Quilts--History', 'Quilts', 'Quilting', 'Aviation'] },
        });
        expect(
          await makeService().describeTerm('topic', 'Quilts--History', makeTenantContext()),
        ).toEqual({ indexed: true, neighbors: { contains: 'Quilts', count: 1 } });
      });

      it.each([
        ['(', 'Endeavour (OV-105)', ['Endeavour (OV-105)', 'Endeavour', 'Discovery'], 'Endeavour'],
        [',', 'Kano, Nigeria', ['Kano, Nigeria', 'Kano', 'Lagos'], 'Kano'],
      ] as const)(
        'stops where the head shared with a %s qualifier ends',
        async (_sep, value, terms, contains) => {
          mockFetch({ status: 200, responseCode: 1, response: { terms } });
          expect(await makeService().describeTerm('topic', value, makeTenantContext())).toEqual({
            indexed: true,
            neighbors: { contains, count: 1 },
          });
        },
      );

      it('names the tightest working substring, not the first one that works', async () => {
        // The issue #47 repro, and the assertion that separates the two behaviours: a
        // leading-token ladder stops at 'Bell', which lists all six other terms here —
        // two sibling helicopters and four accidents, half of them mid-word. Cutting
        // one character further, inside 'UH-1H', lists only the two that answer the
        // question. Both substrings "work"; only the longer one is tight.
        const value = 'Bell UH-1H Iroquois "Huey" Smokey III';
        mockFetch({
          status: 200,
          responseCode: 1,
          response: {
            terms: [
              value,
              'Bell UH-1 Iroquois (Huey) Series',
              'Bell UH-1B (HU-1B) Iroquois (Huey)',
              'Bell 47',
              'Bell X-1',
              'Cerebellum',
              'Abronia umbellata',
            ],
          },
        });
        expect(await makeService().describeTerm('topic', value, makeTenantContext())).toEqual({
          indexed: true,
          neighbors: { contains: 'Bell UH-1', count: 2 },
        });
      });

      it('cuts inside a word when the word boundary is too wide', async () => {
        // 'Guiana' lists nothing else — 'Guianese' diverges at the sixth character —
        // so the clause used to be dropped for a value one character from working.
        mockFetch({
          status: 200,
          responseCode: 1,
          response: { terms: ['Guiana', 'Guianese', 'French Guianese'] },
        });
        expect(await makeService().describeTerm('culture', 'Guiana', makeTenantContext())).toEqual({
          indexed: true,
          neighbors: { contains: 'Guian', count: 2 },
        });
      });

      it('reaches a window that starts inside the value, not just a leading cut', async () => {
        // Every leading cut of this value dead-ends at 'Check', which lists an
        // unrelated term; the fragment that shares a subject with the value sits in
        // the middle and no prefix walk arrives at it.
        const value = 'Check-list of North American Birds (Monograph)';
        mockFetch({
          status: 200,
          responseCode: 1,
          response: { terms: [value, 'Indians of North American', 'Check cashing services'] },
        });
        expect(await makeService().describeTerm('topic', value, makeTenantContext())).toEqual({
          indexed: true,
          neighbors: { contains: 'of North American', count: 1 },
        });
      });

      it('drops surrounding punctuation the rest of the vocabulary does not carry', async () => {
        // A handful of live topic terms are quoted and nothing else is, so a candidate
        // keeping the quotes can only ever match the value it came from.
        mockFetch({
          status: 200,
          responseCode: 1,
          response: { terms: ['"Yank"', 'Yankee', 'American Yankee (Airplane)'] },
        });
        expect(await makeService().describeTerm('topic', '"Yank"', makeTenantContext())).toEqual({
          indexed: true,
          neighbors: { contains: 'Yank', count: 2 },
        });
      });

      it('keeps a short tight substring over a longer one that lists more', async () => {
        // 'African people' is longer than 'Yombe' and works, but it is a qualifier
        // every term in the group shares — naming it would hand back the whole group
        // and repeat the overshoot the search exists to remove.
        const value = 'Yombe (African people)';
        mockFetch({
          status: 200,
          responseCode: 1,
          response: {
            terms: [
              value,
              'Yombe (?)',
              '!Kung (African people)',
              'Aari (African people)',
              'Ababda (African people)',
            ],
          },
        });
        expect(await makeService().describeTerm('culture', value, makeTenantContext())).toEqual({
          indexed: true,
          neighbors: { contains: 'Yombe', count: 1 },
        });
      });

      it('ends a candidate on the punctuation a word owns', async () => {
        // A third of the live `place` vocabulary ends on punctuation. Requiring the
        // last character to be alphanumeric put the cut one character short of the
        // period this value owns and reached for the next-widest window instead — on
        // the live vocabulary that is `New York` (907 other place terms) against the
        // 1 the period lists. A word boundary — the end of the value, or the offset
        // before whitespace — is a legal end, so the tight cut is reachable.
        const value = 'New York. (N.Y.)';
        mockFetch({
          status: 200,
          responseCode: 1,
          response: {
            terms: [value, 'New York. Harbor', 'New York (N.Y.)', 'New York City', 'New Yorkers'],
          },
        });
        expect(await makeService().describeTerm('place', value, makeTenantContext())).toEqual({
          indexed: true,
          neighbors: { contains: 'New York.', count: 1 },
        });
      });

      it('keeps a combining mark attached to the letter it modifies', async () => {
        // Thousands of live terms arrive decomposed, so an accented letter is a base
        // plus a mark and the mark is neither a letter nor a digit. Ending only on
        // alphanumerics cut the mark off and silently named the unaccented form,
        // which matches every term the accented one does and more. Escaped rather
        // than typed so no editor can recompose the pair and void the case.
        const value = 'Osia\u0304';
        mockFetch({
          status: 200,
          responseCode: 1,
          response: { terms: [value, 'Osia\u0304bad (India)', 'Osiander', 'Osiadly'] },
        });
        expect(await makeService().describeTerm('place', value, makeTenantContext())).toEqual({
          indexed: true,
          neighbors: { contains: 'Osia\u0304', count: 1 },
        });
      });

      it('never cuts a word open on its own leading bracket', async () => {
        // 'Yombe (' would be tighter here — it lists 1 where 'Yombe' lists 3 — and it
        // is still not a candidate, because that bracket is followed by a letter
        // rather than whitespace or the end of the value. A hint naming a substring
        // that opens a bracket it never closes reads as a malformed call.
        const value = 'Yombe (African people)';
        mockFetch({
          status: 200,
          responseCode: 1,
          response: { terms: [value, 'Yombe (Congo)', 'Yombe language', 'Yombean'] },
        });
        expect(await makeService().describeTerm('culture', value, makeTenantContext())).toEqual({
          indexed: true,
          neighbors: { contains: 'Yombe', count: 3 },
        });
      });

      it('gives up rather than search an unbounded number of candidates', async () => {
        // Each scan walks the whole vocabulary, so the search is capped. Here only the
        // final word shares anything with the other term, and every earlier word costs
        // one failed scan — past the cap the search stops and the clause is dropped,
        // even though a candidate further along would have worked. The short control
        // proves the value is otherwise resolvable.
        const words = Array.from({ length: 100 }, (_, i) => `Qq${i}`);
        const beyondCap = `${words.join(' ')} Wwtarget`;
        const withinCap = `${words.slice(0, 3).join(' ')} Wwtarget`;
        const ctx = makeTenantContext();

        mockFetch({
          status: 200,
          responseCode: 1,
          response: { terms: [beyondCap, 'Wwtarget alternative'] },
        });
        expect(await makeService().describeTerm('topic', beyondCap, ctx)).toEqual({
          indexed: true,
        });

        mockFetch({
          status: 200,
          responseCode: 1,
          response: { terms: [withinCap, 'Wwtarget alternative'] },
        });
        expect(await makeService().describeTerm('topic', withinCap, ctx)).toEqual({
          indexed: true,
          neighbors: { contains: 'Wwtarget', count: 1 },
        });
      });

      it('reports no neighbors when no fragment lists anything else', async () => {
        // Naming any substring here would send the caller to a call that returns the
        // failing value alone, so the recovery hint drops the substitute-term clause.
        mockFetch({
          status: 200,
          responseCode: 1,
          response: { terms: ['Zymurgy', 'Quilts', 'Aviation'] },
        });
        expect(await makeService().describeTerm('topic', 'Zymurgy', makeTenantContext())).toEqual({
          indexed: true,
        });
      });

      /**
       * A vocabulary where the only working substring of 'Mzab' is its first
       * character: `neighborCount` terms carry an M, none carries 'Mz', and the
       * padding carries no M at all. The shape is the live one — 'Mzab' has no cut
       * that lists anything, so the search bottoms out at 'M' (issue #48).
       */
      function mzabVocabulary(neighborCount: number, padding = 0): string[] {
        return [
          'Mzab',
          ...Array.from({ length: neighborCount }, (_, i) => `M${i}xx`),
          ...Array.from({ length: padding }, (_, i) => `Qq${i}`),
        ];
      }

      it('drops a substring that lists more terms than the ceiling allows', async () => {
        // 'M' names 801 of the 802 culture terms here. The call works and the count
        // is honest, but as a next move it is worse than no clause at all, so the
        // hint falls through to the branch that offers no term route.
        mockFetch({ status: 200, responseCode: 1, response: { terms: mzabVocabulary(801) } });
        expect(await makeService().describeTerm('culture', 'Mzab', makeTenantContext())).toEqual({
          indexed: true,
        });
      });

      it('names a substring sitting exactly on the ceiling', async () => {
        // One term fewer than the case above, and the clause survives — the ceiling
        // is 800 inclusive, and this pins it against a silent loosening.
        mockFetch({ status: 200, responseCode: 1, response: { terms: mzabVocabulary(800) } });
        expect(await makeService().describeTerm('culture', 'Mzab', makeTenantContext())).toEqual({
          indexed: true,
          neighbors: { contains: 'M', count: 800 },
        });
      });

      it('measures the ceiling in terms, not as a share of the vocabulary', async () => {
        // The same 900-term set inside a 20,000-term vocabulary is 4.5% of the field
        // — under a 5%-of-vocabulary rule, and still 9 pages of smithsonian_list_terms
        // at its 100-row cap. A share cannot bound the large vocabularies: the
        // tightest cut of the live place term 'Gièvres' lists 5,512 other place
        // terms and is only 4.8% of that field.
        mockFetch({
          status: 200,
          responseCode: 1,
          response: { terms: mzabVocabulary(900, 19_099) },
        });
        expect(await makeService().describeTerm('place', 'Mzab', makeTenantContext())).toEqual({
          indexed: true,
        });
      });

      it('counts matches case-insensitively and never counts the value itself', async () => {
        // The count has to mean what smithsonian_list_terms { contains } would return
        // minus the failing value, and that filter is case-insensitive.
        mockFetch({
          status: 200,
          responseCode: 1,
          response: { terms: ['Quilts', "quilts of Gee's Bend", 'Hopi quilts', 'Aviation'] },
        });
        expect(await makeService().describeTerm('topic', 'Quilts', makeTenantContext())).toEqual({
          indexed: true,
          neighbors: { contains: 'Quilts', count: 2 },
        });
      });
    });
  });

  describe('term vocabulary caching (issue #38)', () => {
    /** A terms-endpoint fetch mock that records how many upstream calls were made. */
    function mockTermsFetch(terms: string[]) {
      const body = { status: 200, responseCode: 1, response: { terms } };
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it('fetches the vocabulary once and serves later calls from storage', async () => {
      // The upstream endpoint ignores rows/start and returns the whole vocabulary,
      // so the defect is per-call refetching, not the returned value — the call
      // count is the assertion that fails without a cache.
      const fetchMock = mockTermsFetch(['AAA', 'AAG', 'NASM']);
      const svc = makeService();
      const ctx = makeTenantContext();

      const first = await svc.listTerms({ field: 'unit_code', start: 0, rows: 2 }, ctx);
      const second = await svc.listTerms({ field: 'unit_code', start: 1, rows: 2 }, ctx);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(first.terms).toEqual(['AAA', 'AAG']);
      expect(second.terms).toEqual(['AAG', 'NASM']);
      expect(second.total).toBe(3);
    });

    it('caches per field — a second field still costs one fetch', async () => {
      const fetchMock = mockTermsFetch(['AAA', 'AAG']);
      const svc = makeService();
      const ctx = makeTenantContext();

      await svc.listTerms({ field: 'unit_code', start: 0, rows: 50 }, ctx);
      await svc.listTerms({ field: 'culture', start: 0, rows: 50 }, ctx);
      await svc.listTerms({ field: 'unit_code', start: 0, rows: 50 }, ctx);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const fetchedUrls = fetchMock.mock.calls.map((call) => (call as [string])[0]);
      expect(fetchedUrls[0]).toContain('/terms/unit_code');
      expect(fetchedUrls[1]).toContain('/terms/culture');
    });

    it('shares the cached vocabulary with describeTerm — the check adds no fetch', async () => {
      // The membership check and the neighbor scan both run on the recovery path of
      // every zero-match browse and search, off the array the cache already holds;
      // against an uncached vocabulary each would pay a full download.
      const fetchMock = mockTermsFetch(['AAA', 'AAG', 'NASM']);
      const svc = makeService();
      const ctx = makeTenantContext();

      await svc.listTerms({ field: 'unit_code', start: 0, rows: 50 }, ctx);
      // 'AAA' resolves through a cut inside the code — 'AAG' shares its first two
      // characters — which is a scan of the cached array, not a second download.
      expect(await svc.describeTerm('unit_code', 'AAA', ctx)).toEqual({
        indexed: true,
        neighbors: { contains: 'AA', count: 1 },
      });
      expect(await svc.describeTerm('unit_code', 'NOTACODE', ctx)).toEqual({ indexed: false });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('isolates the cache per tenant', async () => {
      const fetchMock = mockTermsFetch(['AAA', 'AAG']);
      const svc = makeService();

      await svc.listTerms(
        { field: 'unit_code', start: 0, rows: 50 },
        createMockContext({ tenantId: 'tenant-a' }),
      );
      await svc.listTerms(
        { field: 'unit_code', start: 0, rows: 50 },
        createMockContext({ tenantId: 'tenant-b' }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('refetches once the TTL has elapsed', async () => {
      const fetchMock = mockTermsFetch(['AAA', 'AAG']);
      const svc = makeService();
      const ctx = makeTenantContext();

      vi.useFakeTimers();
      try {
        await svc.listTerms({ field: 'unit_code', start: 0, rows: 50 }, ctx);
        // Inside the default 3600 s TTL the entry is still served from storage.
        vi.setSystemTime(Date.now() + 3_599_000);
        await svc.listTerms({ field: 'unit_code', start: 0, rows: 50 }, ctx);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        vi.setSystemTime(Date.now() + 2_000);
        await svc.listTerms({ field: 'unit_code', start: 0, rows: 50 }, ctx);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('SMITHSONIAN_TERMS_CACHE_TTL_SECONDS=0 disables caching entirely', async () => {
      // The config memo is module-level, so the TTL override needs a fresh module
      // graph — the same reason this case cannot ride the default-TTL service above.
      vi.resetModules();
      vi.stubEnv('SMITHSONIAN_TERMS_CACHE_TTL_SECONDS', '0');
      const fetchMock = mockTermsFetch(['AAA', 'AAG']);
      const { SmithsonianService: FreshService } = await import(
        '@/services/smithsonian/smithsonian-service.js'
      );
      const svc = new FreshService(createInMemoryStorage());
      const ctx = makeTenantContext();

      await svc.listTerms({ field: 'unit_code', start: 0, rows: 50 }, ctx);
      await svc.listTerms({ field: 'unit_code', start: 0, rows: 50 }, ctx);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('markup and entities in projected text (issue #49)', () => {
    /** A record whose title and Summary note carry the upstream markup verbatim. */
    function makeMarkupRecord(): RawEDAN {
      return {
        id: 'ld1-markup',
        title: 'A nonpotential model for the Sun&#39;s open magnetic flux',
        unitCode: 'SLA_SRO',
        type: 'edanmdm',
        url: 'edanmdm:slasro_92924',
        content: {
          descriptiveNonRepeating: {
            record_ID: 'slasro_92924',
            unit_code: 'SLA_SRO',
            metadata_usage: { access: 'CC0' },
          },
          freetext: {
            notes: [
              {
                label: 'Summary',
                content:
                  'Yeates, A. R. 2010. "<a href="http://adsabs.harvard.edu/abs/2010JGRA">A nonpotential model for the Sun&#39;s open magnetic flux</a>." <em>JGR</em> 115.',
              },
            ],
          },
        },
      };
    }

    it('search() decodes the title on every summary row', async () => {
      mockFetch({
        status: 200,
        responseCode: 1,
        response: { rows: [makeMarkupRecord()], rowCount: 1 },
      });
      const svc = makeService();
      const result = await svc.search({ query: 'sun', rows: 10, start: 0 }, makeTenantContext());

      expect(result.rows[0]?.title).toBe("A nonpotential model for the Sun's open magnetic flux");
      expect(result.rows[0]?.title).not.toContain('&#39;');
    });

    it('toFullObject() decodes the title and strips markup from the description', () => {
      const full = makeService().toFullObject(makeMarkupRecord());

      expect(full.title).toBe("A nonpotential model for the Sun's open magnetic flux");
      expect(full.description).toBe(
        'Yeates, A. R. 2010. "A nonpotential model for the Sun\'s open magnetic flux." JGR 115.',
      );
      expect(full.description).not.toContain('<a href');
      expect(full.description).not.toContain('adsabs.harvard.edu');
    });

    it('toSummary() and toFullObject() agree on the same record', () => {
      const svc = makeService();
      const raw = makeMarkupRecord();
      expect(svc.toSummary(raw).title).toBe(svc.toFullObject(raw).title);
    });

    it('leaves a title whose ampersand and angle bracket are real intact', () => {
      const raw: RawEDAN = { ...makeMarkupRecord(), title: 'Barnes & Noble, depth <20 m' };
      expect(makeService().toSummary(raw).title).toBe('Barnes & Noble, depth <20 m');
    });
  });

  describe('host-level 404 on a collection endpoint (issue #51)', () => {
    /**
     * The failure the api.data.gov edge produces when the route mapping for
     * api.si.edu is dropped: the Cloud Foundry router answers EVERY path with a
     * 404 and its own body, so the request never reaches EDAN.
     */
    function mockRouterFetch() {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: { get: () => null },
        text: async () => "404 Not Found: Requested route ('api.si.edu') does not exist.",
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    /** Run to rejection with the backoff delays skipped. */
    async function runWithFakeTimers<T>(start: () => Promise<T>): Promise<unknown> {
      vi.useFakeTimers();
      try {
        const promise = start().catch((e: unknown) => e);
        await vi.runAllTimersAsync();
        return await promise;
      } finally {
        vi.useRealTimers();
      }
    }

    it('search() surfaces a host 404 as ServiceUnavailable, not NotFound', async () => {
      mockRouterFetch();
      const svc = makeService();
      const ctx = makeTenantContext();
      const err = (await runWithFakeTimers(() =>
        svc.search({ query: 'aircraft', rows: 10, start: 0 }, ctx),
      )) as { code: number; message: string; data?: Record<string, unknown> };

      // /search exists whenever the service is up, so a 404 there is an outage —
      // NotFound would blame the caller for input no change can fix.
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.code).not.toBe(JsonRpcErrorCode.NotFound);
      expect(err.message).toMatch(/not routing requests/i);
      expect(err.data?.reason).toBe('upstream_unavailable');
      // The upstream status survives the rewrap for diagnostics.
      expect(err.data?.status).toBe(404);
    });

    it('search() retries the host 404 with backoff — the point of the reclassification', async () => {
      const fetchMock = mockRouterFetch();
      const svc = makeService();
      const ctx = makeTenantContext();
      const err = (await runWithFakeTimers(() =>
        svc.search({ query: 'aircraft', rows: 10, start: 0 }, ctx),
      )) as { data?: Record<string, unknown> };

      // ServiceUnavailable is in withRetry's transient set: 1 initial attempt +
      // 3 retries. A rewrap AFTER search() returns would yield the right code
      // here and a single fetch — which is the regression this asserts against.
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(err.data?.retryAttempts).toBe(4);
    });

    it('listTerms() surfaces a host 404 as ServiceUnavailable and retries', async () => {
      const fetchMock = mockRouterFetch();
      const svc = makeService();
      const ctx = makeTenantContext();
      const err = (await runWithFakeTimers(() =>
        svc.listTerms({ field: 'culture', start: 0, rows: 50 }, ctx),
      )) as { code: number; data?: Record<string, unknown> };

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data?.reason).toBe('upstream_unavailable');
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('describeTerm() rides the same vocabulary path, so it reclassifies too', async () => {
      mockRouterFetch();
      const svc = makeService();
      const ctx = makeTenantContext();
      const err = (await runWithFakeTimers(() => svc.describeTerm('culture', 'Aztecs', ctx))) as {
        code: number;
      };

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    });

    it('leaves the content endpoint alone — a per-ID 404 stays NotFound and is not retried', async () => {
      const fetchMock = mockRouterFetch();
      const svc = makeService();
      const ctx = makeTenantContext();
      const err = await svc.getContent('nasm_MISSING', ctx).catch((e) => e);

      // /content/{id} addresses one record, so its 404 is a genuine miss the
      // caller can act on. NotFound is non-transient — a single attempt.
      expect(err.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err.data?.reason).toBe('not_found');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Response cache wiring (issue #65)
// ---------------------------------------------------------------------------

/** An upstream answer in the shape `fetchWithTimeout` reads off a `Response`. */
function upstream(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

type Upstream = ReturnType<typeof upstream>;
type Endpoint = 'search' | 'content';
type Route = (init: RequestInit) => Upstream | Promise<Upstream>;

/** The endpoint a request addresses, read from its path: `…/search` or `…/content/{id}`. */
function endpointOf(input: string): Endpoint | undefined {
  const segments = new URL(input).pathname.split('/');
  if (segments.at(-1) === 'search') return 'search';
  if (segments.at(-2) === 'content') return 'content';
  return undefined;
}

/**
 * Stub fetch with one route per endpoint. A request to any other path, or to an
 * endpoint without a route, rejects, so an unexpected upstream call fails the test.
 */
function stubUpstream(routes: Partial<Record<Endpoint, Route>>) {
  const fetchMock = vi.fn(async (input: string, init: RequestInit) => {
    const endpoint = endpointOf(input);
    const route = endpoint ? routes[endpoint] : undefined;
    if (!route) throw new Error('unmocked fetch');
    return route(init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    /** Requests received on one endpoint. */
    count: (endpoint: Endpoint) =>
      fetchMock.mock.calls.filter(([input]) => endpointOf(input) === endpoint).length,
  };
}

/**
 * A route that holds every request until `release()`, and rejects one the way a
 * real fetch does once its request signal aborts. Never released, it only ends
 * when the signal aborts — a hung upstream. `signals` holds the signal each
 * request ran on; `arrived(n)` resolves once `n` requests have come in.
 */
function heldRoute(answer: Upstream) {
  const signals: AbortSignal[] = [];
  const gate = Promise.withResolvers<void>();
  const waiting: Array<{ count: number; resolve: () => void }> = [];
  const route: Route = (init) => {
    const signal = init.signal as AbortSignal;
    signals.push(signal);
    for (const waiter of waiting) if (signals.length >= waiter.count) waiter.resolve();
    return new Promise<Upstream>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      gate.promise.then(() => resolve(answer));
    });
  };
  const arrived = (count: number) =>
    signals.length >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => waiting.push({ count, resolve }));
  return { route, signals, arrived, release: () => gate.resolve() };
}

/** Run a call to its outcome — value or thrown error — with timeouts and backoff skipped. */
async function outcomeOf(run: () => Promise<unknown>): Promise<unknown> {
  vi.useFakeTimers();
  try {
    const pending = run().catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

describe('response cache wiring (issue #65)', () => {
  const SEARCH = { query: 'aircraft', rows: 10, start: 0 };
  const RECORD = 'nasm_TEST001';

  /** A context that is cancelled through `signal`. */
  function cancellableContext(signal: AbortSignal) {
    return createMockContext({ tenantId: 'test-tenant', signal });
  }

  /** One call to `endpoint` — the same request URL every time. */
  function callOn(svc: SmithsonianService, endpoint: Endpoint, ctx = makeTenantContext()) {
    return endpoint === 'search' ? svc.search(SEARCH, ctx) : svc.getContent(RECORD, ctx);
  }

  /** The 200 each endpoint answers on success. */
  function success(endpoint: Endpoint): Upstream {
    return upstream(endpoint === 'search' ? makeSearchResponse() : makeContentResponse(RECORD));
  }

  /** The error code a call rejected with. */
  async function codeOf(pending: Promise<unknown>): Promise<number | undefined> {
    return ((await pending) as { code?: number }).code;
  }

  beforeEach(() => {
    vi.stubEnv('SMITHSONIAN_API_KEY', 'test-key-12345');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('behavior the cache keeps', () => {
    it('search() reads a 200 without a response body as an empty page', async () => {
      stubUpstream({ search: () => upstream({ status: 200, responseCode: 1 }) });

      await expect(makeService().search(SEARCH, makeTenantContext())).resolves.toEqual({
        rows: [],
        rowCount: 0,
      });
    });

    it.each(['search', 'content'] as const)(
      'a caller cancelled mid-request rejects with RequestCancelled (%s)',
      async (endpoint) => {
        const held = heldRoute(success(endpoint));
        stubUpstream({ [endpoint]: held.route });
        const controller = new AbortController();

        const pending = callOn(
          makeService(),
          endpoint,
          cancellableContext(controller.signal),
        ).catch((error: unknown) => error);
        await held.arrived(1);
        controller.abort();

        expect(await codeOf(pending)).toBe(JsonRpcErrorCode.RequestCancelled);
      },
    );
  });

  it('serves a repeated identical search from one request, returning the same page', async () => {
    const up = stubUpstream({ search: () => success('search') });
    const svc = makeService();

    const first = await svc.search(SEARCH, makeTenantContext());
    const second = await svc.search(SEARCH, makeTenantContext());

    expect(up.count('search')).toBe(1);
    expect(second).toEqual(first);
    expect(second.rows[0]?.record_id).toBe('nasm_TEST001');
    expect(second.rowCount).toBe(42);
  });

  it('serves one record from one request, with or without the edanmdm: prefix', async () => {
    const up = stubUpstream({ content: () => success('content') });
    const svc = makeService();

    const bare = await svc.getContent(RECORD, makeTenantContext());
    const prefixed = await svc.getContent(`edanmdm:${RECORD}`, makeTenantContext());

    expect(up.count('content')).toBe(1);
    expect(prefixed).toEqual(bare);
    expect(prefixed.record.title).toBe('Test Object');
  });

  it('keys on the whole request URL: another page of the same query fetches', async () => {
    const up = stubUpstream({ search: () => success('search') });
    const svc = makeService();

    await svc.search(SEARCH, makeTenantContext());
    await svc.search({ ...SEARCH, start: 10 }, makeTenantContext());

    expect(up.count('search')).toBe(2);
    expect(new URL(up.fetchMock.mock.calls[1]![0]).searchParams.get('start')).toBe('10');
  });

  /** A route that never answers: only the request signal aborting ends it. */
  const hung: Route = (init) => heldRoute(success('content')).route(init);

  it.each([
    [
      'HTTP 429',
      'search',
      () => upstream({ error: { code: 'OVER_RATE_LIMIT', message: 'Try again later.' } }, 429),
      JsonRpcErrorCode.RateLimited,
    ],
    [
      'an error-in-200 rate-limit body',
      'search',
      () => upstream({ error: { code: 'OVER_RATE_LIMIT', message: 'Rate limit exceeded.' } }),
      JsonRpcErrorCode.ServiceUnavailable,
    ],
    [
      'an error-in-200 key body',
      'content',
      () => upstream({ error: { code: 'API_KEY_MISSING', message: 'No api_key was supplied.' } }),
      JsonRpcErrorCode.InternalError,
    ],
    [
      'HTTP 404',
      'content',
      () => upstream({ error: { code: 'NOT_FOUND', message: 'Record not found' } }, 404),
      JsonRpcErrorCode.NotFound,
    ],
    [
      'a 200 without a record',
      'content',
      () => upstream({ status: 200, responseCode: 1, response: null }),
      JsonRpcErrorCode.NotFound,
    ],
    ['a timeout', 'search', hung, JsonRpcErrorCode.Timeout],
    ['a timeout', 'content', hung, JsonRpcErrorCode.Timeout],
  ] as const)(
    'stores nothing after %s on %s — the next call fetches, and its success is stored',
    async (_label, endpoint, failure, code) => {
      let failing = true;
      const up = stubUpstream({
        [endpoint]: (init: RequestInit) => (failing ? failure(init) : success(endpoint)),
      });
      const svc = makeService();

      expect(await codeOf(outcomeOf(() => callOn(svc, endpoint)))).toBe(code);
      const failedRequests = up.count(endpoint);

      failing = false;
      await callOn(svc, endpoint);
      await callOn(svc, endpoint);

      expect(up.count(endpoint)).toBe(failedRequests + 1);
    },
  );

  it('returns a 200 without a search response body unstored — the next call fetches', async () => {
    let body: unknown = { status: 200, responseCode: 1 };
    const up = stubUpstream({ search: () => upstream(body) });
    const svc = makeService();

    expect(await svc.search(SEARCH, makeTenantContext())).toEqual({ rows: [], rowCount: 0 });
    body = makeSearchResponse();
    await svc.search(SEARCH, makeTenantContext());
    const third = await svc.search(SEARCH, makeTenantContext());

    expect(up.count('search')).toBe(2);
    expect(third.rowCount).toBe(42);
  });

  it.each(['search', 'content'] as const)(
    'stores nothing from a cancelled request — the next call fetches (%s)',
    async (endpoint) => {
      const held = heldRoute(success(endpoint));
      let route: Route = held.route;
      const up = stubUpstream({ [endpoint]: (init: RequestInit) => route(init) });
      const svc = makeService();
      const controller = new AbortController();

      const cancelled = callOn(svc, endpoint, cancellableContext(controller.signal)).catch(
        (error: unknown) => error,
      );
      await held.arrived(1);
      controller.abort();
      expect(await codeOf(cancelled)).toBe(JsonRpcErrorCode.RequestCancelled);

      route = () => success(endpoint);
      await callOn(svc, endpoint);
      await callOn(svc, endpoint);

      expect(up.count(endpoint)).toBe(2);
    },
  );

  it.each(['search', 'content'] as const)(
    'makes one request for two concurrent identical calls; cancelling one leaves the other its result (%s)',
    async (endpoint) => {
      const held = heldRoute(success(endpoint));
      const up = stubUpstream({ [endpoint]: held.route });
      const svc = makeService();
      const leaving = new AbortController();

      const cancelled = callOn(svc, endpoint, cancellableContext(leaving.signal)).catch(
        (error: unknown) => error,
      );
      const staying = callOn(svc, endpoint);
      await held.arrived(1);
      leaving.abort();

      expect(await codeOf(cancelled)).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(held.signals[0]?.aborted).toBe(false);
      held.release();
      expect(await staying).toMatchObject(
        endpoint === 'search' ? { rowCount: 42 } : { record: { title: 'Test Object' } },
      );

      // The surviving caller's answer was stored.
      await callOn(svc, endpoint);
      expect(up.count(endpoint)).toBe(1);
    },
  );

  it('aborts the shared request once every caller has cancelled, and the next call starts afresh', async () => {
    const held = heldRoute(success('content'));
    let route: Route = held.route;
    const up = stubUpstream({ content: (init: RequestInit) => route(init) });
    const svc = makeService();
    const first = new AbortController();
    const second = new AbortController();

    const firstCall = callOn(svc, 'content', cancellableContext(first.signal)).catch(
      (error: unknown) => error,
    );
    const secondCall = callOn(svc, 'content', cancellableContext(second.signal)).catch(
      (error: unknown) => error,
    );
    await held.arrived(1);
    first.abort();
    expect(held.signals[0]?.aborted).toBe(false);
    second.abort();
    expect(held.signals[0]?.aborted).toBe(true);
    expect(await codeOf(firstCall)).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(await codeOf(secondCall)).toBe(JsonRpcErrorCode.RequestCancelled);

    route = () => success('content');
    expect(await callOn(svc, 'content')).toMatchObject({ record: { title: 'Test Object' } });
    expect(up.count('content')).toBe(2);
  });

  it.each([
    ['search', 3_600],
    ['content', 86_400],
  ] as const)(
    'refetches %s once its default TTL of %i s has elapsed',
    async (endpoint, ttlSeconds) => {
      const up = stubUpstream({ [endpoint]: () => success(endpoint) });
      const svc = makeService();
      vi.useFakeTimers();

      await callOn(svc, endpoint);
      vi.setSystemTime(Date.now() + ttlSeconds * 1000 - 1);
      await callOn(svc, endpoint);
      expect(up.count(endpoint)).toBe(1);

      vi.setSystemTime(Date.now() + 1);
      await callOn(svc, endpoint);
      expect(up.count(endpoint)).toBe(2);
    },
  );

  describe('with a TTL of 0', () => {
    /** A service whose config reads the stubbed TTL — the config memo is module-level. */
    async function freshService(): Promise<SmithsonianService> {
      vi.resetModules();
      const { SmithsonianService: FreshService } = await import(
        '@/services/smithsonian/smithsonian-service.js'
      );
      return new FreshService(createInMemoryStorage());
    }

    it.each([
      ['search', 'SMITHSONIAN_SEARCH_CACHE_TTL_SECONDS'],
      ['content', 'SMITHSONIAN_CONTENT_CACHE_TTL_SECONDS'],
    ] as const)(
      "fetches %s on every call, concurrent ones each on the caller's own signal",
      async (endpoint, variable) => {
        vi.stubEnv(variable, '0');
        const svc = await freshService();
        const held = heldRoute(success(endpoint));
        const up = stubUpstream({ [endpoint]: held.route });
        const leaving = new AbortController();

        const cancelled = callOn(svc, endpoint, cancellableContext(leaving.signal)).catch(
          (error: unknown) => error,
        );
        const staying = callOn(svc, endpoint);
        await held.arrived(2);
        leaving.abort();

        expect(held.signals[0]?.aborted).toBe(true);
        expect(held.signals[1]?.aborted).toBe(false);
        expect(await codeOf(cancelled)).toBe(JsonRpcErrorCode.RequestCancelled);
        held.release();
        await staying;
        await callOn(svc, endpoint);

        expect(up.count(endpoint)).toBe(3);
      },
    );

    it.each([
      ['search', 'content', 'SMITHSONIAN_SEARCH_CACHE_TTL_SECONDS'],
      ['content', 'search', 'SMITHSONIAN_CONTENT_CACHE_TTL_SECONDS'],
    ] as const)('disables %s alone — %s stays cached', async (disabled, cached, variable) => {
      vi.stubEnv(variable, '0');
      const svc = await freshService();
      const up = stubUpstream({
        search: () => success('search'),
        content: () => success('content'),
      });

      for (let call = 0; call < 2; call++) {
        await callOn(svc, disabled);
        await callOn(svc, cached);
      }

      expect(up.count(disabled)).toBe(2);
      expect(up.count(cached)).toBe(1);
    });
  });

  describe('through the tools', () => {
    beforeEach(() => {
      initSmithsonianService({} as AppConfig, createInMemoryStorage());
    });

    it('get_object, get_media, and find_related on one record_id make one /content request', async () => {
      const up = stubUpstream({
        content: () => success('content'),
        search: () => success('search'),
      });

      const object = await runToolContract(smithsonianGetObject, { id: RECORD });
      const media = await runToolContract(smithsonianGetMedia, { id: RECORD });
      const related = await runToolContract(smithsonianFindRelated, { id: RECORD });

      for (const result of [object, media, related]) expect(result.isError).not.toBe(true);
      expect(up.count('content')).toBe(1);
    });

    it('a repeated search_objects call makes one /search request and returns the same output', async () => {
      const up = stubUpstream({ search: () => success('search') });

      const first = await runToolContract(smithsonianSearchObjects, { query: 'aircraft' });
      const second = await runToolContract(smithsonianSearchObjects, { query: 'aircraft' });

      expect(first.isError).not.toBe(true);
      expect(up.count('search')).toBe(1);
      expect(second.structuredContent).toEqual(first.structuredContent);
      expect(second.content).toEqual(first.content);
    });
  });

  describe('the retry loop each read runs', () => {
    /** An error-in-200 rate-limit body: transient, so the loop backs off 2 s and retries. */
    const rateLimited: Route = () =>
      upstream({ error: { code: 'OVER_RATE_LIMIT', message: 'Rate limit exceeded.' } });

    it.each([
      ['search', 'SMITHSONIAN_SEARCH_CACHE_TTL_SECONDS'],
      ['content', 'SMITHSONIAN_CONTENT_CACHE_TTL_SECONDS'],
    ] as const)(
      'releases a caller cancelled during a backoff at once, with no further request (%s, TTL 0)',
      async (endpoint, variable) => {
        vi.stubEnv(variable, '0');
        vi.resetModules();
        const { SmithsonianService: FreshService } = await import(
          '@/services/smithsonian/smithsonian-service.js'
        );
        const svc = new FreshService(createInMemoryStorage());
        const up = stubUpstream({ [endpoint]: rateLimited });
        vi.useFakeTimers();
        const controller = new AbortController();
        let settled = false;

        const pending = callOn(svc, endpoint, cancellableContext(controller.signal))
          .catch((error: unknown) => error)
          .finally(() => {
            settled = true;
          });
        await vi.advanceTimersByTimeAsync(0);
        expect(up.count(endpoint)).toBe(1);
        controller.abort();
        await vi.advanceTimersByTimeAsync(0);

        expect(settled).toBe(true);
        expect(((await pending) as Error).name).toBe('AbortError');
        await vi.runAllTimersAsync();
        expect(up.count(endpoint)).toBe(1);
      },
    );

    it.each(['search', 'content'] as const)(
      "ends the shared request's backoff once its last caller leaves, leaving no timer running (%s)",
      async (endpoint) => {
        const up = stubUpstream({ [endpoint]: rateLimited });
        vi.useFakeTimers();
        const controller = new AbortController();

        const pending = callOn(
          makeService(),
          endpoint,
          cancellableContext(controller.signal),
        ).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(0);
        expect(up.count(endpoint)).toBe(1);
        controller.abort();
        expect(await codeOf(pending)).toBe(JsonRpcErrorCode.RequestCancelled);
        await vi.advanceTimersByTimeAsync(0);

        expect(vi.getTimerCount()).toBe(0);
        expect(up.count(endpoint)).toBe(1);
      },
    );

    it.each(['search', 'content'] as const)(
      'gives up on a hung upstream within one 50 s deadline across attempts and backoff (%s)',
      async (endpoint) => {
        stubUpstream({ [endpoint]: hung });
        vi.useFakeTimers();
        let settled = false;

        const pending = callOn(makeService(), endpoint)
          .catch((error: unknown) => error)
          .finally(() => {
            settled = true;
          });
        await vi.advanceTimersByTimeAsync(50_000);

        expect(settled).toBe(true);
        const error = (await pending) as { code?: number; data?: { reason?: string } };
        expect(error.code).toBe(JsonRpcErrorCode.Timeout);
        expect(error.data?.reason).toBe('retry_deadline_exceeded');
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Open Access mirror routing (issue #66)
// ---------------------------------------------------------------------------

/**
 * Real `metadata/edan/` lines. The mirror below ingests lines 0–4 as one shard and the rest as
 * the next, so its rowid order is line order.
 */
const OA_FIXTURE_LINES = readFileSync(
  new URL('./fixtures/oa-bulk-lines.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter(Boolean);

describe('Open Access mirror routing (issue #66)', () => {
  /** The LastModified the bucket fake lists each shard with, which the sync records as the snapshot. */
  const SNAPSHOT = '2026-10-26T07:25:06.000Z';
  const FROM_MIRROR = { source: 'oa_mirror', snapshot: SNAPSHOT };
  const FROM_LIVE = { source: 'edan_api' };
  /** Fixture line 0. */
  const MIRRORED = 'nasm_A19820121000';
  /** In no fixture line: only the live API holds it. */
  const LIVE_ONLY = 'nasm_TEST001';
  /** Matches fixture lines 0, 3, and 6. */
  const ONLINE_CC0: FacetFilter[] = [{ field: 'online_only' }, { field: 'cc0' }];

  type Read = 'getContent' | 'search';
  const ENDPOINT = { getContent: 'content', search: 'search' } as const satisfies Record<
    Read,
    Endpoint
  >;

  let t: TestMirror;

  function withMirror(mirror: TestMirror): SmithsonianService {
    return new SmithsonianService(createInMemoryStorage(), mirror.reader);
  }

  /** A read the mirror can answer: a record it holds, or a filter-only search. */
  function mirrorable(svc: SmithsonianService, read: Read) {
    return read === 'getContent'
      ? svc.getContent(MIRRORED, makeTenantContext())
      : svc.search({ query: '', rows: 10, start: 0, filters: ONLINE_CC0 }, makeTenantContext());
  }

  /** Both live routes, each answering the same success every time. */
  function stubLive() {
    return stubUpstream({
      content: () => upstream(makeContentResponse(MIRRORED)),
      search: () => upstream(makeSearchResponse()),
    });
  }

  beforeEach(async () => {
    vi.stubEnv('SMITHSONIAN_API_KEY', 'test-key-12345');
    const bucket = new FakeBucket();
    bucket.put('metadata/edan/aaa/00.txt', OA_FIXTURE_LINES.slice(0, 5));
    bucket.put('metadata/edan/bbb/00.txt', OA_FIXTURE_LINES.slice(5));
    vi.stubGlobal('fetch', bucket.fetch);
    t = openTestMirror();
    await t.mirror.runSync({ mode: 'init' });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await t.close();
  });

  it.each([MIRRORED, `edanmdm:${MIRRORED}`])(
    'getContent(%s) answers a record the mirror holds from the mirror, with its snapshot and no EDAN request',
    async (id) => {
      const up = stubUpstream({});

      const read = await withMirror(t).getContent(id, makeTenantContext());

      expect(up.fetchMock).not.toHaveBeenCalled();
      expect(read.provenance).toStrictEqual(FROM_MIRROR);
      expect(read.record.url).toBe(`edanmdm:${MIRRORED}`);
      expect(read.record.title).toBe('Missile, Cruise, Air-launched, Flight Test, AGM-86B ALCM');
    },
  );

  it('getContent sends a record the mirror lacks to the live API, marked edan_api', async () => {
    const up = stubUpstream({ content: () => upstream(makeContentResponse(LIVE_ONLY)) });

    const read = await withMirror(t).getContent(LIVE_ONLY, makeTenantContext());

    expect(up.count('content')).toBe(1);
    expect(read.provenance).toStrictEqual(FROM_LIVE);
    expect(read.record.title).toBe('Test Object');
  });

  it('getContent still rejects a record neither the mirror nor the live API holds as not_found', async () => {
    const up = stubUpstream({
      content: () => upstream({ error: { code: 'NOT_FOUND', message: 'Record not found' } }, 404),
    });

    await expect(
      withMirror(t).getContent('nasm_MISSING', makeTenantContext()),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { reason: 'not_found' } });
    expect(up.count('content')).toBe(1);
  });

  it.each(['getContent', 'search'] as const)(
    '%s answers live when the store fails, and logs the failure at error once',
    async (read) => {
      const errors = vi.spyOn(logger, 'error').mockImplementation(() => {});
      (await t.store.raw()).exec('DROP TABLE objects');
      const up = stubLive();

      const result = await mirrorable(withMirror(t), read);

      expect(up.count(ENDPOINT[read])).toBe(1);
      expect(result.provenance).toStrictEqual(FROM_LIVE);
      expect(errors).toHaveBeenCalledTimes(1);
      const [message, error] = errors.mock.calls[0]!;
      expect(message).toBe('Open Access mirror read failed; answering from the live API.');
      expect((error as Error).message).toMatch(/no such table: objects/);
    },
  );

  it.each(['getContent', 'search'] as const)(
    '%s answers live, without logging an error, from a mirror that has never completed a sync',
    async (read) => {
      const errors = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const unsynced = openTestMirror();
      try {
        const up = stubLive();

        const result = await mirrorable(withMirror(unsynced), read);

        expect(up.count(ENDPOINT[read])).toBe(1);
        expect(result.provenance).toStrictEqual(FROM_LIVE);
        expect(errors).not.toHaveBeenCalled();
      } finally {
        await unsynced.close();
      }
    },
  );

  it.each(['', '*'])(
    'search serves query %j with filters from the mirror: rows in ingest order, rowCount the facet count, no EDAN request',
    async (query) => {
      const up = stubUpstream({});

      const page = await withMirror(t).search(
        { query, rows: 2, start: 0, filters: ONLINE_CC0 },
        makeTenantContext(),
      );

      expect(up.fetchMock).not.toHaveBeenCalled();
      expect(page.rows.map((r) => r.record_id)).toEqual(['nasm_A19820121000', 'nmnhvz_14945304']);
      expect(page.rowCount).toBe(3);
      expect(page.provenance).toStrictEqual(FROM_MIRROR);
    },
  );

  it.each([
    ['no record matches', [{ field: 'unit_code', value: 'SAO' }], 0, 0],
    ['the page starts past the last match', ONLINE_CC0, 3, 3],
  ] as const)(
    'search serves an empty page from the mirror when %s',
    async (_label, filters, start, total) => {
      const up = stubUpstream({});

      const page = await withMirror(t).search(
        { query: '', rows: 10, start, filters },
        makeTenantContext(),
      );

      expect(up.fetchMock).not.toHaveBeenCalled();
      expect(page.rows).toEqual([]);
      expect(page.rowCount).toBe(total);
      expect(page.provenance).toStrictEqual(FROM_MIRROR);
    },
  );

  it('search sends free text with filters to the live API, the filters ANDed into q', async () => {
    const up = stubUpstream({ search: () => upstream(makeSearchResponse()) });

    // The mirror holds one NASM record titled "Missile, …"; the live API answers 42.
    const page = await withMirror(t).search(
      { query: 'missile', rows: 10, start: 0, filters: [{ field: 'unit_code', value: 'NASM' }] },
      makeTenantContext(),
    );

    expect(up.count('search')).toBe(1);
    expect(new URL(up.fetchMock.mock.calls[0]![0]).searchParams.get('q')).toBe(
      'missile AND unit_code:"NASM"',
    );
    expect(page.rowCount).toBe(42);
    expect(page.provenance).toStrictEqual(FROM_LIVE);
  });

  it('serves the live answer to a mirror miss from the response cache on repeat', async () => {
    const up = stubUpstream({ content: () => upstream(makeContentResponse(LIVE_ONLY)) });
    const svc = withMirror(t);

    const first = await svc.getContent(LIVE_ONLY, makeTenantContext());
    const second = await svc.getContent(LIVE_ONLY, makeTenantContext());

    expect(up.count('content')).toBe(1);
    expect(second).toEqual(first);
    expect(second.provenance).toStrictEqual(FROM_LIVE);
  });

  it('reports no provenance on either read without a mirror', async () => {
    const up = stubUpstream({
      content: () => upstream(makeContentResponse(LIVE_ONLY)),
      search: () => upstream(makeSearchResponse()),
    });
    const svc = makeService();

    const read = await svc.getContent(LIVE_ONLY, makeTenantContext());
    const page = await svc.search(
      { query: '', rows: 10, start: 0, filters: ONLINE_CC0 },
      makeTenantContext(),
    );

    expect(up.count('content')).toBe(1);
    expect(up.count('search')).toBe(1);
    expect('provenance' in read).toBe(false);
    expect('provenance' in page).toBe(false);
    expect(read.record.title).toBe('Test Object');
    expect(page.rowCount).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// luceneField — Lucene term construction (issue #42)
// ---------------------------------------------------------------------------

describe('luceneField', () => {
  it('quotes an ordinary single-token value', () => {
    // Quoting is inert here: unit_code:"NASM" and unit_code:NASM return the same
    // 1,020 objects upstream. It costs nothing and closes the wildcard hole below.
    expect(luceneField('unit_code', 'NASM')).toBe('unit_code:"NASM"');
  });

  it('quotes a value containing spaces', () => {
    // Unquoted, EDAN ends the field term at the first space and parses the trailing
    // words as free text — the defect #32 fixed and this preserves.
    expect(luceneField('culture', 'Plains Indian')).toBe('culture:"Plains Indian"');
  });

  it('escapes an embedded double quote', () => {
    // `Early Iron Age, "Tomb Age"` is a live culture term. Unescaped, the inner quote
    // closes the phrase and EDAN returns 0; escaped, it returns the term's 3 objects.
    expect(luceneField('culture', 'Early Iron Age, "Tomb Age"')).toBe(
      'culture:"Early Iron Age, \\"Tomb Age\\""',
    );
  });

  it('escapes an embedded backslash', () => {
    // `Argentina \ Chile` is a live place term; the backslash is otherwise read as
    // an escape sequence and the term matches nothing.
    expect(luceneField('place', 'Argentina \\ Chile')).toBe('place:"Argentina \\\\ Chile"');
  });

  it('neutralizes a bare wildcard value', () => {
    // `*` is a literal term in the `place` vocabulary. Unquoted, `place:*` is a
    // wildcard matching every record with any place — 12,378,789 against the 124 the
    // term actually has, reported to the caller as that term's total.
    expect(luceneField('place', '*')).toBe('place:"*"');
  });

  it('escapes both metacharacters in one value', () => {
    expect(luceneField('topic', 'a\\b"c')).toBe('topic:"a\\\\b\\"c"');
  });
});

// ---------------------------------------------------------------------------
// toPlainText — markup stripping and entity decoding (issue #49)
// ---------------------------------------------------------------------------

describe('toPlainText', () => {
  it('decodes a numeric entity to its character', () => {
    // The live title of slasro_92924.
    expect(toPlainText('A nonpotential model for the Sun&#39;s open magnetic flux')).toBe(
      "A nonpotential model for the Sun's open magnetic flux",
    );
  });

  it('decodes a hexadecimal entity', () => {
    expect(toPlainText('Women&#x27;s Suffrage')).toBe("Women's Suffrage");
  });

  it('decodes &amp; to a bare ampersand', () => {
    // The case a tag-stripping HTML sanitizer alone leaves unfixed: it re-escapes
    // the ampersand it just decoded, because it targets safe HTML re-serialization
    // rather than plain text.
    expect(toPlainText('Arts &amp; Crafts')).toBe('Arts & Crafts');
  });

  it('reduces an anchor to its link text and drops the URL', () => {
    expect(
      toPlainText(
        'Yeates, A. R. 2010. "<a href="http://adsabs.harvard.edu/abs/2010JGRA">A nonpotential model</a>." <em>JGR</em> 115.',
      ),
    ).toBe('Yeates, A. R. 2010. "A nonpotential model." JGR 115.');
  });

  it('keeps an inline tag from splitting the word it sits inside', () => {
    // <sub>/<sup> mark up a formula, not a word break — H2O, never "H 2 O".
    expect(toPlainText('H<sub>2</sub>O and E=mc<sup>2</sup>')).toBe('H2O and E=mc2');
  });

  it('separates the lines a <br> or <p> was holding apart', () => {
    expect(toPlainText('Line one<br>Line two<p>Line three</p>')).toBe(
      'Line one Line two Line three',
    );
  });

  it('leaves a legitimately bare ampersand untouched', () => {
    // R&D is not a character reference, so nothing resolves and nothing escapes.
    expect(toPlainText('R&D Laboratory, Barnes & Noble')).toBe('R&D Laboratory, Barnes & Noble');
  });

  it('leaves bare angle brackets untouched — they are not tags', () => {
    // A `<` followed by a space or a digit cannot open a tag, so the text after
    // it must survive rather than being eaten up to the next `>`.
    expect(toPlainText('Specimens < 5 mm > 2 mm')).toBe('Specimens < 5 mm > 2 mm');
    expect(toPlainText('Depth <20 m, salinity >30 ppt')).toBe('Depth <20 m, salinity >30 ppt');
  });

  it('decodes exactly once — never twice', () => {
    // &amp;#39; is a title that quotes an entity. One pass yields the entity;
    // a second would yield an apostrophe and silently rewrite the catalog.
    expect(toPlainText('The entity &amp;#39; is an apostrophe')).toBe(
      'The entity &#39; is an apostrophe',
    );
  });

  it('does not re-strip a tag that a decode produced', () => {
    // Strip runs before decode, so a title ABOUT a tag keeps it.
    expect(toPlainText('The &lt;b&gt; element')).toBe('The <b> element');
  });

  it('leaves an unknown named entity as written rather than dropping text', () => {
    expect(toPlainText('Alpha &fakeentity; Omega')).toBe('Alpha &fakeentity; Omega');
  });

  it('leaves a lone surrogate reference alone — it cannot be encoded', () => {
    expect(toPlainText('bad &#55296; reference')).toBe('bad &#55296; reference');
  });

  it('returns unmarked-up text byte-identical, line structure included', () => {
    const note = '  Line one\n\n  Line two  ';
    expect(toPlainText(note)).toBe(note);
  });

  it('handles the empty string', () => {
    expect(toPlainText('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Indexed unit code and holding museum (issue #64)
// ---------------------------------------------------------------------------

/**
 * A record in the shape every `OCIO_DPO3D` record carries: top-level `unitCode` is
 * the code EDAN indexes (what a `unit_code` filter matches), while
 * `descriptiveNonRepeating.unit_code` is the record's own and `data_source` names
 * the unit that holds the object. Passing `undefined` omits the field.
 */
function makeUnitRecord(
  indexed: string | undefined,
  recordCode: string | undefined,
  dataSource: string | undefined,
): RawEDAN {
  return {
    id: 'ld1-unit',
    title: 'Cassiopeia A Supernova Remnant',
    ...(indexed !== undefined && { unitCode: indexed }),
    url: 'edanmdm:dpo_3d_200012',
    content: {
      descriptiveNonRepeating: {
        record_ID: 'dpo_3d_200012',
        ...(recordCode !== undefined && { unit_code: recordCode }),
        ...(dataSource !== undefined && { data_source: dataSource }),
        metadata_usage: { access: 'CC0' },
      },
    },
  };
}

const OCIO_NAME =
  'Office of the Chief Information Officer - Digitization Program Office (3D digitization)';

describe('indexed unit code and holding museum (issue #64)', () => {
  it('leaves a record whose two codes agree unchanged, with no holding museum', () => {
    const svc = makeService();
    const raw = makeUnitRecord('NASM', 'NASM', 'National Air and Space Museum');
    for (const projected of [svc.toSummary(raw), svc.toFullObject(raw)]) {
      expect(projected.unit_code).toBe('NASM');
      expect(projected.museum_name).toBe('National Air and Space Museum');
      expect(projected).not.toHaveProperty('holding_museum_name');
    }
  });

  it.each([
    // Every record code the 112 OCIO_DPO3D records carry, with its data_source. Eight of the
    // SERC records give the bare code as their data_source, the ninth the unit's name.
    ['SAO', 'Smithsonian Astrophysical Observatory', 'Smithsonian Astrophysical Observatory'],
    ['DPO', 'NMNH - Paleobiology Dept.', 'NMNH - Paleobiology Dept.'],
    ['DPO', 'Cooper Hewitt, Smithsonian Design Museum', 'Cooper Hewitt, Smithsonian Design Museum'],
    ['NMNHANTHRO', 'NMNH - Anthropology Dept.', 'NMNH - Anthropology Dept.'],
    ['SERC', 'SERC', 'Smithsonian Environmental Research Center'],
    [
      'SERC',
      'Smithsonian Environmental Research Center',
      'Smithsonian Environmental Research Center',
    ],
    ['NMNHINV', 'NMNH - Invertebrate Zoology Dept.', 'NMNH - Invertebrate Zoology Dept.'],
    ['NMAL', 'National Museum of the American Latino', 'National Museum of the American Latino'],
    // A data_source that is another known unit code resolves the same way.
    ['DPO', 'NMNHPALEO', 'NMNH - Paleobiology Dept.'],
    // Only the name table's own keys resolve; an inherited property name stays as given.
    ['DPO', 'constructor', 'constructor'],
  ])(
    'reports the indexed code and the holding unit for record code %s (data_source %s)',
    (recordCode, dataSource, holding) => {
      const svc = makeService();
      const raw = makeUnitRecord('OCIO_DPO3D', recordCode, dataSource);
      for (const projected of [svc.toSummary(raw), svc.toFullObject(raw)]) {
        expect(projected.unit_code).toBe('OCIO_DPO3D');
        expect(projected.museum_name).toBe(OCIO_NAME);
        expect(projected.holding_museum_name).toBe(holding);
      }
    },
  );

  it('echoes an unmapped indexed code as the museum name, never an inherited property', () => {
    const svc = makeService();
    const raw = makeUnitRecord('toString', 'toString', undefined);
    for (const projected of [svc.toSummary(raw), svc.toFullObject(raw)]) {
      expect(projected.unit_code).toBe('toString');
      expect(projected.museum_name).toBe('toString');
    }
  });

  it('falls back to the record code when the indexed unitCode is absent', () => {
    const svc = makeService();
    const raw = makeUnitRecord(undefined, 'NMNHPALEO', 'NMNH - Paleobiology Dept.');
    for (const projected of [svc.toSummary(raw), svc.toFullObject(raw)]) {
      expect(projected.unit_code).toBe('NMNHPALEO');
      expect(projected.museum_name).toBe('NMNH - Paleobiology Dept.');
      expect(projected).not.toHaveProperty('holding_museum_name');
    }
  });

  it('reads the indexed code when the record carries no code of its own', () => {
    const svc = makeService();
    const raw = makeUnitRecord('OCIO_DPO3D', undefined, 'Smithsonian Astrophysical Observatory');
    for (const projected of [svc.toSummary(raw), svc.toFullObject(raw)]) {
      expect(projected.unit_code).toBe('OCIO_DPO3D');
      expect(projected).not.toHaveProperty('holding_museum_name');
    }
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('omits the holding museum when data_source is %s, codes still differing', (_, dataSource) => {
    const svc = makeService();
    const raw = makeUnitRecord('OCIO_DPO3D', 'SAO', dataSource);
    for (const projected of [svc.toSummary(raw), svc.toFullObject(raw)]) {
      expect(projected.unit_code).toBe('OCIO_DPO3D');
      expect(projected).not.toHaveProperty('holding_museum_name');
    }
  });
});

// ---------------------------------------------------------------------------
// Non-image media on media_summary (issue #62)
// ---------------------------------------------------------------------------

/** A record whose `online_media.media[]` is exactly `media`, counted as given. */
function makeMediaRecord(
  media: NonNullable<RawEDAN['content']>['descriptiveNonRepeating'],
): RawEDAN {
  return {
    title: 'Media Record',
    unitCode: 'NMNHMAMMALS',
    content: { descriptiveNonRepeating: { record_ID: 'media_TEST', ...media } },
  };
}

const VOYAGER_URL = 'https://3d-api.si.edu/voyager/3d_package:732d123d-7a35-411b-a4e1-5e355adcacf8';

describe('media_summary.non_image_media (issue #62)', () => {
  it('counts an untyped item with a media id as an image, as smithsonian_get_media does', () => {
    const svc = makeService();
    const raw = makeMediaRecord({
      online_media: {
        mediaCount: 2,
        media: [
          { idsId: 'NMNH-UNTYPED', usage: { access: 'CC0' } },
          { idsId: 'NMNH-TYPED', type: 'Images', usage: { access: 'CC0' } },
        ],
      },
    });
    expect(svc.toImageItems(raw).map((img) => img.media_id)).toEqual([
      'NMNH-UNTYPED',
      'NMNH-TYPED',
    ]);
    expect(svc.toFullObject(raw).media_summary.cc0_image_count).toBe(2);
  });

  it('lists a 3D package by its viewer URL, never its per-file resources (dpo_3d_200012)', () => {
    const raw = makeMediaRecord({
      online_media: {
        mediaCount: 1,
        media: [
          {
            id: '3d_package:732d123d-7a35-411b-a4e1-5e355adcacf8',
            type: '3d_voyager',
            content: VOYAGER_URL,
            thumbnail:
              'https://3d-api.si.edu/content/document/3d_package:732d123d-7a35-411b-a4e1-5e355adcacf8/scene-image-thumb.jpg',
            usage: { access: 'CC0' },
            resources: [
              {
                url: 'https://3d-api.si.edu/content/document/3d_package:732d123d-7a35-411b-a4e1-5e355adcacf8/resources/CASSIOPEIAA-100k-2048_std.usdz',
              },
              {
                url: 'https://3d-api.si.edu/content/document/3d_package:732d123d-7a35-411b-a4e1-5e355adcacf8/resources/CASSIOPEIAA-100k-2048_std.glb',
              },
            ],
          },
        ],
      },
    });
    const summary = makeService().toFullObject(raw).media_summary;
    expect(summary.non_image_media).toEqual([
      { type: '3d_voyager', url: VOYAGER_URL, is_cc0: true },
    ]);
    expect(summary.cc0_image_count).toBe(0);
  });

  it('lists both scanned-book links of siris_sil_893158', () => {
    const raw = makeMediaRecord({
      online_media: {
        mediaCount: 2,
        media: [
          {
            id: 'media:',
            type: 'Scanned books',
            content: 'https://doi.org/10.5479/sil.893158.39088019035187',
            usage: { access: 'CC0' },
          },
          {
            id: 'media:',
            type: 'Scanned books',
            content: 'https://biodiversitylibrary.org/bibliography/179335',
            usage: { access: 'CC0' },
          },
        ],
      },
    });
    expect(makeService().toFullObject(raw).media_summary.non_image_media).toEqual([
      {
        type: 'Scanned books',
        url: 'https://doi.org/10.5479/sil.893158.39088019035187',
        is_cc0: true,
      },
      {
        type: 'Scanned books',
        url: 'https://biodiversitylibrary.org/bibliography/179335',
        is_cc0: true,
      },
    ]);
  });

  it('lists the field-book viewer and PDF of fbr_item_MODSI843', () => {
    const raw = makeMediaRecord({
      online_media: {
        mediaCount: 2,
        media: [
          {
            type: 'slideshowXML',
            content:
              'http://siarchives.si.edu/sites/default/files/viewers/csc/viewer_MODSI843_007267_B02_F08.xml',
            usage: { access: 'CC0' },
          },
          {
            type: 'Electronic resource',
            content:
              'http://siarchives.si.edu/sites/default/files/media/SIA-SIA_007267_B02_F08.pdf',
            usage: { access: 'CC0' },
          },
        ],
      },
    });
    expect(
      makeService()
        .toFullObject(raw)
        .media_summary.non_image_media.map((m) => m.type),
    ).toEqual(['slideshowXML', 'Electronic resource']);
  });

  it('lists all 49 3D packages beside 13 images (nmnhvz_7047834) — the two selections partition media[]', () => {
    const images = Array.from({ length: 13 }, (_, i) => ({
      id: `media-${i}`,
      idsId: `NMNH-IMG-${i}`,
      type: 'Images',
      usage: { access: 'CC0' },
    }));
    const packages = Array.from({ length: 49 }, (_, i) => ({
      id: `3d_package:${i}`,
      type: '3d_voyager',
      content: `https://3d-api.si.edu/voyager/3d_package:${i}`,
      usage: { access: 'CC0' },
    }));
    const svc = makeService();
    const raw = makeMediaRecord({
      online_media: { mediaCount: 62, media: [...images, ...packages] },
    });
    const summary = svc.toFullObject(raw).media_summary;
    expect(summary.count).toBe(62);
    expect(summary.cc0_image_count).toBe(13);
    expect(summary.non_image_media).toHaveLength(49);
    expect(summary.non_image_media.map((m) => m.url)).toEqual(packages.map((p) => p.content));
    expect(svc.toImageItems(raw).length + summary.non_image_media.length).toBe(62);
  });

  it('puts every item on exactly one side: Images and untyped are images, anything else is not', () => {
    const svc = makeService();
    const raw = makeMediaRecord({
      online_media: {
        mediaCount: 5,
        media: [
          { idsId: 'A', type: 'Images', usage: { access: 'CC0' } },
          { idsId: 'B', usage: { access: 'CC0' } },
          { idsId: 'C', type: '', usage: { access: 'CC0' } },
          { idsId: 'D', type: 'images', content: 'https://example.si.edu/d' },
          { idsId: 'E', type: '3d_voyager', content: 'https://example.si.edu/e' },
        ],
      },
    });
    expect(svc.toImageItems(raw).map((img) => img.media_id)).toEqual(['A', 'B', 'C']);
    expect(svc.toFullObject(raw).media_summary.non_image_media.map((m) => m.type)).toEqual([
      'images',
      '3d_voyager',
    ]);
  });

  it('omits url when the item has no content, and reads CC0 from usage.access as images do', () => {
    const raw = makeMediaRecord({
      online_media: {
        mediaCount: 4,
        media: [
          { type: '3d_voyager', usage: { access: 'CC0' } },
          { type: 'Scanned books', content: '', usage: { access: 'Usage Conditions Apply' } },
          { type: 'Electronic resource', content: 'https://example.si.edu/r.pdf' },
          { type: 'slideshowXML', content: 'https://example.si.edu/v.xml', usage: {} },
        ],
      },
    });
    const listed = makeService().toFullObject(raw).media_summary.non_image_media;
    expect(listed).toEqual([
      { type: '3d_voyager', is_cc0: true },
      { type: 'Scanned books', is_cc0: false },
      { type: 'Electronic resource', url: 'https://example.si.edu/r.pdf', is_cc0: false },
      { type: 'slideshowXML', url: 'https://example.si.edu/v.xml', is_cc0: false },
    ]);
    expect(listed[0]).not.toHaveProperty('url');
    expect(listed[1]).not.toHaveProperty('url');
  });

  it('is empty when the object has no media, or only images', () => {
    const svc = makeService();
    expect(svc.toFullObject({}).media_summary.non_image_media).toEqual([]);
    const imagesOnly = makeMediaRecord({
      online_media: {
        mediaCount: 1,
        media: [{ idsId: 'IMG', type: 'Images', usage: { access: 'CC0' } }],
      },
    });
    expect(svc.toFullObject(imagesOnly).media_summary.non_image_media).toEqual([]);
  });
});
