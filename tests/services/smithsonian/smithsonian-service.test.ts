/**
 * @fileoverview Tests for SmithsonianService — HTTP layer mocked via vi.stubGlobal.
 * @module tests/services/smithsonian/smithsonian-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmithsonianService } from '@/services/smithsonian/smithsonian-service.js';
import type {
  RawContentResponse,
  RawEDAN,
  RawSearchResponse,
} from '@/services/smithsonian/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(): SmithsonianService {
  return new SmithsonianService();
}

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
      const ctx = createMockContext();
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
      const ctx = createMockContext();
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
      const ctx = createMockContext();
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
      const ctx = createMockContext();
      await expect(svc.search({ query: 'test', rows: 5, start: 0 }, ctx)).rejects.toThrow(
        /API key missing/i,
      );
    });

    it('API_KEY_MISSING error-in-200 uses InternalError code — not retryable', async () => {
      mockFetch({ error: { code: 'API_KEY_MISSING', message: 'No api_key was supplied.' } });
      const svc = makeService();
      const ctx = createMockContext();
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
      const ctx = createMockContext();
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
      const ctx = createMockContext();
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
      const ctx = createMockContext();
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
      const ctx = createMockContext();
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
      const ctx = createMockContext();
      await svc.getContent('nasm_TEST001', ctx);
      const calledUrl = (fetchMock.mock.calls[0] as [string])[0];
      expect(calledUrl).toContain('edanmdm%3Anasm_TEST001');
    });

    it('throws notFound with reason "not_found" when response is absent', async () => {
      mockFetch({ status: 200, responseCode: 1, response: null });
      const svc = makeService();
      const ctx = createMockContext();
      const err = await svc.getContent('nasm_MISSING', ctx).catch((e) => e);
      expect(err.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err.message).toMatch(/No Smithsonian object/i);
      // The declared not_found contract must be carried in data (issue #10).
      expect(err.data?.reason).toBe('not_found');
      expect(err.data?.recordId).toBe('nasm_MISSING');
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
      const ctx = createMockContext();
      const err = await svc.getContent('nasm_MISSING', ctx).catch((e) => e);
      expect(err.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err.message).toMatch(/nasm_MISSING/i);
      // Live-exercised path (real HTTP 404 → real notFound factory): reason must be present.
      expect(err.data?.reason).toBe('not_found');
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
      const ctx = createMockContext();
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
      const ctx = createMockContext();
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
      const ctx = createMockContext();
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
      const ctx = createMockContext();
      const result = await svc.listTerms({ field: 'unit_code', start: 50, rows: 10 }, ctx);
      expect(result.total).toBe(2);
      expect(result.terms).toEqual([]);
    });

    it('handles an absent terms array without throwing', async () => {
      // e.g. an unsupported field returning { response: { message } } and no terms.
      mockFetch({ status: 200, responseCode: 1, response: { message: 'no terms' } });
      const svc = makeService();
      const ctx = createMockContext();
      const result = await svc.listTerms({ field: 'unit_code', start: 0, rows: 50 }, ctx);
      expect(result.total).toBe(0);
      expect(result.terms).toEqual([]);
    });
  });
});
