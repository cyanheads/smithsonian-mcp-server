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
import { smithsonianListTerms } from '@/mcp-server/tools/definitions/smithsonian-list-terms.tool.js';
import { smithsonianSearchObjects } from '@/mcp-server/tools/definitions/smithsonian-search-objects.tool.js';
import type { FacetFilter } from '@/services/smithsonian/oa-mirror.js';
import {
  type CallDeadline,
  hasActiveLuceneSyntax,
  initSmithsonianService,
  luceneField,
  luceneFilter,
  SmithsonianService,
  startCallDeadline,
  toPlainText,
} from '@/services/smithsonian/smithsonian-service.js';
import type {
  RawContentResponse,
  RawEDAN,
  RawMediaItem,
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
      const result = await svc.search(
        { query: 'aircraft', rows: 10, start: 0 },
        ctx,
        startCallDeadline(),
      );
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
      await svc.search({ query: 'test', rows: 5, start: 0 }, ctx, startCallDeadline());
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
        await makeService().search(
          { query, filters, rows: 1, start: 0 },
          makeTenantContext(),
          startCallDeadline(),
        );
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
      await makeService().search(
        { query, filters: NASM, rows: 1, start: 0 },
        makeTenantContext(),
        startCallDeadline(),
      );
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
        startCallDeadline(),
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
      await expect(
        svc.search({ query: 'test', rows: 5, start: 0 }, ctx, startCallDeadline()),
      ).rejects.toThrow(/API key missing/i);
    });

    it('API_KEY_MISSING error-in-200 uses InternalError code — not retryable', async () => {
      mockFetch({ error: { code: 'API_KEY_MISSING', message: 'No api_key was supplied.' } });
      const svc = makeService();
      const ctx = makeTenantContext();
      const err = await svc
        .search({ query: 'test', rows: 5, start: 0 }, ctx, startCallDeadline())
        .catch((e) => e);
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
      const promise = svc
        .search({ query: 'test', rows: 5, start: 0 }, ctx, startCallDeadline())
        .catch((e) => e);
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
      const promise = svc
        .search({ query: 'test', rows: 5, start: 0 }, ctx, startCallDeadline())
        .catch((e) => e);
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
      const result = await svc.search(
        { query: 'sparse', rows: 5, start: 0 },
        ctx,
        startCallDeadline(),
      );
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
      const { record: raw } = await svc.getContent('nasm_TEST001', ctx, startCallDeadline());
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
      await svc.getContent('nasm_TEST001', ctx, startCallDeadline());
      const calledUrl = (fetchMock.mock.calls[0] as [string])[0];
      expect(calledUrl).toContain('edanmdm%3Anasm_TEST001');
    });

    it('fails a 200 without a record as an upstream fault, not a missing object (issue #72)', async () => {
      // EDAN answers a missing object with HTTP 404 (below); a 200 carrying no record is
      // a malformed reply, so the caller is not told the ID is wrong.
      mockFetch({ status: 200, responseCode: 1, response: null });
      const svc = makeService();
      const ctx = makeTenantContext();
      const err = (await outcomeOf(() =>
        svc.getContent('nasm_MISSING', ctx, startCallDeadline()),
      )) as {
        code: number;
        data?: Record<string, unknown>;
      };
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data?.reason).toBe('upstream_unavailable');
      expect(err.data?.recordId).toBeUndefined();
    });

    it("never hands a 200 without a record the tool's not_found hint (issue #72)", async () => {
      mockFetch({ status: 200, responseCode: 1, response: null });
      initSmithsonianService({} as AppConfig, createInMemoryStorage());
      const result = (await outcomeOf(() =>
        runToolContract(smithsonianGetObject, { id: 'nasm_MISSING' }),
      )) as Awaited<ReturnType<typeof runToolContract>>;
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.ServiceUnavailable },
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain(NOT_FOUND_RECOVERY);
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
      const err = await svc.getContent('nasm_MISSING', ctx, startCallDeadline()).catch((e) => e);
      expect(err.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err.message).toMatch(/nasm_MISSING/i);
      // Live-exercised path (real HTTP 404 → real notFound factory): reason must be present.
      expect(err.data?.reason).toBe('not_found');
    });

    it('carries the declared recovery hint on the HTTP 404 rewrap path (issue #25)', async () => {
      // Resolved from the real tool contract, not a copied string — so a contract
      // reword can't silently drift away from what reaches the wire.
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
          url: 'edanmdm:saam_DIRECT001',
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
      const { record: raw } = await svc.getContent('saam_DIRECT001', ctx, startCallDeadline());
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

    it('keeps every date, place, and identifier with content, in catalog order, under its own label or the fallback', () => {
      const full = makeService().toFullObject({
        content: {
          freetext: {
            date: [
              { label: 'Date', content: '1903' },
              { content: 'ca. 1900' },
              { label: 'Accession Date', content: '' },
              { label: 'Date', content: '1903' },
            ],
            place: [{ label: 'Place of Origin', content: 'Dayton, Ohio' }, { content: 'Ohio' }],
            identifier: [
              { label: 'Inventory Number', content: 'A19610048000' },
              { content: 'A1961' },
              { label: 'Empty' },
            ],
          },
        },
      });
      expect(full.dates).toStrictEqual([
        { label: 'Date', value: '1903' },
        { label: 'Date', value: 'ca. 1900' },
        { label: 'Date', value: '1903' },
      ]);
      expect(full.place).toStrictEqual([
        { label: 'Place of Origin', value: 'Dayton, Ohio' },
        { label: 'Place', value: 'Ohio' },
      ]);
      expect(full.identifiers).toStrictEqual([
        { label: 'Inventory Number', value: 'A19610048000' },
        { label: 'Identifier', value: 'A1961' },
      ]);
      expect(makeService().toFullObject({})).toMatchObject({
        dates: [],
        place: [],
        identifiers: [],
      });
    });

    it('takes credit_line from the first creditLine entry with content, absent when none', () => {
      const full = makeService().toFullObject({
        content: {
          freetext: {
            creditLine: [
              { label: 'Credit Line', content: '' },
              { label: 'Credit Line', content: 'Deposited by the Estate of Orville Wright' },
              { label: 'Credit Line', content: 'Second line' },
            ],
          },
        },
      });
      expect(full.credit_line).toBe('Deposited by the Estate of Orville Wright');
      expect(makeService().toFullObject({})).not.toHaveProperty('credit_line');
    });

    it('keeps the one rights statement of nasm_A19610048000 as object_rights "CC0" (issue #82)', () => {
      const full = makeService().toFullObject({
        content: {
          freetext: { objectRights: [{ label: 'Restrictions & Rights', content: 'CC0' }] },
        },
      });
      expect(full.object_rights).toBe('CC0');
    });

    /** A record whose only free-text block is `freetext.physicalDescription`. */
    const physical = (physicalDescription: Array<{ label?: string; content?: string }>) =>
      makeService().toFullObject({ content: { freetext: { physicalDescription } } });

    it('labels each specimen entry of nmnhvz_7453723 as the catalog does, repeats kept (issue #79)', () => {
      // As /content returns it (2026-11-26): measurements, preparations, and sex, none of them
      // a material.
      const full = physical([
        { label: 'Length - Total', content: '335 mm' },
        { label: 'Length - Tail', content: '143 mm' },
        { label: 'Length - Tail', content: '36 mm' },
        { label: 'Preparation', content: 'Skin' },
        { label: 'Preparation', content: 'Skull' },
        { label: 'Sex', content: 'Male' },
      ]);
      expect(full.physical_description).toStrictEqual([
        { label: 'Length - Total', value: '335 mm' },
        { label: 'Length - Tail', value: '143 mm' },
        { label: 'Length - Tail', value: '36 mm' },
        { label: 'Preparation', value: 'Skin' },
        { label: 'Preparation', value: 'Skull' },
        { label: 'Sex', value: 'Male' },
      ]);
      expect(full).not.toHaveProperty('materials');
      expect(full).not.toHaveProperty('dimensions');
    });

    it('keeps the three Materials and then five Dimensions entries of nasm_A19610048000 in order', () => {
      const full = physical([
        { label: 'Materials', content: 'Airframe: Wood' },
        { label: 'Materials', content: 'Fabric Covering: Muslin' },
        { label: 'Materials', content: 'Engine Crankcase: Aluminum' },
        { label: 'Dimensions', content: 'Wingspan: 12.3 m (40 ft 4 in)' },
        { label: 'Dimensions', content: 'Length: 6.4 m (21 ft 1 in)' },
        { label: 'Dimensions', content: 'Height: 2.8 m (9 ft 4 in)' },
        { label: 'Dimensions', content: 'Weight: Empty, 274 kg (605 lb)' },
        { label: 'Dimensions', content: 'Gross, 341 kg (750 lb)' },
      ]);
      expect(full.physical_description).toStrictEqual([
        { label: 'Materials', value: 'Airframe: Wood' },
        { label: 'Materials', value: 'Fabric Covering: Muslin' },
        { label: 'Materials', value: 'Engine Crankcase: Aluminum' },
        { label: 'Dimensions', value: 'Wingspan: 12.3 m (40 ft 4 in)' },
        { label: 'Dimensions', value: 'Length: 6.4 m (21 ft 1 in)' },
        { label: 'Dimensions', value: 'Height: 2.8 m (9 ft 4 in)' },
        { label: 'Dimensions', value: 'Weight: Empty, 274 kg (605 lb)' },
        { label: 'Dimensions', value: 'Gross, 341 kg (750 lb)' },
      ]);
    });

    it('lists a measurement once, under its own label, never beside a material copy (issues #9, #79)', () => {
      // nasm_A19740798000: a "Materials" entry alongside a "Dimensions" entry.
      const full = physical([
        {
          label: 'Materials',
          content: 'Command Module: Aluminum alloy, stainless steel, and titanium structures.',
        },
        {
          label: 'Dimensions',
          content: 'Overall: 12 ft. 10 in. wide x 34 ft. 2 in. deep (391.16 x 1041.4cm)',
        },
      ]);
      expect(full.physical_description).toStrictEqual([
        {
          label: 'Materials',
          value: 'Command Module: Aluminum alloy, stainless steel, and titanium structures.',
        },
        {
          label: 'Dimensions',
          value: 'Overall: 12 ft. 10 in. wide x 34 ft. 2 in. deep (391.16 x 1041.4cm)',
        },
      ]);
    });

    it.each([
      [
        'siris_arc_291804',
        [{ label: 'Physical description', content: '4.38 x 2.59' }],
        [{ label: 'Physical description', value: '4.38 x 2.59' }],
      ],
      [
        'fbr_item_MODSI1181',
        [
          { label: 'Collection name', content: 'Waldo L. Schmitt Papers, 1907-1978' },
          { label: 'Physical Description', content: '1 field book' },
          { label: 'Physical Location', content: 'Smithsonian Institution Archives' },
          { label: 'Sublocation', content: 'Box 79 Folder 10' },
        ],
        [
          { label: 'Collection name', value: 'Waldo L. Schmitt Papers, 1907-1978' },
          { label: 'Physical Description', value: '1 field book' },
          { label: 'Physical Location', value: 'Smithsonian Institution Archives' },
          { label: 'Sublocation', value: 'Box 79 Folder 10' },
        ],
      ],
    ])('keeps the generic and storage labels of %s as written', (_, entries, expected) => {
      expect(physical(entries).physical_description).toStrictEqual(expected);
    });

    it('drops an entry without content and labels one without a label "Physical description"', () => {
      expect(
        physical([
          { label: 'Medium', content: '' },
          { label: 'Dimensions' },
          { content: '30 cm tall' },
          { label: 'Medium', content: 'Carved oak' },
        ]).physical_description,
      ).toStrictEqual([
        { label: 'Physical description', value: '30 cm tall' },
        { label: 'Medium', value: 'Carved oak' },
      ]);
    });

    it('returns physical_description [] for a record without the block', () => {
      expect(makeService().toFullObject({}).physical_description).toStrictEqual([]);
      expect(physical([]).physical_description).toStrictEqual([]);
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
      const result = await svc.listTerms(
        { field: 'unit_code', start: 2, rows: 3 },
        ctx,
        startCallDeadline(),
      );
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
      await svc.listTerms({ field: 'unit_code', start: 5, rows: 10 }, ctx, startCallDeadline());
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
      const result = await svc.listTerms(
        { field: 'unit_code', start: 50, rows: 10 },
        ctx,
        startCallDeadline(),
      );
      expect(result.total).toBe(2);
      expect(result.terms).toEqual([]);
    });

    it('fails a 200 without a terms array as an upstream fault, not an empty vocabulary (issue #72)', async () => {
      // EDAN answers an unknown field with HTTP 400, so a 200 carrying only a message is
      // malformed — read as zero terms it would claim the field has no vocabulary.
      mockFetch({ status: 200, responseCode: 1, response: { message: 'no terms' } });
      const svc = makeService();
      const ctx = makeTenantContext();
      const err = await outcomeOf(() =>
        svc.listTerms({ field: 'unit_code', start: 0, rows: 50 }, ctx, startCallDeadline()),
      );
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unavailable' },
      });
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
        startCallDeadline(),
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
        startCallDeadline(),
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
        startCallDeadline(),
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
      const result = await svc.listTerms(
        { field: 'unit_code', start: 0, rows: 50 },
        ctx,
        startCallDeadline(),
      );
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
        startCallDeadline(),
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
        startCallDeadline(),
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
        startCallDeadline(),
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
        startCallDeadline(),
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
        startCallDeadline(),
      );
      expect(byName.terms).toEqual(['CHNDM', 'CHSDM']);
      // A code substring that appears in no name still matches the code itself.
      const byCode = await svc.listTerms(
        { field: 'unit_code', start: 0, rows: 50, contains: 'NASM' },
        ctx,
        startCallDeadline(),
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
        startCallDeadline(),
      );
      expect(result.labels).toBeUndefined();
      expect(result.terms).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  describe('museum-name lookup (issue #80)', () => {
    /** The live 48-code `unit_code` vocabulary, in its upstream order. */
    const UNIT_CODES =
      'AAA AAG ACAH ACM ACMA CFCHFOLKLIFE CHNDM CHSDM EEPA FBR FSA HAC HMSG HSFA NAA NASM NASMAC NMAA NMAAHC NMAH NMAI NMAIA NMAfA NMNHANTHRO NMNHBIRDS NMNHBOTANY NMNHEDUCATION NMNHENTO NMNHFISHES NMNHHERPS NMNHINV NMNHMAMMALS NMNHMINSCI NMNHPALEO NPG NPM NPMA NZP OCIO_DPO3D OFEO-SG SAAM SAAMPAIK SI SIA SIL SILAF SILNMAHTL SLA_SRO'.split(
        ' ',
      );

    /** The eleven National Museum of Natural History division codes. */
    const NMNH = UNIT_CODES.filter((code) => code.startsWith('NMNH'));

    /** Every name the vocabulary's codes carry, as `labels` and `museum_name` give them. */
    const LABELS = {
      AAA: 'Archives of American Art',
      AAG: 'Archives of American Gardens',
      ACAH: 'Archives Center, National Museum of American History',
      ACM: 'Anacostia Community Museum',
      ACMA: 'Anacostia Community Museum Archives',
      CFCHFOLKLIFE: 'Ralph Rinzler Folklife Archives and Collections',
      CHNDM: 'Cooper Hewitt, Smithsonian Design Museum',
      CHSDM: 'Cooper Hewitt, Smithsonian Design Museum',
      EEPA: 'Eliot Elisofon Photographic Archives',
      FBR: 'Smithsonian Field Book Project',
      HAC: 'Smithsonian Gardens',
      HMSG: 'Hirshhorn Museum and Sculpture Garden',
      HSFA: 'Human Studies Film Archives',
      NAA: 'National Anthropological Archives',
      NASM: 'National Air and Space Museum',
      NMAA: 'National Museum of Asian Art',
      NMAAHC: 'National Museum of African American History and Culture',
      NMAH: 'National Museum of American History',
      NMAI: 'National Museum of the American Indian',
      NMAfA: 'National Museum of African Art',
      NMNHANTHRO: 'NMNH - Anthropology Dept.',
      NMNHBIRDS: 'NMNH - Vertebrate Zoology - Birds Division',
      NMNHBOTANY: 'NMNH - Botany Dept.',
      NMNHEDUCATION: 'NMNH - Education & Outreach',
      NMNHENTO: 'NMNH - Entomology Dept.',
      NMNHFISHES: 'NMNH - Vertebrate Zoology - Fishes Division',
      NMNHHERPS: 'NMNH - Vertebrate Zoology - Herpetology Division',
      NMNHINV: 'NMNH - Invertebrate Zoology Dept.',
      NMNHMAMMALS: 'NMNH - Vertebrate Zoology - Mammals Division',
      NMNHMINSCI: 'NMNH - Mineral Sciences Dept.',
      NMNHPALEO: 'NMNH - Paleobiology Dept.',
      NPG: 'National Portrait Gallery',
      NPM: 'National Postal Museum',
      NPMA: 'National Postal Museum Archives',
      NZP: "Smithsonian's National Zoo & Conservation Biology Institute",
      OCIO_DPO3D:
        'Office of the Chief Information Officer - Digitization Program Office (3D digitization)',
      'OFEO-SG': 'Smithsonian Gardens',
      SAAM: 'Smithsonian American Art Museum',
      SI: 'Smithsonian Institution',
      SIA: 'Smithsonian Institution Archives',
      SIL: 'Smithsonian Libraries',
      SILAF: 'Smithsonian Libraries',
      SILNMAHTL: 'Smithsonian Libraries',
      SLA_SRO: 'Smithsonian Libraries and Archives',
    };

    /** The vocabulary's codes, in order, whose label contains `text` in any case. */
    const labelledWith = (text: string) =>
      UNIT_CODES.filter(
        (code) =>
          Object.hasOwn(LABELS, code) &&
          LABELS[code as keyof typeof LABELS].toLowerCase().includes(text),
      );

    /** A service whose warm `unit_code` vocabulary is the live one. */
    async function warmService(): Promise<SmithsonianService> {
      mockFetch({ status: 200, responseCode: 1, response: { terms: UNIT_CODES } });
      const svc = makeService();
      await lookup(svc, undefined);
      return svc;
    }

    function lookup(svc: SmithsonianService, contains: string | undefined, field = 'unit_code') {
      return svc.listTerms(
        { field, start: 0, rows: 100, ...(contains !== undefined && { contains }) },
        makeTenantContext(),
        startCallDeadline(),
      );
    }

    it.each([
      ['Natural History', NMNH],
      ['National Museum of Natural History', NMNH],
      ['Smithsonian National Museum of Natural History', NMNH],
      ['  natural HISTORY ', NMNH],
      ['Freer', ['NMAA']],
      ['Sackler', ['NMAA']],
      ['Freer Gallery of Art', ['NMAA']],
      ['Arthur M. Sackler Gallery', ['NMAA']],
      ['National Design Museum', ['CHNDM', 'CHSDM']],
      ['Cooper-Hewitt', ['CHNDM', 'CHSDM']],
      ['Smithsonian National Air and Space Museum', ['NASM']],
      ['Air & Space', ['NASM']],
      ['Smithsonian National Museum of American History', ['ACAH', 'NMAH']],
      ["Smithsonian's National Museum of the American Indian", ['NMAI']],
      ['Smithsonian National Portrait Gallery', ['NPG']],
      ['Smithsonian National Postal Museum', ['NPM', 'NPMA']],
      ["Smithsonian's Hirshhorn Museum and Sculpture Garden", ['HMSG']],
      ['Smithsonian National Museum of African American History and Culture', ['NMAAHC']],
      ['Smithsonian National Museum of Asian Art', ['NMAA']],
      ['Smithsonian Anacostia Community Museum', ['ACM', 'ACMA']],
      ['National Zoo and Conservation Biology Institute', ['NZP']],
      ['Smithsonian’s National Zoo', ['NZP']],
      ['Smithsonian‘s National Zoo', ['NZP']],
      ['Cooper Hewitt, National Design Museum', ['CHNDM', 'CHSDM']],
      ['Cooper-Hewitt, Smithsonian Design Museum', ['CHNDM', 'CHSDM']],
      ['Education and Outreach', ['NMNHEDUCATION']],
    ])('resolves %j to exactly its codes', async (contains, codes) => {
      const result = await lookup(await warmService(), contains);

      expect(result.terms).toEqual(codes);
      expect(result.total).toBe(codes.length);
      expect(result.labels).toStrictEqual(
        Object.fromEntries(codes.map((code) => [code, LABELS[code as keyof typeof LABELS]])),
      );
    });

    it.each([
      ['Air and Space', ['NASM']],
      ['NMNH', NMNH],
      ['OFEO-SG', ['OFEO-SG']],
      ['nasm', ['NASM', 'NASMAC']],
      [
        'Smithsonian',
        [
          'CHNDM',
          'CHSDM',
          'FBR',
          'HAC',
          'NZP',
          'OFEO-SG',
          'SAAM',
          'SI',
          'SIA',
          'SIL',
          'SILAF',
          'SILNMAHTL',
          'SLA_SRO',
        ],
      ],
      // A leading "Smithsonian" with no word after it is the whole needle, not a prefix to drop.
      ['Smithsonian ', labelledWith('smithsonian')],
      ['Smithsonian’s', labelledWith("smithsonian's")],
      ['Latino', []],
      ['  ', []],
      // Text that folds to nothing still matches the label as written, as before.
      [' ', UNIT_CODES.filter((code) => code in LABELS)],
      ['-', [...NMNH, 'OCIO_DPO3D', 'OFEO-SG']],
      ['- ', [...NMNH, 'OCIO_DPO3D']],
    ])('keeps %j to the codes it matched before', async (contains, codes) => {
      const result = await lookup(await warmService(), contains);

      expect(result.terms).toEqual(codes);
      expect(result.total).toBe(codes.length);
    });

    it('leaves labels and museum_name byte-identical for every code', async () => {
      const svc = await warmService();

      expect((await lookup(svc, undefined)).labels).toStrictEqual(LABELS);
      for (const [code, name] of Object.entries(LABELS)) {
        expect(svc.toSummary({ unitCode: code }).museum_name, code).toBe(name);
      }
    });

    it('leaves contains on other fields a plain case-insensitive substring', async () => {
      mockFetch({
        status: 200,
        responseCode: 1,
        response: { terms: ['Greek & Roman', 'Greek and Roman', 'Cooper-Hewitt', 'Smithsonian'] },
      });
      const svc = makeService();

      expect((await lookup(svc, 'greek and roman', 'culture')).terms).toEqual(['Greek and Roman']);
      expect((await lookup(svc, 'Cooper Hewitt', 'culture')).terms).toEqual([]);
      expect((await lookup(svc, 'Smithsonian Cooper-Hewitt', 'culture')).terms).toEqual([]);
    });

    it.each([
      ['one long line', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
      ['breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
      ['an ampersand run', (n: number) => '&'.repeat(n)],
      ['a hyphen and space run', (n: number) => '- '.repeat(n / 2)],
      ['curly apostrophes', (n: number) => '‘’'.repeat(n / 2)],
      ['repeated Smithsonian prefixes', (n: number) => "Smithsonian's ".repeat(n / 20)],
      ['a digit run', (n: number) => '1'.repeat(n)],
    ])(
      'matches caller-sized contains text within CPU bounds: %s',
      async (_shape, make) => {
        const svc = await warmService();
        /** CPU microseconds per lookup of `contains`, the least of three batches. */
        const cpuPerLookup = async (contains: string) => {
          let least = Number.POSITIVE_INFINITY;
          for (let batch = 0; batch < 3; batch++) {
            const start = process.threadCpuUsage();
            let runs = 0;
            let cpu = 0;
            // Accumulate measurable CPU even on clocks that report coarse ticks.
            do {
              expect((await lookup(svc, contains)).total).toBe(0);
              runs++;
              const elapsed = process.threadCpuUsage(start);
              cpu = elapsed.user + elapsed.system;
              expect(cpu).toBeLessThan(1_000_000);
            } while (cpu < 20_000);
            expect(cpu / runs).toBeLessThan(100_000);
            least = Math.min(least, cpu / runs);
          }
          return least;
        };
        const baseline = make(5_000);
        let leastGrowth = Number.POSITIVE_INFINITY;
        // Doubling, each size held to the absolute bound before the next runs; the baseline is
        // timed again beside each size, so a core switch between the two never reads as growth.
        for (let size = 10_000; size <= 320_000; size *= 2) {
          const growth = (await cpuPerLookup(make(size))) / (await cpuPerLookup(baseline));
          if (size === 320_000) leastGrowth = growth;
        }
        for (let pass = 0; pass < 3 && leastGrowth >= 256; pass++) {
          const large = await cpuPerLookup(make(320_000));
          leastGrowth = Math.min(leastGrowth, large / (await cpuPerLookup(baseline)));
        }
        expect(leastGrowth).toBeLessThan(256);
      },
      0,
    );
  });

  describe('describeTerm()', () => {
    const VOCAB = ['AAA', 'AAG', 'NASM', 'NMAfA'];

    it('is an exact membership test — a substring of a term is not a term', async () => {
      // The reason `contains` cannot stand in: it would report a hit for "AA".
      mockFetch({ status: 200, responseCode: 1, response: { terms: VOCAB } });
      const svc = makeService();
      const ctx = makeTenantContext();
      expect((await svc.describeTerm('unit_code', 'AAA', ctx, startCallDeadline())).indexed).toBe(
        true,
      );
      expect((await svc.describeTerm('unit_code', 'AA', ctx, startCallDeadline())).indexed).toBe(
        false,
      );
    });

    it('matches case-sensitively, as EDAN itself resolves a term', async () => {
      // NMAfA carries a lowercase f upstream; NMAFA matches nothing there, and a
      // case-insensitive check would wrongly call it indexed.
      mockFetch({ status: 200, responseCode: 1, response: { terms: VOCAB } });
      const svc = makeService();
      const ctx = makeTenantContext();
      expect((await svc.describeTerm('unit_code', 'NMAfA', ctx, startCallDeadline())).indexed).toBe(
        true,
      );
      expect((await svc.describeTerm('unit_code', 'NMAFA', ctx, startCallDeadline())).indexed).toBe(
        false,
      );
    });

    it('reports no neighbors for a value outside the vocabulary', async () => {
      // An unindexed value takes the resolve-it hint, which passes the value itself
      // as the substring — so there is nothing to prove and nothing to return.
      mockFetch({ status: 200, responseCode: 1, response: { terms: VOCAB } });
      expect(
        await makeService().describeTerm(
          'unit_code',
          'NOTACODE',
          makeTenantContext(),
          startCallDeadline(),
        ),
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
        expect(
          await makeService().describeTerm(
            'culture',
            'Guiana',
            makeTenantContext(),
            startCallDeadline(),
          ),
        ).toEqual({
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
          await makeService().describeTerm(
            'topic',
            'Quilts--History',
            makeTenantContext(),
            startCallDeadline(),
          ),
        ).toEqual({ indexed: true, neighbors: { contains: 'Quilts', count: 1 } });
      });

      it.each([
        ['(', 'Endeavour (OV-105)', ['Endeavour (OV-105)', 'Endeavour', 'Discovery'], 'Endeavour'],
        [',', 'Kano, Nigeria', ['Kano, Nigeria', 'Kano', 'Lagos'], 'Kano'],
      ] as const)(
        'stops where the head shared with a %s qualifier ends',
        async (_sep, value, terms, contains) => {
          mockFetch({ status: 200, responseCode: 1, response: { terms } });
          expect(
            await makeService().describeTerm(
              'topic',
              value,
              makeTenantContext(),
              startCallDeadline(),
            ),
          ).toEqual({
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
        expect(
          await makeService().describeTerm(
            'topic',
            value,
            makeTenantContext(),
            startCallDeadline(),
          ),
        ).toEqual({
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
        expect(
          await makeService().describeTerm(
            'culture',
            'Guiana',
            makeTenantContext(),
            startCallDeadline(),
          ),
        ).toEqual({
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
        expect(
          await makeService().describeTerm(
            'topic',
            value,
            makeTenantContext(),
            startCallDeadline(),
          ),
        ).toEqual({
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
        expect(
          await makeService().describeTerm(
            'topic',
            '"Yank"',
            makeTenantContext(),
            startCallDeadline(),
          ),
        ).toEqual({
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
        expect(
          await makeService().describeTerm(
            'culture',
            value,
            makeTenantContext(),
            startCallDeadline(),
          ),
        ).toEqual({
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
        expect(
          await makeService().describeTerm(
            'place',
            value,
            makeTenantContext(),
            startCallDeadline(),
          ),
        ).toEqual({
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
        expect(
          await makeService().describeTerm(
            'place',
            value,
            makeTenantContext(),
            startCallDeadline(),
          ),
        ).toEqual({
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
        expect(
          await makeService().describeTerm(
            'culture',
            value,
            makeTenantContext(),
            startCallDeadline(),
          ),
        ).toEqual({
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
        expect(
          await makeService().describeTerm('topic', beyondCap, ctx, startCallDeadline()),
        ).toEqual({
          indexed: true,
        });

        mockFetch({
          status: 200,
          responseCode: 1,
          response: { terms: [withinCap, 'Wwtarget alternative'] },
        });
        expect(
          await makeService().describeTerm('topic', withinCap, ctx, startCallDeadline()),
        ).toEqual({
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
        expect(
          await makeService().describeTerm(
            'topic',
            'Zymurgy',
            makeTenantContext(),
            startCallDeadline(),
          ),
        ).toEqual({
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
        expect(
          await makeService().describeTerm(
            'culture',
            'Mzab',
            makeTenantContext(),
            startCallDeadline(),
          ),
        ).toEqual({
          indexed: true,
        });
      });

      it('names a substring sitting exactly on the ceiling', async () => {
        // One term fewer than the case above, and the clause survives — the ceiling
        // is 800 inclusive, and this pins it against a silent loosening.
        mockFetch({ status: 200, responseCode: 1, response: { terms: mzabVocabulary(800) } });
        expect(
          await makeService().describeTerm(
            'culture',
            'Mzab',
            makeTenantContext(),
            startCallDeadline(),
          ),
        ).toEqual({
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
        expect(
          await makeService().describeTerm(
            'place',
            'Mzab',
            makeTenantContext(),
            startCallDeadline(),
          ),
        ).toEqual({
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
        expect(
          await makeService().describeTerm(
            'topic',
            'Quilts',
            makeTenantContext(),
            startCallDeadline(),
          ),
        ).toEqual({
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

      const first = await svc.listTerms(
        { field: 'unit_code', start: 0, rows: 2 },
        ctx,
        startCallDeadline(),
      );
      const second = await svc.listTerms(
        { field: 'unit_code', start: 1, rows: 2 },
        ctx,
        startCallDeadline(),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(first.terms).toEqual(['AAA', 'AAG']);
      expect(second.terms).toEqual(['AAG', 'NASM']);
      expect(second.total).toBe(3);
    });

    it('caches per field — a second field still costs one fetch', async () => {
      const fetchMock = mockTermsFetch(['AAA', 'AAG']);
      const svc = makeService();
      const ctx = makeTenantContext();

      await svc.listTerms({ field: 'unit_code', start: 0, rows: 50 }, ctx, startCallDeadline());
      await svc.listTerms({ field: 'culture', start: 0, rows: 50 }, ctx, startCallDeadline());
      await svc.listTerms({ field: 'unit_code', start: 0, rows: 50 }, ctx, startCallDeadline());

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

      await svc.listTerms({ field: 'unit_code', start: 0, rows: 50 }, ctx, startCallDeadline());
      // 'AAA' resolves through a cut inside the code — 'AAG' shares its first two
      // characters — which is a scan of the cached array, not a second download.
      expect(await svc.describeTerm('unit_code', 'AAA', ctx, startCallDeadline())).toEqual({
        indexed: true,
        neighbors: { contains: 'AA', count: 1 },
      });
      expect(await svc.describeTerm('unit_code', 'NOTACODE', ctx, startCallDeadline())).toEqual({
        indexed: false,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('isolates the cache per tenant', async () => {
      const fetchMock = mockTermsFetch(['AAA', 'AAG']);
      const svc = makeService();

      await svc.listTerms(
        { field: 'unit_code', start: 0, rows: 50 },
        createMockContext({ tenantId: 'tenant-a' }),
        startCallDeadline(),
      );
      await svc.listTerms(
        { field: 'unit_code', start: 0, rows: 50 },
        createMockContext({ tenantId: 'tenant-b' }),
        startCallDeadline(),
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('refetches once the TTL has elapsed', async () => {
      const fetchMock = mockTermsFetch(['AAA', 'AAG']);
      const svc = makeService();
      const ctx = makeTenantContext();

      vi.useFakeTimers();
      try {
        await svc.listTerms({ field: 'unit_code', start: 0, rows: 50 }, ctx, startCallDeadline());
        // Inside the default 3600 s TTL the entry is still served from storage.
        vi.setSystemTime(Date.now() + 3_599_000);
        await svc.listTerms({ field: 'unit_code', start: 0, rows: 50 }, ctx, startCallDeadline());
        expect(fetchMock).toHaveBeenCalledTimes(1);

        vi.setSystemTime(Date.now() + 2_000);
        await svc.listTerms({ field: 'unit_code', start: 0, rows: 50 }, ctx, startCallDeadline());
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

      await svc.listTerms({ field: 'unit_code', start: 0, rows: 50 }, ctx, startCallDeadline());
      await svc.listTerms({ field: 'unit_code', start: 0, rows: 50 }, ctx, startCallDeadline());

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('concurrent cold vocabulary reads (issue #77)', () => {
    const TERMS = ['Aztecs', 'Maya'];
    const PAGE = { terms: TERMS, total: 2 };
    const EXPIRED = { code: JsonRpcErrorCode.Timeout, reason: 'retry_deadline_exceeded' };
    const CANCELLED = {
      code: JsonRpcErrorCode.RequestCancelled,
      message: 'The request was cancelled before the upstream response arrived.',
    };

    /** The 200 `/terms/{field}` answers on success. */
    function termsAnswer(): Upstream {
      return upstream({ status: 200, responseCode: 1, response: { terms: TERMS } });
    }

    /** The `/terms/{field}` requests the stub received. */
    function requestsFor(up: ReturnType<typeof stubUpstream>, field: string): number {
      return up.fetchMock.mock.calls.filter(([input]) =>
        new URL(input).pathname.endsWith(`/terms/${field}`),
      ).length;
    }

    /** A deadline `ms` from now, as a tool handler holds it partway through its call. */
    function deadlineIn(ms: number): CallDeadline {
      return (Date.now() + ms) as CallDeadline;
    }

    /** One read of a field's first page, the read `smithsonian_list_terms` makes. */
    function read(
      svc: SmithsonianService,
      ctx = makeTenantContext(),
      field = 'culture',
      deadline: CallDeadline = startCallDeadline(),
    ) {
      return svc.listTerms({ field, start: 0, rows: 50 }, ctx, deadline);
    }

    /** A context cancelled through `signal`, from a controller the test owns. */
    function cancellable(signal: AbortSignal) {
      return createMockContext({ tenantId: 'test-tenant', signal });
    }

    /**
     * Resolves once every call started this turn has reached the load: a macrotask runs
     * after every pending microtask, and nothing on the way to the load waits on a timer.
     */
    function joined(): Promise<void> {
      return new Promise((resolve) => setImmediate(resolve));
    }

    /** The error code and reason a call rejected with. */
    async function failureOf(pending: Promise<unknown>) {
      const error = (await pending.catch((e: unknown) => e)) as {
        code?: number;
        data?: { reason?: string };
      };
      return { code: error.code, reason: error.data?.reason };
    }

    /** The error code and message a call rejected with. */
    async function cancellationOf(pending: Promise<unknown>) {
      const error = (await pending.catch((e: unknown) => e)) as { code?: number; message?: string };
      return { code: error.code, message: error.message };
    }

    /** A store that passes `get` and `set` through to `store` except where `overrides` replaces one. */
    function storeOver(
      store: StorageService,
      overrides: {
        get?: (...args: Parameters<StorageService['get']>) => unknown;
        set?: (...args: Parameters<StorageService['set']>) => unknown;
      },
    ): StorageService {
      return {
        get: (...args: Parameters<StorageService['get']>) => store.get(...args),
        set: (...args: Parameters<StorageService['set']>) => store.set(...args),
        ...overrides,
      } as unknown as StorageService;
    }

    /**
     * A store over `store` whose writes wait for `release()`: `written` resolves once a write
     * has been issued.
     */
    function heldWrites(store: StorageService) {
      const gate = Promise.withResolvers<void>();
      const written = Promise.withResolvers<void>();
      const held = storeOver(store, {
        set: async (...args) => {
          written.resolve();
          await gate.promise;
          return await store.set(...args);
        },
      });
      return { store: held, written: written.promise, release: () => gate.resolve() };
    }

    /** A service reading the terms TTL as 0 — the config memo is module-level. */
    async function uncachedService(): Promise<SmithsonianService> {
      vi.stubEnv('SMITHSONIAN_TERMS_CACHE_TTL_SECONDS', '0');
      vi.resetModules();
      const { SmithsonianService: FreshService } = await import(
        '@/services/smithsonian/smithsonian-service.js'
      );
      return new FreshService(createInMemoryStorage());
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('sends one /terms request for five concurrent cold reads of a field, stored before any of them resumes', async () => {
      const writes = heldWrites(createInMemoryStorage());
      const held = heldRoute(termsAnswer());
      const up = stubUpstream({ terms: held.route });
      const svc = makeService(writes.store);
      let settled = 0;

      const pending = Array.from({ length: 5 }, () => read(svc).finally(() => settled++));
      await held.arrived(1);
      await joined();
      held.release();
      await writes.written;
      await joined();
      // The response is in, the write is not: no read has resumed.
      expect(settled).toBe(0);
      writes.release();

      for (const page of await Promise.all(pending)) expect(page).toEqual(PAGE);
      expect(requestsFor(up, 'culture')).toBe(1);
      // Warm reads, concurrent or not, send nothing.
      await Promise.all([read(svc), read(svc)]);
      expect(requestsFor(up, 'culture')).toBe(1);
    });

    it('rejects every caller of a load whose store write fails with that error, and the next read sends a new request', async () => {
      const store = createInMemoryStorage();
      const failure = new Error('The store refused the write.');
      let refusing = true;
      const up = stubUpstream({ terms: () => termsAnswer() });
      const svc = makeService(
        storeOver(store, {
          set: async (...args) => {
            if (refusing) throw failure;
            return await store.set(...args);
          },
        }),
      );

      const calls = [
        read(svc),
        svc.describeTerm('culture', 'Maya', makeTenantContext(), startCallDeadline()),
      ].map((call) => call.catch((e: unknown) => e));
      for (const call of calls) expect(await call).toBe(failure);
      expect(requestsFor(up, 'culture')).toBe(1);

      refusing = false;
      expect(await read(svc)).toEqual(PAGE);
      expect(requestsFor(up, 'culture')).toBe(2);
    });

    it('rejects a cold read whose signal has already aborted RequestCancelled, sending no request', async () => {
      const up = stubUpstream({ terms: () => termsAnswer() });
      const svc = makeService();

      expect(await cancellationOf(read(svc, cancellable(AbortSignal.abort())))).toEqual(CANCELLED);
      expect(requestsFor(up, 'culture')).toBe(0);
      expect(await read(svc)).toEqual(PAGE);
      expect(requestsFor(up, 'culture')).toBe(1);
    });

    it('rejects a caller arriving already aborted at once, counted as no waiter on the load in progress', async () => {
      const held = heldRoute(termsAnswer());
      const up = stubUpstream({ terms: held.route });
      const svc = makeService();
      const starting = new AbortController();

      const first = cancellationOf(read(svc, cancellable(starting.signal)));
      await held.arrived(1);
      await joined();
      let lateSettled = false;
      const late = cancellationOf(read(svc, cancellable(AbortSignal.abort()))).finally(() => {
        lateSettled = true;
      });
      await joined();

      expect(lateSettled).toBe(true);
      expect(await late).toEqual(CANCELLED);
      expect(held.signals).toHaveLength(1);
      // The caller that started the load is its only waiter, so its leaving aborts the request.
      starting.abort();
      expect(held.signals[0]?.aborted).toBe(true);
      expect(await first).toEqual(CANCELLED);
      expect(requestsFor(up, 'culture')).toBe(1);
    });

    it('joins a load in progress without reading storage, so a slow store cannot answer with the miss from before its write', async () => {
      const store = createInMemoryStorage();
      // A remote store's latency: each read answers with what it saw when issued, once released.
      const reads: Array<() => void> = [];
      const slow = storeOver(store, {
        get: (...args) => {
          const seen = store.get(...args);
          return new Promise((resolve) => reads.push(() => resolve(seen)));
        },
      });
      const held = heldRoute(termsAnswer());
      const up = stubUpstream({ terms: held.route });
      const svc = makeService(slow);

      const first = read(svc);
      await joined();
      reads[0]?.();
      await held.arrived(1);
      const second = read(svc);
      await joined();
      held.release();
      expect(await first).toEqual(PAGE);
      for (const release of reads.slice(1)) release();

      expect(await second).toEqual(PAGE);
      expect(reads).toHaveLength(1);
      expect(requestsFor(up, 'culture')).toBe(1);
    });

    it('shares the request between cold list_terms calls and a cold recovery lookup on the field', async () => {
      initSmithsonianService({} as AppConfig, createInMemoryStorage());
      const held = heldRoute(termsAnswer());
      const up = stubUpstream({
        terms: held.route,
        search: () => upstream(makeSearchResponse({ rows: [], rowCount: 0 })),
      });

      const listed = Array.from({ length: 3 }, () =>
        runToolContract(
          smithsonianListTerms,
          { field: 'culture' },
          { context: makeTenantContext() },
        ),
      );
      const recovered = runToolContract(
        smithsonianSearchObjects,
        { query: 'aircraft', filters: { culture: 'Atlantis' } },
        { context: makeTenantContext() },
      );
      await held.arrived(1);
      await joined();
      held.release();

      for (const result of await Promise.all(listed)) {
        expect(result.structuredContent).toMatchObject(PAGE);
      }
      expect((await recovered).structuredContent).toMatchObject({
        error: { data: { reason: 'invalid_filter' } },
      });
      expect(requestsFor(up, 'culture')).toBe(1);
    });

    it('rejects a cancelled caller alone with RequestCancelled; the request runs on and its result is stored', async () => {
      const held = heldRoute(termsAnswer());
      const up = stubUpstream({ terms: held.route });
      const svc = makeService();
      const leaving = new AbortController();

      const cancelled = cancellationOf(read(svc, cancellable(leaving.signal)));
      const listed = read(svc);
      const described = svc.describeTerm(
        'culture',
        'Maya',
        makeTenantContext(),
        startCallDeadline(),
      );
      await held.arrived(1);
      await joined();
      leaving.abort();

      expect(await cancelled).toEqual(CANCELLED);
      expect(held.signals[0]?.aborted).toBe(false);
      held.release();
      expect(await listed).toEqual(PAGE);
      expect(await described).toMatchObject({ indexed: true });
      await read(svc);
      expect(requestsFor(up, 'culture')).toBe(1);
    });

    it('rejects a caller whose deadline passes Timeout alone; the request outlives the deadline of the caller that started it', async () => {
      vi.useFakeTimers();
      const held = heldRoute(termsAnswer());
      const up = stubUpstream({ terms: held.route });
      const svc = makeService();

      const early = failureOf(read(svc, makeTenantContext(), 'culture', deadlineIn(5_000)));
      const late = read(svc, makeTenantContext(), 'culture', deadlineIn(50_000));
      await vi.advanceTimersByTimeAsync(5_000);

      expect(await early).toEqual(EXPIRED);
      expect(held.signals).toHaveLength(1);
      expect(held.signals[0]?.aborted).toBe(false);
      held.release();
      expect(await late).toEqual(PAGE);
      await read(svc);
      expect(requestsFor(up, 'culture')).toBe(1);
    });

    it('aborts the request the moment the last caller cancels, and the next read sends a new one', async () => {
      const held = heldRoute(termsAnswer());
      let route: Route = held.route;
      const up = stubUpstream({ terms: (init: RequestInit) => route(init) });
      const svc = makeService();
      const first = new AbortController();
      const second = new AbortController();

      const calls = [first, second].map((c) => cancellationOf(read(svc, cancellable(c.signal))));
      await held.arrived(1);
      await joined();
      first.abort();
      expect(held.signals[0]?.aborted).toBe(false);
      second.abort();
      expect(held.signals[0]?.aborted).toBe(true);
      for (const call of calls) expect(await call).toEqual(CANCELLED);

      route = () => termsAnswer();
      expect(await read(svc)).toEqual(PAGE);
      expect(requestsFor(up, 'culture')).toBe(2);
    });

    it("aborts the request at the last caller's deadline, not the first's", async () => {
      vi.useFakeTimers();
      const held = heldRoute(termsAnswer());
      const up = stubUpstream({ terms: held.route });
      const svc = makeService();

      const first = failureOf(read(svc, makeTenantContext(), 'culture', deadlineIn(5_000)));
      const second = failureOf(read(svc, makeTenantContext(), 'culture', deadlineIn(8_000)));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await first).toEqual(EXPIRED);
      expect(held.signals[0]?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(3_000);

      expect(await second).toEqual(EXPIRED);
      expect(held.signals[0]?.aborted).toBe(true);
      expect(requestsFor(up, 'culture')).toBe(1);
    });

    it.each([
      [
        'HTTP 429',
        () => upstream({ error: { code: 'OVER_RATE_LIMIT', message: 'Try again later.' } }, 429),
        { code: JsonRpcErrorCode.RateLimited },
        4,
      ],
      [
        'a 200 without response.terms',
        () => upstream({ status: 200, responseCode: 1, response: { message: 'no terms' } }),
        { code: JsonRpcErrorCode.ServiceUnavailable, reason: 'upstream_unavailable' },
        4,
      ],
      [
        'a refused key',
        () =>
          new Response(
            JSON.stringify({ error: { code: 'API_KEY_INVALID', message: 'Invalid api_key.' } }),
            {
              status: 403,
              statusText: 'Forbidden',
              headers: { 'Content-Type': 'application/json' },
            },
          ) as unknown as Upstream,
        { code: JsonRpcErrorCode.Forbidden, reason: 'api_key_rejected' },
        1,
      ],
      [
        'HTTP 404, the host not routing',
        () => upstream("404 Not Found: Requested route ('api.si.edu') does not exist.", 404),
        { code: JsonRpcErrorCode.ServiceUnavailable, reason: 'upstream_unavailable' },
        4,
      ],
      [
        'HTTP 500',
        () => upstream('Internal Server Error', 500),
        { code: JsonRpcErrorCode.ServiceUnavailable },
        4,
      ],
      [
        'HTTP 503',
        () => upstream('Service Unavailable', 503),
        { code: JsonRpcErrorCode.ServiceUnavailable },
        4,
      ],
    ] as const)(
      'rejects every caller of a load failing with %s, from one ladder of requests, and stores nothing',
      async (_label, failing, expected, attempts) => {
        let answer: () => Upstream = failing;
        const up = stubUpstream({ terms: () => answer() });
        const svc = makeService();
        vi.useFakeTimers();

        const calls = [
          read(svc),
          svc.describeTerm('culture', 'Maya', makeTenantContext(), startCallDeadline()),
        ].map(failureOf);
        await vi.runAllTimersAsync();
        for (const call of calls) expect(await call).toMatchObject(expected);
        expect(requestsFor(up, 'culture')).toBe(attempts);

        vi.useRealTimers();
        answer = termsAnswer;
        expect(await read(svc)).toEqual(PAGE);
        expect(requestsFor(up, 'culture')).toBe(attempts + 1);
      },
    );

    it('falls a recovery lookup sharing a failed load back to an unchecked membership', async () => {
      initSmithsonianService({} as AppConfig, createInMemoryStorage());
      let rateLimited = true;
      const up = stubUpstream({
        terms: () =>
          rateLimited
            ? upstream({ error: { code: 'OVER_RATE_LIMIT', message: 'Try again later.' } }, 429)
            : termsAnswer(),
        search: () => upstream(makeSearchResponse({ rows: [], rowCount: 0 })),
      });
      vi.useFakeTimers();

      const listed = runToolContract(
        smithsonianListTerms,
        { field: 'culture' },
        { context: makeTenantContext() },
      );
      const recovered = runToolContract(
        smithsonianSearchObjects,
        { query: 'aircraft', filters: { culture: 'Atlantis' } },
        { context: makeTenantContext() },
      );
      await vi.runAllTimersAsync();

      expect((await listed).structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.RateLimited },
      });
      expect((await recovered).structuredContent).toMatchObject({
        error: { data: { reason: 'invalid_filter' } },
      });
      expect(requestsFor(up, 'culture')).toBe(4);

      vi.useRealTimers();
      rateLimited = false;
      const retried = await runToolContract(
        smithsonianListTerms,
        { field: 'culture' },
        { context: makeTenantContext() },
      );
      expect(retried.structuredContent).toMatchObject(PAGE);
      expect(requestsFor(up, 'culture')).toBe(5);
    });

    it('never shares a request across fields or tenants, and each load fills its own tenant', async () => {
      const held = heldRoute(termsAnswer());
      const up = stubUpstream({ terms: held.route });
      const svc = makeService();
      const calls = () => [
        read(svc, createMockContext({ tenantId: 'tenant-a' })),
        read(svc, createMockContext({ tenantId: 'tenant-b' })),
        read(svc, createMockContext({ tenantId: 'tenant-a' }), 'place'),
      ];

      const pending = calls();
      await held.arrived(3);
      held.release();
      await Promise.all(pending);
      expect(requestsFor(up, 'culture')).toBe(2);
      expect(requestsFor(up, 'place')).toBe(1);

      await Promise.all(calls());
      expect(up.fetchMock).toHaveBeenCalledTimes(3);
    });

    it("at a TTL of 0 sends each read on its caller's own signal, sharing and storing nothing", async () => {
      const svc = await uncachedService();
      const held = heldRoute(termsAnswer());
      const up = stubUpstream({ terms: held.route });
      const leaving = new AbortController();

      const cancelled = failureOf(read(svc, cancellable(leaving.signal)));
      const staying = read(svc);
      await held.arrived(2);
      leaving.abort();

      expect(held.signals[0]?.aborted).toBe(true);
      expect(held.signals[1]?.aborted).toBe(false);
      expect(await cancelled).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      held.release();
      expect(await staying).toEqual(PAGE);
      await read(svc);
      expect(requestsFor(up, 'culture')).toBe(3);
    });

    it("at a TTL of 0, a body read cut by the caller's deadline throws Timeout, not a bare DOMException", async () => {
      const svc = await uncachedService();
      // The headers arrive at once; the body sends its first bytes and stalls until the
      // request signal aborts, as a real body does.
      stubUpstream({
        terms: (init: RequestInit) => {
          const signal = init.signal as AbortSignal;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"response":{"terms":["Azt'));
                signal.addEventListener('abort', () => controller.error(signal.reason), {
                  once: true,
                });
              },
            }),
            { status: 200 },
          ) as unknown as Upstream;
        },
      });
      vi.useFakeTimers();
      let settled = false;

      const outcome = read(svc, makeTenantContext(), 'culture', deadlineIn(5_000))
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(settled).toBe(true);
      expect(((await outcome) as Error).name).not.toBe('TimeoutError');
      expect(await failureOf(Promise.reject(await outcome))).toEqual(EXPIRED);
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
      const result = await svc.search(
        { query: 'sun', rows: 10, start: 0 },
        makeTenantContext(),
        startCallDeadline(),
      );

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
        svc.search({ query: 'aircraft', rows: 10, start: 0 }, ctx, startCallDeadline()),
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
        svc.search({ query: 'aircraft', rows: 10, start: 0 }, ctx, startCallDeadline()),
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
        svc.listTerms({ field: 'culture', start: 0, rows: 50 }, ctx, startCallDeadline()),
      )) as { code: number; data?: Record<string, unknown> };

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data?.reason).toBe('upstream_unavailable');
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('describeTerm() rides the same vocabulary path, so it reclassifies too', async () => {
      mockRouterFetch();
      const svc = makeService();
      const ctx = makeTenantContext();
      const err = (await runWithFakeTimers(() =>
        svc.describeTerm('culture', 'Aztecs', ctx, startCallDeadline()),
      )) as {
        code: number;
      };

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    });

    it('leaves the content endpoint alone — a per-ID 404 stays NotFound and is not retried', async () => {
      const fetchMock = mockRouterFetch();
      const svc = makeService();
      const ctx = makeTenantContext();
      const err = await svc.getContent('nasm_MISSING', ctx, startCallDeadline()).catch((e) => e);

      // /content/{id} addresses one record, so its 404 is a genuine miss the
      // caller can act on. NotFound is non-transient — a single attempt.
      expect(err.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err.data?.reason).toBe('not_found');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('HTTP 403 from the api.data.gov edge', () => {
    /** The error envelope a tool call returns, as a structuredContent client reads it. */
    type ErrorEnvelope = { code: number; message: string; data: Record<string, unknown> };

    /** Stub every request with one HTTP 403 response, fresh per call. */
    function mock403(body: string, contentType: string) {
      const fetchMock = vi.fn().mockImplementation(
        async () =>
          new Response(body, {
            status: 403,
            statusText: 'Forbidden',
            headers: { 'Content-Type': contentType },
          }),
      );
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    /**
     * The edge's answer to a request whose key it refuses, in the shape it sends live: HTTP 403
     * with a JSON body naming an `API_KEY_*` code. The captured body stays on the server, so
     * that code reaches the caller only through what the service makes of it.
     */
    function mockKeyRejection(code: string) {
      return mock403(
        JSON.stringify({
          error: { code, message: 'An invalid api_key was supplied. Get one at https://example' },
        }),
        'application/json',
      );
    }

    async function getObjectError(): Promise<{ envelope: ErrorEnvelope; text: string }> {
      initSmithsonianService({} as AppConfig, createInMemoryStorage());
      const result = await runToolContract(smithsonianGetObject, { id: 'nasm_TEST001' });
      expect(result.isError).toBe(true);
      return {
        envelope: (result.structuredContent as { error: ErrorEnvelope }).error,
        text: result.content.map((block) => ('text' in block ? block.text : '')).join('\n'),
      };
    }

    it('surfaces a 403 whose body names no key code as the status-mapped Forbidden, the body kept off the wire', async () => {
      const fetchMock = mock403('<html><body>Request blocked by proxy</body></html>', 'text/html');

      const { envelope, text } = await getObjectError();

      expect(envelope.code).toBe(JsonRpcErrorCode.Forbidden);
      expect(envelope.data.status).toBe(403);
      expect(envelope.data.reason).toBeUndefined();
      expect(envelope.data).not.toHaveProperty('body');
      expect(envelope.data).not.toHaveProperty('responseBody');
      expect(`${envelope.message}\n${text}`).not.toContain('Request blocked');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each(['API_KEY_INVALID', 'API_KEY_MISSING'])(
      'names a %s rejection and the variable to fix, the body still kept off the wire',
      async (code) => {
        const fetchMock = mockKeyRejection(code);

        const { envelope, text } = await getObjectError();

        expect(envelope.code).toBe(JsonRpcErrorCode.Forbidden);
        expect(envelope.message).toContain(code);
        expect(envelope.data).toMatchObject({
          status: 403,
          reason: 'api_key_rejected',
          errorCode: code,
          recovery: { hint: expect.stringContaining('SMITHSONIAN_API_KEY') },
        });
        expect(envelope.data).not.toHaveProperty('body');
        expect(envelope.data).not.toHaveProperty('responseBody');
        expect(text).toContain('SMITHSONIAN_API_KEY');
        expect(`${envelope.message}\n${text}`).not.toContain('example');
        // A rejected key fails every attempt alike, so the call is not retried.
        expect(fetchMock).toHaveBeenCalledTimes(1);
      },
    );

    it('names a key rejection on a collection endpoint too (search)', async () => {
      mockKeyRejection('API_KEY_INVALID');
      const err = await makeService()
        .search({ query: 'aircraft', rows: 10, start: 0 }, makeTenantContext(), startCallDeadline())
        .catch((e: unknown) => e);

      expect(err).toMatchObject({
        code: JsonRpcErrorCode.Forbidden,
        data: { reason: 'api_key_rejected', errorCode: 'API_KEY_INVALID' },
      });
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
type Endpoint = 'search' | 'content' | 'terms';
type Route = (init: RequestInit) => Upstream | Promise<Upstream>;

/**
 * The endpoint a request addresses, read from its path: `…/search`, `…/content/{id}`, or
 * `…/terms/{field}`.
 */
function endpointOf(input: string): Endpoint | undefined {
  const segments = new URL(input).pathname.split('/');
  if (segments.at(-1) === 'search') return 'search';
  if (segments.at(-2) === 'content') return 'content';
  if (segments.at(-2) === 'terms') return 'terms';
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
    return endpoint === 'search'
      ? svc.search(SEARCH, ctx, startCallDeadline())
      : svc.getContent(RECORD, ctx, startCallDeadline());
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

    const first = await svc.search(SEARCH, makeTenantContext(), startCallDeadline());
    const second = await svc.search(SEARCH, makeTenantContext(), startCallDeadline());

    expect(up.count('search')).toBe(1);
    expect(second).toEqual(first);
    expect(second.rows[0]?.record_id).toBe('nasm_TEST001');
    expect(second.rowCount).toBe(42);
  });

  it('serves one record from one request, with or without the edanmdm: prefix', async () => {
    const up = stubUpstream({ content: () => success('content') });
    const svc = makeService();

    const bare = await svc.getContent(RECORD, makeTenantContext(), startCallDeadline());
    const prefixed = await svc.getContent(
      `edanmdm:${RECORD}`,
      makeTenantContext(),
      startCallDeadline(),
    );

    expect(up.count('content')).toBe(1);
    expect(prefixed).toEqual(bare);
    expect(prefixed.record.title).toBe('Test Object');
  });

  it('keys on the whole request URL: another page of the same query fetches', async () => {
    const up = stubUpstream({ search: () => success('search') });
    const svc = makeService();

    await svc.search(SEARCH, makeTenantContext(), startCallDeadline());
    await svc.search({ ...SEARCH, start: 10 }, makeTenantContext(), startCallDeadline());

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
      JsonRpcErrorCode.ServiceUnavailable,
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

  it('fails a 200 without a search response body unstored — the next call fetches (issue #72)', async () => {
    let body: unknown = { status: 200, responseCode: 1 };
    const up = stubUpstream({ search: () => upstream(body) });
    const svc = makeService();

    expect(
      await codeOf(outcomeOf(() => svc.search(SEARCH, makeTenantContext(), startCallDeadline()))),
    ).toBe(JsonRpcErrorCode.ServiceUnavailable);
    const failedRequests = up.count('search');
    body = makeSearchResponse();
    await svc.search(SEARCH, makeTenantContext(), startCallDeadline());
    const third = await svc.search(SEARCH, makeTenantContext(), startCallDeadline());

    expect(up.count('search')).toBe(failedRequests + 1);
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
// A 200 without the expected payload (issue #72)
// ---------------------------------------------------------------------------

describe('a 200 without the expected payload (issue #72)', () => {
  type Read = 'search' | 'content' | 'terms';
  const SEARCH = { query: 'aircraft', rows: 10, start: 0 };
  const RECORD = 'nasm_TEST001';

  /** The read a request addresses: `…/search`, `…/content/{id}`, or `…/terms/{field}`. */
  function readOf(input: string): Read | undefined {
    const segments = new URL(input).pathname.split('/');
    if (segments.at(-1) === 'search') return 'search';
    if (segments.at(-2) === 'content') return 'content';
    if (segments.at(-2) === 'terms') return 'terms';
    return undefined;
  }

  /**
   * Answer each read with a fresh 200 carrying `bodies[read]()`, or with that answer as it is
   * when the function returns a whole `upstream(…)` response. A request to any other path rejects.
   */
  function stubReads(bodies: Partial<Record<Read, () => unknown>>) {
    const fetchMock = vi.fn(async (input: string) => {
      const read = readOf(input);
      const body = read ? bodies[read] : undefined;
      if (!body) throw new Error('unmocked fetch');
      const answer = body();
      return typeof (answer as { json?: unknown } | null)?.json === 'function'
        ? (answer as Upstream)
        : upstream(answer);
    });
    vi.stubGlobal('fetch', fetchMock);
    return {
      count: (read: Read) =>
        fetchMock.mock.calls.filter(([input]) => readOf(input) === read).length,
    };
  }

  /** One call through `read`, on the same request URL every time. */
  function callOn(svc: SmithsonianService, read: Read, ctx = makeTenantContext()) {
    switch (read) {
      case 'search':
        return svc.search(SEARCH, ctx, startCallDeadline());
      case 'content':
        return svc.getContent(RECORD, ctx, startCallDeadline());
      case 'terms':
        return svc.listTerms({ field: 'culture', start: 0, rows: 50 }, ctx, startCallDeadline());
    }
  }

  /** The 200 each read answers on success. */
  const VALID: Record<Read, unknown> = {
    search: makeSearchResponse(),
    content: makeContentResponse(RECORD),
    terms: { status: 200, responseCode: 1, response: { terms: ['Aztecs', 'Maya'] } },
  };

  beforeEach(() => {
    vi.stubEnv('SMITHSONIAN_API_KEY', 'test-key-12345');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['search', 'no response', { status: 200, responseCode: 1 }],
    ['search', 'an empty response', { status: 200, responseCode: 1, response: {} }],
    ['search', 'rows without a rowCount', { status: 200, response: { rows: [] } }],
    ['search', 'a rowCount without rows', { status: 200, response: { rowCount: 0 } }],
    ['search', 'a string rowCount', { status: 200, response: { rows: [], rowCount: '0' } }],
    ['content', 'no response', { status: 200, responseCode: 1 }],
    ['content', 'a null record', { status: 200, responseCode: 1, response: null }],
    ['content', 'an empty record', { status: 200, responseCode: 1, response: {} }],
    ['content', 'a record without a string url', { status: 200, response: { id: 'x', url: 7 } }],
    ['terms', 'an empty response', { status: 200, responseCode: 1, response: {} }],
    ['terms', 'terms that are not an array', { status: 200, response: { terms: 'Aztecs' } }],
  ] as const)(
    '%s: %s fails ServiceUnavailable after four attempts, stores nothing, and the next call fetches',
    async (read, _label, malformed) => {
      let body: unknown = malformed;
      const up = stubReads({ [read]: () => body });
      const svc = makeService();

      expect(await outcomeOf(() => callOn(svc, read))).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unavailable', retryAttempts: 4 },
      });
      expect(up.count(read)).toBe(4);

      body = VALID[read];
      await callOn(svc, read);
      await callOn(svc, read);
      expect(up.count(read)).toBe(5);
    },
  );

  it.each(['search', 'content', 'terms'] as const)(
    '%s: a one-off malformed reply is retried within the call, and the answer it gets is stored',
    async (read) => {
      let replies = 0;
      const up = stubReads({
        [read]: () =>
          replies++ === 0 ? { status: 200, responseCode: 1, response: {} } : VALID[read],
      });
      const svc = makeService();

      const answer = await outcomeOf(() => callOn(svc, read));
      expect(answer).toMatchObject(
        read === 'search'
          ? { rowCount: 42 }
          : read === 'content'
            ? { record: { title: 'Test Object' } }
            : { terms: ['Aztecs', 'Maya'], total: 2 },
      );
      expect(up.count(read)).toBe(2);

      await callOn(svc, read);
      expect(up.count(read)).toBe(2);
    },
  );

  it('terms: an empty array is a real vocabulary, stored like any other', async () => {
    const up = stubReads({
      terms: () => ({ status: 200, responseCode: 1, response: { terms: [] } }),
    });
    const svc = makeService();

    expect(await callOn(svc, 'terms')).toEqual({ terms: [], total: 0 });
    await callOn(svc, 'terms');
    expect(up.count('terms')).toBe(1);
  });

  it('search: a real zero-match page is an answer, stored like any other', async () => {
    const up = stubReads({
      search: () => ({ status: 200, responseCode: 1, response: { rows: [], rowCount: 0 } }),
    });
    const svc = makeService();

    expect(await callOn(svc, 'search')).toEqual({ rows: [], rowCount: 0 });
    await callOn(svc, 'search');
    expect(up.count('search')).toBe(1);
  });

  it('terms with SMITHSONIAN_TERMS_CACHE_TTL_SECONDS=0: a malformed reply fails the same way', async () => {
    vi.stubEnv('SMITHSONIAN_TERMS_CACHE_TTL_SECONDS', '0');
    vi.resetModules();
    const { SmithsonianService: FreshService } = await import(
      '@/services/smithsonian/smithsonian-service.js'
    );
    const up = stubReads({ terms: () => ({ status: 200, responseCode: 1, response: {} }) });
    const svc = new FreshService(createInMemoryStorage());

    expect(
      await outcomeOf(() =>
        svc.listTerms(
          { field: 'culture', start: 0, rows: 50 },
          makeTenantContext(),
          startCallDeadline(),
        ),
      ),
    ).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable' },
    });
    expect(up.count('terms')).toBe(4);
  });

  it.each(['search', 'content', 'terms'] as const)(
    '%s: an error-in-200 body keeps its own classification ahead of the payload check',
    async (read) => {
      // The key body carries no response at all, so a check run first would relabel it a
      // retryable outage; it stays the non-retryable configuration failure.
      const up = stubReads({
        [read]: () => ({ error: { code: 'API_KEY_MISSING', message: 'No api_key was supplied.' } }),
      });

      expect(await outcomeOf(() => callOn(makeService(), read))).toMatchObject({
        code: JsonRpcErrorCode.InternalError,
        data: { errorCode: 'API_KEY_MISSING' },
      });
      expect(up.count(read)).toBe(1);
    },
  );

  describe('through the tools', () => {
    beforeEach(() => {
      initSmithsonianService({} as AppConfig, createInMemoryStorage());
    });

    it.each([
      [
        'search_objects',
        'search',
        () => runToolContract(smithsonianSearchObjects, { query: 'aircraft' }),
      ],
      ['get_object', 'content', () => runToolContract(smithsonianGetObject, { id: RECORD })],
    ] as const)(
      '%s fails ServiceUnavailable on a malformed 200, and the next call fetches again',
      async (_tool, read, call) => {
        let body: unknown = { status: 200, responseCode: 1, response: {} };
        const up = stubReads({ [read]: () => body });

        const failed = (await outcomeOf(call)) as Awaited<ReturnType<typeof call>>;
        expect(failed.isError).toBe(true);
        expect(failed.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ServiceUnavailable,
            data: { reason: 'upstream_unavailable' },
          },
        });

        body = VALID[read];
        const recovered = await call();
        expect(recovered.isError).not.toBe(true);
        expect(up.count(read)).toBe(5);
      },
    );

    it('search_objects still fails no_results on a real zero-match page', async () => {
      stubReads({
        search: () => ({ status: 200, responseCode: 1, response: { rows: [], rowCount: 0 } }),
      });

      const result = await runToolContract(smithsonianSearchObjects, { query: 'zzqqxx' });
      expect(result.structuredContent).toMatchObject({ error: { data: { reason: 'no_results' } } });
    });

    it.each([
      ['malformed', () => ({ status: 200, responseCode: 1, response: {} })],
      ['HTTP 503', () => upstream({ status: 503 }, 503)],
    ])(
      'search_objects keeps its resolve-it clause when the vocabulary read fails (%s)',
      async (_label, terms) => {
        stubReads({
          search: () => ({ status: 200, responseCode: 1, response: { rows: [], rowCount: 0 } }),
          terms,
        });

        const result = (await outcomeOf(() =>
          runToolContract(smithsonianSearchObjects, {
            query: 'basket',
            filters: { culture: 'Aztecs' },
          }),
        )) as Awaited<ReturnType<typeof runToolContract>>;
        expect(result.structuredContent).toMatchObject({
          error: {
            data: {
              reason: 'invalid_filter',
              recovery: {
                hint: expect.stringContaining(
                  'culture filter "Aztecs" matched nothing — resolve it to an exact term with smithsonian_list_terms { field: "culture", contains: "Aztecs" }',
                ),
              },
            },
          },
        });
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
      ? svc.getContent(MIRRORED, makeTenantContext(), startCallDeadline())
      : svc.search(
          { query: '', rows: 10, start: 0, filters: ONLINE_CC0 },
          makeTenantContext(),
          startCallDeadline(),
        );
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

      const read = await withMirror(t).getContent(id, makeTenantContext(), startCallDeadline());

      expect(up.fetchMock).not.toHaveBeenCalled();
      expect(read.provenance).toStrictEqual(FROM_MIRROR);
      expect(read.record.url).toBe(`edanmdm:${MIRRORED}`);
      expect(read.record.title).toBe('Missile, Cruise, Air-launched, Flight Test, AGM-86B ALCM');
    },
  );

  it('getContent sends a record the mirror lacks to the live API, marked edan_api', async () => {
    const up = stubUpstream({ content: () => upstream(makeContentResponse(LIVE_ONLY)) });

    const read = await withMirror(t).getContent(
      LIVE_ONLY,
      makeTenantContext(),
      startCallDeadline(),
    );

    expect(up.count('content')).toBe(1);
    expect(read.provenance).toStrictEqual(FROM_LIVE);
    expect(read.record.title).toBe('Test Object');
  });

  it('getContent still rejects a record neither the mirror nor the live API holds as not_found', async () => {
    const up = stubUpstream({
      content: () => upstream({ error: { code: 'NOT_FOUND', message: 'Record not found' } }, 404),
    });

    await expect(
      withMirror(t).getContent('nasm_MISSING', makeTenantContext(), startCallDeadline()),
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
        startCallDeadline(),
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
        startCallDeadline(),
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
      startCallDeadline(),
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

    const first = await svc.getContent(LIVE_ONLY, makeTenantContext(), startCallDeadline());
    const second = await svc.getContent(LIVE_ONLY, makeTenantContext(), startCallDeadline());

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

    const read = await svc.getContent(LIVE_ONLY, makeTenantContext(), startCallDeadline());
    const page = await svc.search(
      { query: '', rows: 10, start: 0, filters: ONLINE_CC0 },
      makeTenantContext(),
      startCallDeadline(),
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
// toFullObject indexed — the values the search filters match (issue #73)
// ---------------------------------------------------------------------------

describe('toFullObject indexed (issue #73)', () => {
  const svc = new SmithsonianService(createInMemoryStorage());

  it('returns the indexed name, place, object_type, date, and topic of nasm_A19700102000', () => {
    // Its free-text block names "Neil A. Armstrong"; the name filter matches only the
    // indexed "Armstrong, Neil A.".
    const full = svc.toFullObject({
      title: 'Command Module Columbia, Apollo 11',
      unitCode: 'NASM',
      content: {
        descriptiveNonRepeating: { record_ID: 'nasm_A19700102000', unit_code: 'NASM' },
        freetext: { name: [{ label: 'Astronaut', content: 'Neil A. Armstrong' }] },
        indexedStructured: {
          name: [
            'Collins, Michael',
            'Armstrong, Neil A.',
            'Aldrin, Buzz',
            'North American Rockwell',
          ],
          place: ['United States of America'],
          object_type: ['Spacecraft'],
          topic: ['Outer space', 'Spaceflight'],
        },
      },
    });

    expect(full.indexed).toStrictEqual({
      name: ['Collins, Michael', 'Armstrong, Neil A.', 'Aldrin, Buzz', 'North American Rockwell'],
      place: ['United States of America'],
      object_type: ['Spacecraft'],
      date: [],
      topic: ['Outer space', 'Spaceflight'],
    });
    expect(full.makers).toEqual([{ role: 'Astronaut', name: 'Neil A. Armstrong' }]);
  });

  it('reads a wrapped name from its content and drops non-string and empty entries, keeping order', () => {
    const full = svc.toFullObject({
      content: {
        indexedStructured: {
          name: [
            { type: 'author', content: 'Stewart, M. M.' } as never,
            'Plain, Name',
            { type: 'author' } as never,
            { content: '' },
            { content: 7 } as never,
            null as never,
            '',
            { VIAF: '123', content: 'Biuso, L. F.' } as never,
          ],
          place: ['Loudoun', '', 4 as never, 'Virginia'],
          object_type: [null as never, 'Quilts'],
          date: ['1860s'],
          topic: ['Quilts', { content: 'Textiles' } as never],
        },
      },
    });

    expect(full.indexed).toStrictEqual({
      name: ['Stewart, M. M.', 'Plain, Name', 'Biuso, L. F.'],
      place: ['Loudoun', 'Virginia'],
      object_type: ['Quilts'],
      date: ['1860s'],
      topic: ['Quilts'],
    });
  });

  it('returns five empty arrays for a record with no indexed block', () => {
    const empty = { name: [], place: [], object_type: [], date: [], topic: [] };
    expect(svc.toFullObject({}).indexed).toStrictEqual(empty);
    expect(
      svc.toFullObject({ content: { indexedStructured: { culture: ['Amish'] } } }).indexed,
    ).toStrictEqual(empty);
  });

  it('leaves topics merging the indexed and free-text terms as before', () => {
    const full = svc.toFullObject({
      content: {
        indexedStructured: { topic: ['Quilts'] },
        freetext: { topic: [{ label: 'Topic', content: 'Quilts--History' }] },
      },
    });
    expect(full.topics).toEqual(['Quilts', 'Quilts--History']);
    expect(full.indexed.topic).toEqual(['Quilts']);
  });
});

// ---------------------------------------------------------------------------
// toFullObject on_view and current_exhibitions — current display (issue #74)
// ---------------------------------------------------------------------------

describe('toFullObject on_view and current_exhibitions (issue #74)', () => {
  const svc = new SmithsonianService(createInMemoryStorage());
  const display = (indexedStructured: Record<string, unknown>) => {
    const full = svc.toFullObject({ content: { indexedStructured } } as RawEDAN);
    return {
      on_view: full.on_view,
      hasOnView: 'on_view' in full,
      current_exhibitions: full.current_exhibitions,
    };
  };

  it.each([
    ['["Yes"]', ['Yes'], true],
    ['["No"]', ['No'], false],
    ['["No", "Yes"]', ['No', 'Yes'], true],
  ])('reads onPhysicalExhibit %s as on_view %s', (_, flag, expected) => {
    expect(display({ onPhysicalExhibit: flag })).toMatchObject({
      on_view: expected,
      hasOnView: true,
    });
  });

  it.each([
    ['absent', {}],
    ['empty', { onPhysicalExhibit: [] }],
    ['neither Yes nor No', { onPhysicalExhibit: ['yes', 'Maybe', ''] }],
  ])('omits on_view when the flag is %s, which says nothing about display', (_, indexed) => {
    expect(display(indexed)).toStrictEqual({
      on_view: undefined,
      hasOnView: false,
      current_exhibitions: [],
    });
  });

  it('names each venue of nasm_A19700102000 and npg_NPG.2020.41 as the catalog writes it', () => {
    // Both shapes as /content returns them (2026-11-15).
    expect(
      display({ onPhysicalExhibit: ['Yes'], exhibition: [{ building: 'NASM' }] }),
    ).toStrictEqual({
      on_view: true,
      hasOnView: true,
      current_exhibitions: [{ building: 'NASM' }],
    });
    expect(
      display({
        onPhysicalExhibit: ['Yes'],
        exhibition: [
          {
            room: 'East Gallery 142',
            building: 'NPG',
            exhibitionTitle: 'Out of Many: Portraits from 1600 to 1900',
          },
        ],
      }).current_exhibitions,
    ).toStrictEqual([
      {
        building: 'NPG',
        room: 'East Gallery 142',
        title: 'Out of Many: Portraits from 1600 to 1900',
      },
    ]);
  });

  it('keeps the string parts of each entry in order and drops an entry that names nothing', () => {
    expect(
      display({
        exhibition: [
          { exhibitionTitle: 'Entertainment Nation', building: 'NMAH', exhibitionId: 'x' },
          { building: '', room: '', exhibitionTitle: '' },
          { building: 7, room: null, exhibitionTitle: ['T'] },
          {},
          null,
          'NASM',
          { room: 'Gallery 1' },
          { exhibitionTitle: 'Untitled' },
        ],
      }),
    ).toStrictEqual({
      on_view: undefined,
      hasOnView: false,
      current_exhibitions: [
        { building: 'NMAH', title: 'Entertainment Nation' },
        { room: 'Gallery 1' },
        { title: 'Untitled' },
      ],
    });
  });

  it('leaves exhibitions to the free-text history, apart from the indexed venues', () => {
    const full = svc.toFullObject({
      content: {
        freetext: { exhibitionHistory: [{ label: 'Hall 2', content: 'Milestones of Flight' }] },
        indexedStructured: { onPhysicalExhibit: ['Yes'], exhibition: [{ building: 'NASM' }] },
      },
    });
    expect(full.exhibitions).toEqual([{ name: 'Milestones of Flight', building: 'Hall 2' }]);
    expect(full.current_exhibitions).toEqual([{ building: 'NASM' }]);
    expect(
      svc.toFullObject({
        content: { indexedStructured: { exhibition: [{ building: 'NASM' }] } },
      }).exhibitions,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// toFullObject sets — the catalog's freetext.setName (issue #81)
// ---------------------------------------------------------------------------

describe('toFullObject sets (issue #81)', () => {
  const svc = new SmithsonianService(createInMemoryStorage());
  const withSets = (
    setName: Array<{ label?: string; content?: string }>,
    indexedStructured?: Record<string, unknown>,
  ) => svc.toFullObject({ content: { freetext: { setName }, indexedStructured } } as RawEDAN);

  it('returns the three sets of nasm_A19610048000 in catalog order, beside its building-only venue', () => {
    // As /content returns it (2026-11-26): the gallery and exhibition sit only in setName.
    const full = withSets(
      [
        { label: 'See more items in', content: 'National Air and Space Museum Collection' },
        { label: 'Location', content: 'National Air and Space Museum in Washington, DC' },
        { label: 'Exhibition', content: 'Wright Brothers & The Invention of the Aerial Age' },
      ],
      { onPhysicalExhibit: ['Yes'], exhibition: [{ building: 'NASM' }] },
    );
    expect(full.sets).toStrictEqual([
      { label: 'See more items in', value: 'National Air and Space Museum Collection' },
      { label: 'Location', value: 'National Air and Space Museum in Washington, DC' },
      { label: 'Exhibition', value: 'Wright Brothers & The Invention of the Aerial Age' },
    ]);
    expect(full.on_view).toBe(true);
    expect(full.current_exhibitions).toStrictEqual([{ building: 'NASM' }]);
  });

  it('keeps the repeated labels of NMAI_58046, its On View entry last', () => {
    expect(
      withSets([
        { label: 'See related items', content: 'Iñupiaq' },
        { label: 'See related items', content: 'Containers and Vessels' },
        {
          label: 'On View',
          content: 'NMAI, New York, NY: Infinity of Nations, Arctic & Subarctic',
        },
      ]).sets,
    ).toStrictEqual([
      { label: 'See related items', value: 'Iñupiaq' },
      { label: 'See related items', value: 'Containers and Vessels' },
      { label: 'On View', value: 'NMAI, New York, NY: Infinity of Nations, Arctic & Subarctic' },
    ]);
  });

  it('relays "Location: Currently not on view" of npg_NPG.91.126.5.A and still omits on_view', () => {
    const full = withSets([
      { label: 'See more items in', content: 'National Portrait Gallery Collection' },
      { label: 'Location', content: 'Currently not on view' },
    ]);
    expect(full.sets).toStrictEqual([
      { label: 'See more items in', value: 'National Portrait Gallery Collection' },
      { label: 'Location', value: 'Currently not on view' },
    ]);
    expect(full).not.toHaveProperty('on_view');
  });

  it('returns sets [] for a record without setName (siris_sil_10451)', () => {
    const full = svc.toFullObject({
      content: {
        freetext: {
          physicalDescription: [
            {
              label: 'Physical description',
              content: '79 p illustrations, facsimile, maps, plan 24 cm',
            },
          ],
        },
      },
    });
    expect(full.sets).toStrictEqual([]);
    expect(svc.toFullObject({}).sets).toStrictEqual([]);
  });

  it('drops an entry without content and labels one without a label "Set"', () => {
    expect(
      withSets([
        { label: 'On View', content: '' },
        { label: 'Department' },
        { content: 'Painting and Sculpture' },
        { label: 'See more items in', content: 'Smithsonian American Art Museum Collection' },
      ]).sets,
    ).toStrictEqual([
      { label: 'Set', value: 'Painting and Sculpture' },
      { label: 'See more items in', value: 'Smithsonian American Art Museum Collection' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// toFullObject object_rights — every rights statement, under either key (issue #82)
// ---------------------------------------------------------------------------

describe('toFullObject object_rights (issue #82)', () => {
  const svc = new SmithsonianService(createInMemoryStorage());
  type Entries = Array<{ label?: string; content?: string }>;
  const rights = (objectRights?: Entries, objectRight?: Entries) =>
    svc.toFullObject({
      content: {
        freetext: {
          ...(objectRights && { objectRights }),
          ...(objectRight && { objectRight }),
        },
      },
    } as RawEDAN);

  it('joins the two singular-key statements of the SIA record siris_arc_291804', () => {
    const full = rights(undefined, [
      { label: 'Restrictions & Rights', content: 'No access restrictions' },
      { label: 'Restrictions & Rights', content: 'No Copyright – United States' },
    ]);
    expect(full.object_rights).toBe('No access restrictions; No Copyright – United States');
  });

  it('keeps the second statement of nmaahc_2019.26.2', () => {
    const full = rights([
      { label: 'Restrictions & Rights', content: 'Public domain' },
      {
        label: 'Restrictions & Rights',
        content: 'Proper usage is the responsibility of the user.',
      },
    ]);
    expect(full.object_rights).toBe(
      'Public domain; Proper usage is the responsibility of the user.',
    );
  });

  it('reads every objectRights entry, then every objectRight entry, skipping one without content', () => {
    const full = rights(
      [
        { content: 'First' },
        { label: 'Restrictions & Rights', content: '' },
        { content: 'Second' },
      ],
      [{ label: 'Restrictions & Rights' }, { content: 'Third' }],
    );
    expect(full.object_rights).toBe('First; Second; Third');
  });

  it.each([
    ['neither key', undefined, undefined],
    ['only entries without content', [{ content: '' }], [{ label: 'Restrictions & Rights' }]],
    ['two empty lists', [], []],
  ])('omits object_rights for a record with %s', (_, objectRights, objectRight) => {
    expect(rights(objectRights, objectRight)).not.toHaveProperty('object_rights');
  });
});

// ---------------------------------------------------------------------------
// luceneFilter — the live API's term for each facet filter (issues #42, #74)
// ---------------------------------------------------------------------------

describe('luceneFilter', () => {
  it.each([
    [{ field: 'on_view' }, 'onPhysicalExhibit:"Yes"'],
    [{ field: 'online_only' }, 'online_media_type:*'],
    [{ field: 'cc0' }, 'media_usage:CC0'],
    [{ field: 'unit_code', value: 'NASM' }, 'unit_code:"NASM"'],
  ] as Array<[FacetFilter, string]>)('maps %j to %s', (filter, term) => {
    expect(luceneFilter(filter)).toBe(term);
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
// toPlainText — only the nine markup elements are tags (issue #70)
// ---------------------------------------------------------------------------

/** The Citation note of slasro_149914, verbatim: a SICI DOI puts `<` and `>` inside `href`. */
const SICI_NOTE =
  'Nelson, C. H., Meyer, Audrey W., Thor, Devin, and Larsen, Matthew C. 1986. "<a href="https://pubs.geoscienceworld.org/gsa/geology/article-abstract/14/3/238/204021/crater-lake-oregon-a-restricted-basin-with-base-of,https://pubs.geoscienceworld.org/gsa/geology/article/14/3/238/204021/crater-lake-oregon-a-restricted-basin-with-base-of">Crater Lake, Oregon: A restricted basin with base-of-slope aprons of nonchannelized turbidites</a>." <em>Geology</em>, 14, (3) 238–241. <a href="https://doi.org/10.1130/0091-7613(1986)14<238:CLOARB>2.0.CO;2">https://doi.org/10.1130/0091-7613(1986)14<238:CLOARB>2.0.CO;2</a>.';

describe('toPlainText markup elements (issue #70)', () => {
  it.each([
    // hac_1980.013, saam_1929.8.174.17, nmah_1017980
    ['<I>Aquarium or terrarium, Roman columns</I>', 'Aquarium or terrarium, Roman columns'],
    [
      'blown <b>[see 1929.8.147.1, 1929.8.147.2]</b>, and',
      'blown [see 1929.8.147.1, 1929.8.147.2], and',
    ],
    ['<i>My Life in the Bush of Ghosts</i>', 'My Life in the Bush of Ghosts'],
    [`<SPAN class="note" style='x'>a</SPAN> <EM>b</EM> x<SUB>2</SUB> y<Sup>3</Sup>`, 'a b x2 y3'],
  ])('strips a markup element in any case, with attributes: %s', (input, expected) => {
    expect(toPlainText(input)).toBe(expected);
  });

  it('separates the lines a <p> or <br> held apart (nmah_1293705)', () => {
    expect(
      toPlainText(
        '<p>Vernon Dalhart. side 1: The Wreck of the Number 9 (Silvertone 5005).<br>78 rpm.</p>',
      ),
    ).toBe('Vernon Dalhart. side 1: The Wreck of the Number 9 (Silvertone 5005). 78 rpm.');
  });

  it('strips an element whose name ends at / or whitespace', () => {
    expect(toPlainText('one<br/>two<br />three <i\n>four</i >')).toBe('one two three four');
  });

  it.each([
    // siris_sil_43136 title; siris_sil_605969 and siris_sil_113485 notes
    'Tables of functions with formulae and curves <Funktionentafeln mit Formeln und Kurven> by Dr. Eugene Jahnke ... and Fritz Emde ..',
    'Issues for <winter 1988-> carry also whole numbering.',
    'Vols. for <winter 1998- > published in Germantown, MD.',
    'Appendix. Steam tables. <Specially calculated by Prof. H.L. Callendar, F.R.S., from his own equations, to suit the methods of notation adopted in his book>: p. [735]-744.',
    '©1981-<c1985>',
    'Berberin <Frau>',
  ])('keeps catalog text in angle brackets byte-identical: %s', (text) => {
    expect(toPlainText(text)).toBe(text);
  });

  it.each(['<U+309A>', 'see <p. 23> and <p.24>', '<image> <bold> <abbr> <ii> <spans> <sublime>'])(
    'reads a name as ending at whitespace, / or >, so a longer run is text: %s',
    (text) => {
      expect(toPlainText(text)).toBe(text);
    },
  );

  it('leaves every element outside the nine as written', () => {
    const text = '<div>Line</div><li>item</li><img src="x.jpg"><font color="red">red</font>';
    expect(toPlainText(text)).toBe(text);
  });

  it('keeps a SICI DOI anchor whole: a quoted attribute value may hold < and > (slasro_149914)', () => {
    expect(toPlainText(SICI_NOTE)).toBe(
      'Nelson, C. H., Meyer, Audrey W., Thor, Devin, and Larsen, Matthew C. 1986. "Crater Lake, Oregon: A restricted basin with base-of-slope aprons of nonchannelized turbidites." Geology, 14, (3) 238–241. https://doi.org/10.1130/0091-7613(1986)14<238:CLOARB>2.0.CO;2.',
    );
  });

  it(`reads either quote style around a value holding '>'`, () => {
    expect(toPlainText(`<a title="a > b" href='x>y'>link</a> text`)).toBe('link text');
  });

  it('leaves an opener with no closing > as text, an unterminated quote included', () => {
    expect(toPlainText('see <a href="x" for details')).toBe('see <a href="x" for details');
    expect(toPlainText('quoted <a title="never closed>')).toBe('quoted <a title="never closed>');
  });

  it('strips in one pass, never to a fixed point', () => {
    expect(toPlainText('<a<a<a>>>')).toBe('<a<a>>');
  });

  it('keeps the bracketed runs on the projected title and notes', () => {
    const svc = makeService();
    const record = (title: string, notes: Array<{ label: string; content: string }>): RawEDAN => ({
      title,
      unitCode: 'SIL',
      content: { descriptiveNonRepeating: { record_ID: 'siris_sil_TEST' }, freetext: { notes } },
    });
    const title =
      'Tables of functions with formulae and curves <Funktionentafeln mit Formeln und Kurven> by Dr. Eugene Jahnke ... and Fritz Emde ..';
    expect(svc.toFullObject(record(title, [])).title).toBe(title);
    expect(svc.toSummary(record(title, [])).title).toBe(title);

    const notes = [
      { label: 'Notes', content: 'Issues for <winter 1988-> carry also whole numbering.' },
      {
        label: 'Notes',
        content:
          'Appendix. Steam tables. <Specially calculated by Prof. H.L. Callendar, F.R.S., from his own equations, to suit the methods of notation adopted in his book>: p. [735]-744.',
      },
      { label: 'Citation', content: SICI_NOTE },
    ];
    const projected = svc.toFullObject(record('Crater Lake', notes)).notes;
    expect(projected.slice(0, 2)).toEqual(notes.slice(0, 2));
    expect(projected[2]?.content).toMatch(
      / 238–241\. https:\/\/doi\.org\/10\.1130\/0091-7613\(1986\)14<238:CLOARB>2\.0\.CO;2\.$/,
    );
    expect(projected[2]?.content).not.toContain('">');
  });
});

/**
 * Least CPU time per call of `run`, in microseconds, over three measurements. Each measurement
 * repeats `run` until this thread has spent 10 ms, so a 5k input is timed over a batch; keeping
 * the least drops garbage-collection pauses, which only ever add time.
 */
function cpuPerCall(run: () => void): number {
  let least = Number.POSITIVE_INFINITY;
  for (let measurement = 0; measurement < 3; measurement++) {
    const start = process.threadCpuUsage();
    let runs = 0;
    let spent = 0;
    do {
      run();
      runs++;
      const elapsed = process.threadCpuUsage(start);
      spent = elapsed.user + elapsed.system;
    } while (spent < 10_000);
    least = Math.min(least, spent / runs);
  }
  return least;
}

describe('toPlainText scan time (issue #70)', () => {
  /**
   * Each shape doubles from its base size through a 64× span. A single unclosed candidate starts
   * at 625 characters: Bun's regex engine drops to a slower mode on one match attempt past about
   * 80k characters, which reads as super-linear on linear work, so that span ends at 40k.
   */
  const SHAPES: Array<[shape: string, make: (size: number) => string, base: number]> = [
    ['unclosed <a runs (20,000 at 80k)', (n) => '<a x'.repeat(Math.ceil(n / 4)), 5_000],
    ['unclosed openers with a double quote', (n) => '<a "'.repeat(Math.ceil(n / 4)), 5_000],
    ['unclosed openers with both quotes', (n) => `<a '"`.repeat(Math.ceil(n / 5)), 5_000],
    ['nested openers', (n) => '<a'.repeat(Math.ceil(n / 4)) + '>'.repeat(Math.ceil(n / 4)), 5_000],
    ['one long line ending in a break', (n) => `${'<a §1 x'.repeat(Math.ceil(n / 7))}\ny`, 5_000],
    ['breaks throughout', (n) => '<a  \r\n'.repeat(Math.ceil(n / 6)), 5_000],
    ['a single unclosed candidate', (n) => `<a ${'x'.repeat(n)}`, 625],
  ];

  it.each(SHAPES)(
    'stays linear on %s',
    (_shape, make, base) => {
      const sizes = Array.from({ length: 7 }, (_, i) => base * 2 ** i);
      // Bounded before the next doubling, so a super-linear scan fails in seconds at a small
      // size instead of hanging the suite on the largest one.
      for (const size of sizes) {
        const input = make(size);
        expect(cpuPerCall(() => toPlainText(input))).toBeLessThan(size * 0.25);
      }
      // Full-span growth from pairs timed back to back, the least of three: a baseline timed
      // once can land on a faster core than the size it is compared with.
      const smallest = make(base);
      const largest = make(sizes.at(-1) as number);
      let growth = Number.POSITIVE_INFINITY;
      for (let pair = 0; pair < 3; pair++) {
        const small = cpuPerCall(() => toPlainText(smallest));
        growth = Math.min(growth, cpuPerCall(() => toPlainText(largest)) / small);
      }
      expect(growth).toBeLessThan(256);
    },
    0,
  );
});

// ---------------------------------------------------------------------------
// Full-size JPEG and accessibility text on image items (issue #71)
// ---------------------------------------------------------------------------

describe('image items: full-size JPEG and accessibility text (issue #71)', () => {
  /** The one image a single-item record normalizes to. */
  const imageOf = (item: RawMediaItem) => {
    const images = makeService().toImageItems(
      makeMediaRecord({ online_media: { mediaCount: 1, media: [item] } }),
    );
    expect(images).toHaveLength(1);
    return images[0];
  };

  const NASM_ID = 'NASM-NASM2022-05013-000003';
  const NASM_CONTENT = `https://ids.si.edu/ids/deliveryService?id=${NASM_ID}`;

  it('takes high_res_jpeg from content, with no dimensions, when no JPEG resource exists (nasm_A19700102000)', () => {
    expect(
      imageOf({
        type: 'Images',
        idsId: NASM_ID,
        content: NASM_CONTENT,
        thumbnail: NASM_CONTENT,
        usage: { access: 'CC0' },
        resources: [
          { label: 'Screen Image', url: `https://ids.si.edu/ids/download?id=${NASM_ID}_screen` },
          { label: 'Thumbnail Image', url: `https://ids.si.edu/ids/download?id=${NASM_ID}_thumb` },
        ],
      }),
    ).toEqual({
      media_id: NASM_ID,
      is_cc0: true,
      thumbnail_url: `https://ids.si.edu/ids/download?id=${NASM_ID}_thumb`,
      screen_url: `https://ids.si.edu/ids/download?id=${NASM_ID}_screen`,
      high_res_jpeg: { url: NASM_CONTENT },
    });
  });

  it('gives an item with no resources content as both screen_url and high_res_jpeg (nmnhvz_4403742)', () => {
    const content = 'https://collections.nmnh.si.edu/media/?irn=17080708';
    const image = imageOf({
      type: 'Images',
      idsId: content,
      content,
      thumbnail: `${content}&thumb=yes`,
      usage: { access: 'CC0' },
    });
    expect(image?.screen_url).toBe(content);
    expect(image?.high_res_jpeg).toEqual({ url: content });
  });

  it('adds high_res_jpeg from content to a TIFF-only image and keeps its TIFF (npg_NPG.94.15)', () => {
    const id = 'NPG-NPG_94_15_det_ext';
    const image = imageOf({
      type: 'Images',
      idsId: id,
      content: `https://ids.si.edu/ids/deliveryService?id=${id}`,
      usage: { access: 'CC0' },
      resources: [
        {
          label: 'High-resolution TIFF',
          url: `https://ids.si.edu/ids/download?id=${id}.tif`,
          width: 3220,
          height: 3776,
        },
        { label: 'Screen Image', url: `https://ids.si.edu/ids/download?id=${id}_screen` },
      ],
    });
    expect(image?.high_res_jpeg).toEqual({
      url: `https://ids.si.edu/ids/deliveryService?id=${id}`,
    });
    expect(image?.high_res_tiff).toEqual({
      url: `https://ids.si.edu/ids/download?id=${id}.tif`,
      width: 3220,
      height: 3776,
    });
  });

  it('keeps a listed JPEG resource, dimensions included, over content', () => {
    const id = 'NPG-NPG_94_15BoydenM_int';
    const image = imageOf({
      type: 'Images',
      idsId: id,
      content: `https://ids.si.edu/ids/deliveryService?id=${id}`,
      usage: { access: 'CC0' },
      resources: [
        {
          label: 'High-resolution JPEG',
          url: `https://ids.si.edu/ids/download?id=${id}.jpg`,
          width: 4000,
          height: 2322,
        },
      ],
    });
    expect(image?.high_res_jpeg).toEqual({
      url: `https://ids.si.edu/ids/download?id=${id}.jpg`,
      width: 4000,
      height: 2322,
    });
  });

  it('has no high_res_jpeg when the item has neither content nor a JPEG resource', () => {
    const image = imageOf({
      type: 'Images',
      idsId: 'NASM-NO-CONTENT',
      usage: { access: 'CC0' },
      resources: [{ label: 'Screen Image', url: 'https://ids.si.edu/ids/download?id=X_screen' }],
    });
    expect(image).not.toHaveProperty('high_res_jpeg');
    expect(image?.screen_url).toBe('https://ids.si.edu/ids/download?id=X_screen');
  });

  it.each([
    ['an empty string', ''],
    ['null', null],
  ])(
    'omits alt_text and description when upstream gives %s, as when it gives nothing',
    (_label, empty) => {
      const image = imageOf({
        type: 'Images',
        idsId: 'CHNDM-EMPTY',
        usage: { access: 'CC0' },
        // chndm_1945-55-16 carries altTextAccessibility: "" on all 229 of its images.
        altTextAccessibility: empty as string,
        extDescrAccessibility: empty as string,
      });
      expect(image).not.toHaveProperty('alt_text');
      expect(image).not.toHaveProperty('description');
    },
  );

  it('keeps accessibility text that is present', () => {
    const image = imageOf({
      type: 'Images',
      idsId: 'NPG-ALT',
      usage: { access: 'CC0' },
      altTextAccessibility: 'Artist: Unidentified Artist, Sitter: Seth Boyden',
      extDescrAccessibility: 'The Apollo 11 Command Module Columbia displayed in a gallery.',
    });
    expect(image?.alt_text).toBe('Artist: Unidentified Artist, Sitter: Seth Boyden');
    expect(image?.description).toBe(
      'The Apollo 11 Command Module Columbia displayed in a gallery.',
    );
  });
});

// ---------------------------------------------------------------------------
// Summary and object thumbnail_url: the first media item's thumbnail resource
// ---------------------------------------------------------------------------

describe('thumbnail_url of a summary and an object', () => {
  const ID = 'NASM-NASM2022-05013-000003';
  const FULL_SIZE = `https://ids.si.edu/ids/deliveryService?id=${ID}`;
  const THUMB = `https://ids.si.edu/ids/download?id=${ID}_thumb`;

  /**
   * nasm_A19700102000's first media item as a live `/search` row carries it (2026-11-15):
   * `thumbnail` repeats the full-size `content` URL, and the thumbnail is a resource.
   */
  const IDS_ITEM: RawMediaItem = {
    type: 'Images',
    idsId: ID,
    content: FULL_SIZE,
    thumbnail: FULL_SIZE,
    usage: { access: 'CC0' },
    resources: [
      { label: 'Thumbnail Image', url: THUMB },
      { label: 'Screen Image', url: `https://ids.si.edu/ids/download?id=${ID}_screen` },
    ],
  };
  const row = (media: RawMediaItem[]): RawEDAN => ({
    title: 'Command Module Columbia, Apollo 11',
    unitCode: 'NASM',
    url: 'edanmdm:nasm_A19700102000',
    content: {
      descriptiveNonRepeating: {
        record_ID: 'nasm_A19700102000',
        unit_code: 'NASM',
        online_media: { mediaCount: media.length, media },
      },
    },
  });

  beforeEach(() => {
    vi.stubEnv('SMITHSONIAN_API_KEY', 'test-key-12345');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('takes a search row’s thumbnail from its thumbnail resource, not the full-size URL', async () => {
    mockFetch({ status: 200, responseCode: 1, response: { rows: [row([IDS_ITEM])], rowCount: 1 } });

    const page = await makeService().search(
      { query: 'apollo', rows: 1, start: 0 },
      makeTenantContext(),
      startCallDeadline(),
    );

    expect(page.rows[0]?.thumbnail_url).toBe(THUMB);
  });

  it('gives the object the same thumbnail get_media gives its first image', () => {
    const svc = makeService();
    const raw = row([IDS_ITEM]);

    expect(svc.toFullObject(raw).media_summary.thumbnail_url).toBe(THUMB);
    expect(svc.toImageItems(raw)[0]?.thumbnail_url).toBe(THUMB);
  });

  it('falls back to the item’s thumbnail when no resource is labelled one', () => {
    const svc = makeService();
    const raw = row([
      {
        ...IDS_ITEM,
        thumbnail: `${FULL_SIZE}&max=150`,
        resources: [
          { label: 'Screen Image', url: `https://ids.si.edu/ids/download?id=${ID}_screen` },
        ],
      },
    ]);

    expect(svc.toSummary(raw).thumbnail_url).toBe(`${FULL_SIZE}&max=150`);
    expect(svc.toFullObject(raw).media_summary.thumbnail_url).toBe(`${FULL_SIZE}&max=150`);
  });

  it('reads the first media item only, and has none without media', () => {
    const svc = makeService();
    const second: RawMediaItem = {
      ...IDS_ITEM,
      thumbnail: 'https://x/second',
      resources: [{ label: 'Thumbnail Image', url: 'https://x/second_thumb' }],
    };
    const noThumb: RawMediaItem = {
      type: '3d_voyager',
      content: 'https://3d-api.si.edu/voyager/x',
    };

    expect(svc.toSummary(row([noThumb, second]))).not.toHaveProperty('thumbnail_url');
    expect(svc.toSummary(row([]))).not.toHaveProperty('thumbnail_url');
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

/** The `resources/` URL of `filename` in 3D package `uuid`. */
const packageFile = (uuid: string, filename: string) =>
  `https://3d-api.si.edu/content/document/3d_package:${uuid}/resources/${filename}`;

const HESPEROCYON = '0b46b532-888e-419b-bb18-c6b8dd1cec6c';

/** nmnhpaleobiology_13278478's one package: every attribute in one object per file. */
function hesperocyonPackage(): RawMediaItem {
  const file = (filename: string, category: string, fileType: string, model: string) => ({
    url: packageFile(HESPEROCYON, filename),
    name: 'Hesperocyon sp',
    type: '3D mesh',
    title: `Hesperocyon sp (${category} 3D mesh, ${model}, scale in m)`,
    category,
    filename,
    attributes: [
      {
        UNITS: 'm',
        FILE_TYPE: fileType,
        MODEL_FILE_TYPE: model,
        DRACO_COMPRESSED: filename.endsWith('_draco.glb'),
        GLTF_STANDARDIZED: true,
      },
    ],
  });
  return {
    id: `3d_package:${HESPEROCYON}`,
    type: '3d_voyager',
    usage: { access: 'CC0' },
    content: `https://3d-api.si.edu/voyager/3d_package:${HESPEROCYON}`,
    thumbnail: `https://3d-api.si.edu/content/document/3d_package:${HESPEROCYON}/Hesperocyon_sp-image-thumb.jpg`,
    resources: [
      file('Hesperocyon_sp-150k-4096_std.glb', 'Low resolution', 'glb', 'glb'),
      file('Hesperocyon_sp-100k-2048_std_draco.glb', 'Low resolution', 'glb', 'glb'),
      file('Hesperocyon_sp-100k-2048_std.usdz', 'iOS AR model', 'usdz', 'usdz'),
      file('Hesperocyon_sp-full_resolution-obj_std.zip', 'Full resolution', 'zip', 'obj'),
      file('Hesperocyon_sp-150k-4096-gltf_std.zip', 'Low resolution', 'zip', 'gltf'),
      file('Hesperocyon_sp-150k-4096-obj_std.zip', 'Low resolution', 'zip', 'obj'),
    ],
  };
}

/** One record of `media`, counted as given. */
const modelRecord = (media: RawMediaItem[]) =>
  makeMediaRecord({ online_media: { mediaCount: media.length, media } });

describe('toModelPackages() (issue #83)', () => {
  it('reads every file of nmnhpaleobiology_13278478 from one combined attributes object', () => {
    const file = (filename: string, category: string, file_type: string, model: string) => ({
      url: packageFile(HESPEROCYON, filename),
      filename,
      category,
      file_type,
      model_file_type: model,
      units: 'm',
      draco_compressed: filename.endsWith('_draco.glb'),
    });

    expect(makeService().toModelPackages(modelRecord([hesperocyonPackage()]))).toStrictEqual([
      {
        media_id: `3d_package:${HESPEROCYON}`,
        is_cc0: true,
        viewer_url: `https://3d-api.si.edu/voyager/3d_package:${HESPEROCYON}`,
        thumbnail_url: `https://3d-api.si.edu/content/document/3d_package:${HESPEROCYON}/Hesperocyon_sp-image-thumb.jpg`,
        files: [
          file('Hesperocyon_sp-150k-4096_std.glb', 'Low resolution', 'glb', 'glb'),
          file('Hesperocyon_sp-100k-2048_std_draco.glb', 'Low resolution', 'glb', 'glb'),
          file('Hesperocyon_sp-100k-2048_std.usdz', 'iOS AR model', 'usdz', 'usdz'),
          file('Hesperocyon_sp-full_resolution-obj_std.zip', 'Full resolution', 'zip', 'obj'),
          file('Hesperocyon_sp-150k-4096-gltf_std.zip', 'Low resolution', 'zip', 'gltf'),
          file('Hesperocyon_sp-150k-4096-obj_std.zip', 'Low resolution', 'zip', 'obj'),
        ],
      },
    ]);
  });

  it('reads FILE_SIZE from the entry dpo_3d_200122 splits it into (bulk fixture line)', () => {
    const raw = OA_FIXTURE_LINES.map((line) => JSON.parse(line) as RawEDAN).find(
      (r) => r.url === 'edanmdm:dpo_3d_200122',
    );
    const uuid = 'c0bc58e6-b172-4543-ad58-50261aea523c';

    const [pkg, ...rest] = makeService().toModelPackages(raw ?? {});

    expect(rest).toEqual([]);
    expect(pkg?.files.map((f) => [f.filename, f.size_bytes])).toEqual([
      ['TYCHO-100k-2048_std_draco.glb', 2567980],
      ['TYCHO-full_resolution-obj_std.zip', 13577712],
      ['TYCHO-150k-4096-gltf_std.zip', 8766870],
      ['TYCHO-150k-4096_std.glb', 11107176],
      ['TYCHO-print_ready.zip', 25027679],
      ['TYCHO-100k-2048_std.usdz', 3541386],
      ['TYCHO-150k-4096-obj_std.zip', 9214208],
    ]);
    expect(pkg?.files[0]).toStrictEqual({
      url: packageFile(uuid, 'TYCHO-100k-2048_std_draco.glb'),
      filename: 'TYCHO-100k-2048_std_draco.glb',
      category: 'Low Resolution',
      file_type: 'draco compressed glb',
      model_file_type: 'draco compressed glb',
      units: 'm',
      draco_compressed: true,
      size_bytes: 2567980,
    });
    expect(pkg?.files.at(-1)?.units).toBe('default');
  });

  it('reads one key per entry (dpo_3d_200016)', () => {
    const uuid = '64ff5dbe-cf46-486e-8b3a-cb8e1fd7895c';
    const raw = modelRecord([
      {
        id: `3d_package:${uuid}`,
        type: '3d_voyager',
        usage: { access: 'CC0' },
        content: `https://3d-api.si.edu/voyager/3d_package:${uuid}`,
        resources: [
          {
            url: packageFile(uuid, 'mpc_684-100k-web.glb'),
            category: 'Low resolution',
            filename: 'mpc_684-100k-web.glb',
            attributes: [
              { UNITS: 'mm' },
              { MODEL_FILE_TYPE: 'glb' },
              { FILE_TYPE: 'glb' },
              { FILE_SIZE: 24283376 },
            ],
          },
        ],
      },
    ]);

    expect(makeService().toModelPackages(raw)[0]?.files).toStrictEqual([
      {
        url: packageFile(uuid, 'mpc_684-100k-web.glb'),
        filename: 'mpc_684-100k-web.glb',
        category: 'Low resolution',
        file_type: 'glb',
        model_file_type: 'glb',
        units: 'mm',
        size_bytes: 24283376,
      },
    ]);
  });

  it('gives url, filename, and size_bytes alone where nmah_213141 lists nothing else', () => {
    const uuid = '9172faae-dbbe-424a-a9e7-56f4428a06dd';
    const filename = 'lincoln_patent_model-full_resolution-obj_std.zip';
    const raw = modelRecord([
      { idsId: 'NMAH-2008-10155', type: 'Images', usage: { access: 'CC0' } },
      {
        id: `3d_package:${uuid}`,
        type: '3d_voyager',
        usage: { access: 'CC0' },
        content: `https://3d-api.si.edu/voyager/3d_package:${uuid}`,
        resources: [
          {
            url: packageFile(uuid, filename),
            name: "Abraham Lincoln's Patent Model",
            title: "Abraham Lincoln's Patent Model",
            filename,
            attributes: [{ FILE_SIZE: 623383950 }],
          },
        ],
      },
    ]);

    expect(makeService().toModelPackages(raw)[0]?.files).toStrictEqual([
      { url: packageFile(uuid, filename), filename, size_bytes: 623383950 },
    ]);
  });

  it('lists no files for a package whose resources key is absent (dpo_3d_200017)', () => {
    const uuid = '016ceecb-49ea-43e8-b629-c5a2f4ded297';
    const raw = modelRecord([
      {
        id: `3d_package:${uuid}`,
        type: '3d_voyager',
        usage: { access: 'CC0' },
        content: `https://3d-api.si.edu/voyager/3d_package:${uuid}`,
        thumbnail: `https://3d-api.si.edu/content/document/3d_package:${uuid}/scene-image-thumb.jpg`,
      },
    ]);

    expect(makeService().toModelPackages(raw)).toStrictEqual([
      {
        media_id: `3d_package:${uuid}`,
        is_cc0: true,
        viewer_url: `https://3d-api.si.edu/voyager/3d_package:${uuid}`,
        thumbnail_url: `https://3d-api.si.edu/content/document/3d_package:${uuid}/scene-image-thumb.jpg`,
        files: [],
      },
    ]);
  });

  it('passes spellings and upstream contradictions through as written (nmnhvz_7511097)', () => {
    const uuid = 'a8ab02ba-bcae-470a-9df4-db1265b25905';
    const attrs = (fileType: string, model: string, units = 'm') => [
      { UNITS: units, FILE_TYPE: fileType, MODEL_FILE_TYPE: model, DRACO_COMPRESSED: false },
    ];
    const raw = modelRecord([
      {
        id: `3d_package:${uuid}`,
        type: '3d_voyager',
        usage: { access: 'CC0' },
        resources: [
          {
            url: packageFile(uuid, 'a.glb'),
            category: 'Full Resoluition',
            attributes: attrs('draco compressed glb', 'draco compressed glb'),
          },
          {
            url: packageFile(uuid, 'b.glb'),
            category: 'Full_resolution',
            attributes: attrs('GLB', 'GLB'),
          },
          {
            url: packageFile(uuid, 'c.zip'),
            category: 'Water_tight',
            attributes: attrs('ZIP', 'udsz', 'in'),
          },
        ],
      },
    ]);

    expect(
      makeService()
        .toModelPackages(raw)[0]
        ?.files.map((f) => [
          f.category,
          f.file_type,
          f.model_file_type,
          f.units,
          f.draco_compressed,
        ]),
    ).toEqual([
      ['Full Resoluition', 'draco compressed glb', 'draco compressed glb', 'm', false],
      ['Full_resolution', 'GLB', 'GLB', 'm', false],
      ['Water_tight', 'ZIP', 'udsz', 'in', false],
    ]);
  });

  it('settles a key from the first entry carrying it and leaves out values of the wrong kind', () => {
    const raw = modelRecord([
      {
        id: '3d_package:quirks',
        type: '3d_voyager',
        usage: { access: 'CC0' },
        resources: [
          {
            url: 'https://3d-api.si.edu/f/first-wins.glb',
            attributes: [
              { UNITS: 'mm', FILE_SIZE: 10, MODEL_FILE_TYPE: 'glb' },
              {
                UNITS: 'm',
                FILE_SIZE: 20,
                DRACO_COMPRESSED: true,
                FILE_TYPE: 'draco compressed glb',
                MODEL_FILE_TYPE: 'obj',
              },
              { DRACO_COMPRESSED: false, FILE_TYPE: 'zip', MODEL_FILE_TYPE: 'gltf' },
            ],
          },
          {
            url: 'https://3d-api.si.edu/f/wrong-kinds.glb',
            filename: '',
            category: '',
            attributes: [
              null,
              'UNITS',
              { UNITS: '', FILE_TYPE: 7, MODEL_FILE_TYPE: '', DRACO_COMPRESSED: 'true' },
              { FILE_SIZE: '2567980' },
              { FILE_SIZE: -1 },
              { FILE_SIZE: 12.5 },
            ] as never,
          },
          { url: 'https://3d-api.si.edu/f/not-an-array.glb', attributes: { UNITS: 'm' } as never },
          { url: 'https://3d-api.si.edu/f/empty.glb', attributes: [] },
        ],
      },
    ]);

    expect(makeService().toModelPackages(raw)[0]?.files).toStrictEqual([
      {
        url: 'https://3d-api.si.edu/f/first-wins.glb',
        file_type: 'draco compressed glb',
        model_file_type: 'glb',
        units: 'mm',
        draco_compressed: true,
        size_bytes: 10,
      },
      { url: 'https://3d-api.si.edu/f/wrong-kinds.glb' },
      { url: 'https://3d-api.si.edu/f/not-an-array.glb' },
      { url: 'https://3d-api.si.edu/f/empty.glb' },
    ]);
  });

  it('drops a resource with no url and a package with no id', () => {
    const raw = modelRecord([
      {
        type: '3d_voyager',
        content: 'https://3d-api.si.edu/voyager/no-id',
        usage: { access: 'CC0' },
      },
      {
        id: '3d_package:kept',
        type: '3d_voyager',
        content: '',
        thumbnail: '',
        resources: [
          { filename: 'orphan.glb' },
          { url: '', filename: 'blank.glb' },
          { url: 'https://3d-api.si.edu/f/x.glb' },
        ],
      },
    ]);

    expect(makeService().toModelPackages(raw)).toStrictEqual([
      {
        media_id: '3d_package:kept',
        is_cc0: false,
        files: [{ url: 'https://3d-api.si.edu/f/x.glb' }],
      },
    ]);
  });

  it('keeps non-CC0 packages with is_cc0 false, and only 3d_voyager items, in catalog order', () => {
    const raw = modelRecord([
      { id: '3d_package:a', type: '3d_voyager', usage: { access: 'CC0' } },
      { id: 'media:img', idsId: 'IMG', type: 'Images', usage: { access: 'CC0' } },
      { id: '3d_package:b', type: '3d_voyager', usage: { access: 'Usage Conditions Apply' } },
      { id: 'media:book', type: 'Scanned books', content: 'https://doi.org/10.5479/x' },
      { id: '3d_package:c', type: '3D_Voyager', usage: { access: 'CC0' } },
      { id: '3d_package:d', type: '3d_voyager' },
    ]);

    expect(
      makeService()
        .toModelPackages(raw)
        .map((p) => [p.media_id, p.is_cc0]),
    ).toEqual([
      ['3d_package:a', true],
      ['3d_package:b', false],
      ['3d_package:d', false],
    ]);
  });

  it('lists every package that media_summary.non_image_media links, 49 of them beside 13 images (nmnhvz_7047834)', () => {
    const images = Array.from({ length: 13 }, (_, i) => ({
      idsId: `NMNH-IMG-${i}`,
      type: 'Images',
      usage: { access: 'CC0' },
    }));
    const packages = Array.from({ length: 49 }, (_, i) => ({
      id: `3d_package:${i}`,
      type: '3d_voyager',
      content: `https://3d-api.si.edu/voyager/3d_package:${i}`,
      usage: { access: 'CC0' },
      resources: [
        {
          url: packageFile(`${i}`, `USNM395636_${i}.ply`),
          category: 'Full resolution',
          filename: `USNM395636_${i}.ply`,
          attributes: [
            { UNITS: 'mm' },
            { MODEL_FILE_TYPE: 'ply' },
            { FILE_TYPE: 'ply' },
            { FILE_SIZE: 19025414 },
          ],
        },
      ],
    }));
    const svc = makeService();
    const raw = modelRecord([...images, ...packages]);

    const models = svc.toModelPackages(raw);

    expect(models).toHaveLength(49);
    expect(models.map((p) => p.viewer_url)).toEqual(
      svc.toFullObject(raw).media_summary.non_image_media.map((m) => m.url),
    );
    expect(models.every((p) => p.files.length === 1)).toBe(true);
    expect(svc.toImageItems(raw)).toHaveLength(13);
  });

  it('is empty when the record has no media', () => {
    expect(makeService().toModelPackages({})).toEqual([]);
    expect(makeService().toModelPackages(modelRecord([]))).toEqual([]);
  });

  it.each(['edanmdm:dpo_3d_200122', 'edanmdm:dpo_3d_200016'])(
    'reads the same packages from the stored doc of %s as from its full bulk line',
    async (url) => {
      const { decodeDoc, encodeDoc, trimRecord } = await import(
        '@/services/smithsonian/oa-mirror.js'
      );
      const line = OA_FIXTURE_LINES.map((l) => JSON.parse(l) as Record<string, unknown>).find(
        (l) => l.url === url,
      );
      expect(line).toBeDefined();
      const svc = makeService();

      const fromLine = svc.toModelPackages(line as RawEDAN);
      const fromDoc = svc.toModelPackages(decodeDoc(encodeDoc(trimRecord(line ?? {}))));

      expect(fromLine[0]?.files.length).toBeGreaterThan(0);
      expect(fromLine[0]?.files.every((f) => f.size_bytes !== undefined && f.units)).toBe(true);
      expect(fromDoc).toStrictEqual(fromLine);
    },
  );
});

// ---------------------------------------------------------------------------
// One deadline per tool call (issue #68)
// ---------------------------------------------------------------------------

describe('one deadline per tool call (issue #68)', () => {
  type Read = 'search' | 'content' | 'terms';
  type Answer = (signal: AbortSignal) => Response | Promise<Response>;
  const SEARCH = { query: 'aircraft', rows: 10, start: 0 };
  const RECORD = 'nasm_TEST001';

  /** A deadline `ms` from now, as a tool handler holds it partway through its call. */
  function deadlineIn(ms: number): CallDeadline {
    return (Date.now() + ms) as CallDeadline;
  }

  /** The 200 each read answers on success. */
  function answer(read: Read): Response {
    const body =
      read === 'search'
        ? makeSearchResponse()
        : read === 'content'
          ? makeContentResponse(RECORD)
          : { status: 200, responseCode: 1, response: { terms: ['Aztecs'] } };
    return new Response(JSON.stringify(body), { status: 200 });
  }

  /** A request the upstream never answers: only its signal aborting ends it. */
  function hung(signal: AbortSignal): Promise<Response> {
    return new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }

  /** A request answered `ms` after it arrives, or rejected when its signal aborts first. */
  function answerAfter(ms: number, read: Read): Answer {
    return (signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(answer(read)), ms);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      });
  }

  /** The read a request addresses, from its path. */
  function readOf(input: string): Read | undefined {
    const segments = new URL(input).pathname.split('/');
    if (segments.at(-1) === 'search') return 'search';
    if (segments.at(-2) === 'content') return 'content';
    if (segments.at(-2) === 'terms') return 'terms';
    return undefined;
  }

  /**
   * Stub fetch with one answer per read; any other request rejects. Each answer receives the
   * request's signal. Returns the requests each read received, as their signals.
   */
  function route(answers: Partial<Record<Read, Answer>>) {
    const sent: Record<Read, AbortSignal[]> = { search: [], content: [], terms: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit) => {
        const read = readOf(input);
        const respond = read ? answers[read] : undefined;
        if (!read || !respond) throw new Error('unmocked fetch');
        const signal = init.signal as AbortSignal;
        sent[read].push(signal);
        return respond(signal);
      }),
    );
    return sent;
  }

  /** One read on `svc` under `deadline`. */
  function readOn(svc: SmithsonianService, read: Read, deadline: CallDeadline) {
    const ctx = makeTenantContext();
    return read === 'search'
      ? svc.search(SEARCH, ctx, deadline)
      : read === 'content'
        ? svc.getContent(RECORD, ctx, deadline)
        : svc.listTerms({ field: 'culture', start: 0, rows: 10 }, ctx, deadline);
  }

  /** A service whose config reads `variable` as 0 — the config memo is module-level. */
  async function serviceWithout(variable: string): Promise<SmithsonianService> {
    vi.stubEnv(variable, '0');
    vi.resetModules();
    const { SmithsonianService: FreshService } = await import(
      '@/services/smithsonian/smithsonian-service.js'
    );
    return new FreshService(createInMemoryStorage());
  }

  /** A pending call's outcome, readable without awaiting it. */
  function track(pending: Promise<unknown>) {
    const state: { settled: boolean; outcome?: unknown } = { settled: false };
    pending.then(
      (value) => Object.assign(state, { settled: true, outcome: value }),
      (error: unknown) => Object.assign(state, { settled: true, outcome: error }),
    );
    return state;
  }

  /** The error code and reason a call failed with. */
  function failure(outcome: unknown): { code?: number; reason?: string } {
    const error = outcome as { code?: number; data?: { reason?: string } };
    return { code: error.code, reason: error.data?.reason };
  }

  const EXPIRED = { code: JsonRpcErrorCode.Timeout, reason: 'retry_deadline_exceeded' };

  beforeEach(() => {
    vi.stubEnv('SMITHSONIAN_API_KEY', 'test-key-12345');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['search', undefined],
    ['content', undefined],
    ['terms', undefined],
    ['search', 'SMITHSONIAN_SEARCH_CACHE_TTL_SECONDS'],
  ] as const)(
    'a %s read started with no time left sends no request and throws Timeout (cache off: %s)',
    async (read, uncached) => {
      const sent = route({ [read]: () => answer(read) });
      const svc = uncached ? await serviceWithout(uncached) : makeService();

      const outcome = await readOn(svc, read, deadlineIn(0)).catch((error: unknown) => error);

      expect(sent[read]).toHaveLength(0);
      expect(failure(outcome)).toEqual(EXPIRED);
    },
  );

  it.each([
    ['search', 'SMITHSONIAN_SEARCH_CACHE_TTL_SECONDS'],
    ['content', 'SMITHSONIAN_CONTENT_CACHE_TTL_SECONDS'],
    ['terms', 'SMITHSONIAN_TERMS_CACHE_TTL_SECONDS'],
  ] as const)(
    'with %s caching off, a hung read ends at the call deadline, not 50 s after it starts',
    async (read, variable) => {
      const svc = await serviceWithout(variable);
      const sent = route({ [read]: hung });
      vi.useFakeTimers();

      const call = track(readOn(svc, read, deadlineIn(10_000)));
      await vi.advanceTimersByTimeAsync(9_999);
      expect(call.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(call.settled).toBe(true);
      expect(failure(call.outcome)).toEqual(EXPIRED);
      expect(sent[read].every((signal) => signal.aborted)).toBe(true);
    },
  );

  it('a /terms body read cut by the deadline throws Timeout, not a bare DOMException', async () => {
    // The headers arrive at once; the body sends its first bytes and stalls until the
    // request signal aborts, as a real body does.
    route({
      terms: (signal) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"response":{"terms":["Azt'));
              signal.addEventListener('abort', () => controller.error(signal.reason), {
                once: true,
              });
            },
          }),
          { status: 200 },
        ),
    });
    vi.useFakeTimers();

    const call = track(readOn(makeService(), 'terms', deadlineIn(5_000)));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(call.settled).toBe(true);
    expect((call.outcome as Error).name).not.toBe('TimeoutError');
    expect(failure(call.outcome)).toEqual(EXPIRED);
  });

  it('a caller whose deadline passes on a shared load rejects Timeout alone; the other gets the page from one request', async () => {
    const sent = route({ search: answerAfter(10_000, 'search') });
    vi.useFakeTimers();
    const svc = makeService();

    const early = track(readOn(svc, 'search', deadlineIn(5_000)));
    const late = track(readOn(svc, 'search', deadlineIn(50_000)));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(early.settled).toBe(true);
    expect(failure(early.outcome)).toEqual({
      code: JsonRpcErrorCode.Timeout,
      reason: 'retry_deadline_exceeded',
    });
    expect(late.settled).toBe(false);
    expect(sent.search[0]?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(late.outcome).toMatchObject({ rowCount: 42 });
    expect(sent.search).toHaveLength(1);
  });

  it.each(['search', 'content'] as const)(
    "the last waiter's deadline aborts the shared %s load",
    async (read) => {
      const sent = route({ [read]: hung });
      vi.useFakeTimers();

      const call = track(readOn(makeService(), read, deadlineIn(5_000)));
      await vi.advanceTimersByTimeAsync(5_000);

      expect(failure(call.outcome)).toEqual(EXPIRED);
      expect(sent[read]).toHaveLength(1);
      expect(sent[read][0]?.aborted).toBe(true);
    },
  );

  describe('through the single-read tools', () => {
    beforeEach(() => {
      initSmithsonianService({} as AppConfig, createInMemoryStorage());
    });

    it.each([
      [
        'smithsonian_get_object',
        'content',
        () => runToolContract(smithsonianGetObject, { id: RECORD }),
      ],
      [
        'smithsonian_get_media',
        'content',
        () => runToolContract(smithsonianGetMedia, { id: RECORD }),
      ],
      [
        'smithsonian_list_terms',
        'terms',
        () => runToolContract(smithsonianListTerms, { field: 'culture' }),
      ],
    ] as const)('%s keeps a 50 s bound on a hung upstream', async (_tool, read, call) => {
      route({ [read]: hung });
      vi.useFakeTimers();

      // Backoff jitter can end the ladder up to a second early, when the last backoff would
      // outlast what is left, so the bound is "by 50 s", not "at 50 s".
      const result = track(call());
      await vi.advanceTimersByTimeAsync(50_000);

      expect(result.settled).toBe(true);
      expect(result.outcome).toMatchObject({
        isError: true,
        structuredContent: { error: { code: JsonRpcErrorCode.Timeout } },
      });
    });
  });
});
