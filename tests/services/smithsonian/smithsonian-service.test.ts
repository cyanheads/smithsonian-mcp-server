/**
 * @fileoverview Tests for SmithsonianService — HTTP layer mocked via vi.stubGlobal.
 * @module tests/services/smithsonian/smithsonian-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createInMemoryStorage, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { smithsonianGetObject } from '@/mcp-server/tools/definitions/smithsonian-get-object.tool.js';
import { luceneField, SmithsonianService } from '@/services/smithsonian/smithsonian-service.js';
import type {
  RawContentResponse,
  RawEDAN,
  RawSearchResponse,
} from '@/services/smithsonian/types.js';

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
 * ID tools declare the same entry, and `ctx.recoveryFor` resolves against whichever
 * one is executing, so asserting through one contract covers the shared service path.
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
        { query: 'test', rows: 5, start: 0, filters: ['unit_code:NASM', 'media_usage:CC0'] },
        ctx,
      );
      const calledUrl = (fetchMock.mock.calls[0] as [string])[0];
      // Filters must appear in q, not as separate fq params
      expect(calledUrl).not.toContain('fq=');
      const qs = new URL(calledUrl).searchParams;
      const q = qs.get('q') ?? '';
      // ANDed as hard constraints; base query parenthesized so AND doesn't bind to one word
      expect(q).toBe('(test) AND unit_code:NASM AND media_usage:CC0');
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
      const raw = await svc.getContent('nasm_TEST001', ctx);
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
      // No contract on this ctx, so the recovery resolver yields {} and the payload
      // keeps its pre-contract shape — the spread must stay safe either way.
      expect(err.data?.recovery).toBeUndefined();
    });

    it("carries the calling tool's declared recovery hint when response is absent (issue #25)", async () => {
      // Resolved from the real tool contract, not a copied string — so a contract
      // reword can't silently drift away from what reaches the wire.
      mockFetch({ status: 200, responseCode: 1, response: null });
      const svc = makeService();
      const ctx = createMockContext({ errors: smithsonianGetObject.errors });
      const err = await svc.getContent('nasm_MISSING', ctx).catch((e) => e);
      expect(err.data?.reason).toBe('not_found');
      expect(err.data?.recovery?.hint).toBe(NOT_FOUND_RECOVERY);
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
      const svc = makeService();
      const ctx = createMockContext({ errors: smithsonianGetObject.errors });
      const err = await svc.getContent('nasm_MISSING', ctx).catch((e) => e);
      expect(err.data?.reason).toBe('not_found');
      expect(err.data?.recovery?.hint).toBe(NOT_FOUND_RECOVERY);
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
      const raw = await svc.getContent('saam_DIRECT001', ctx);
      // Asserts the envelope was unwrapped at `response`, not `response.rows[0]`
      expect(raw.title).toBe('Direct Response Object');
      expect(raw.content?.descriptiveNonRepeating?.record_ID).toBe('saam_DIRECT001');
    });
  });

  describe('toFullObject()', () => {
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

  describe('isIndexedTerm()', () => {
    const VOCAB = ['AAA', 'AAG', 'NASM', 'NMAfA'];

    it('is an exact membership test — a substring of a term is not a term', async () => {
      // The reason `contains` cannot stand in: it would report a hit for "AA".
      mockFetch({ status: 200, responseCode: 1, response: { terms: VOCAB } });
      const svc = makeService();
      const ctx = makeTenantContext();
      expect(await svc.isIndexedTerm('unit_code', 'AAA', ctx)).toBe(true);
      expect(await svc.isIndexedTerm('unit_code', 'AA', ctx)).toBe(false);
    });

    it('matches case-sensitively, as EDAN itself resolves a term', async () => {
      // NMAfA carries a lowercase f upstream; NMAFA matches nothing there, and a
      // case-insensitive check would wrongly call it indexed.
      mockFetch({ status: 200, responseCode: 1, response: { terms: VOCAB } });
      const svc = makeService();
      const ctx = makeTenantContext();
      expect(await svc.isIndexedTerm('unit_code', 'NMAfA', ctx)).toBe(true);
      expect(await svc.isIndexedTerm('unit_code', 'NMAFA', ctx)).toBe(false);
    });

    it('returns false for a value outside the vocabulary', async () => {
      mockFetch({ status: 200, responseCode: 1, response: { terms: VOCAB } });
      expect(await makeService().isIndexedTerm('unit_code', 'NOTACODE', makeTenantContext())).toBe(
        false,
      );
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

    it('shares the cached vocabulary with isIndexedTerm — the check adds no fetch', async () => {
      // The membership check runs on the recovery path of every zero-match browse
      // and search; against an uncached vocabulary it would pay a full download.
      const fetchMock = mockTermsFetch(['AAA', 'AAG', 'NASM']);
      const svc = makeService();
      const ctx = makeTenantContext();

      await svc.listTerms({ field: 'unit_code', start: 0, rows: 50 }, ctx);
      expect(await svc.isIndexedTerm('unit_code', 'AAA', ctx)).toBe(true);
      expect(await svc.isIndexedTerm('unit_code', 'NOTACODE', ctx)).toBe(false);

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
