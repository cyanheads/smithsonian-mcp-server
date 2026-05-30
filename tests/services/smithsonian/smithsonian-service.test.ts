/**
 * @fileoverview Tests for SmithsonianService — HTTP layer mocked via vi.stubGlobal.
 * @module tests/services/smithsonian/smithsonian-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmithsonianService } from '@/services/smithsonian/smithsonian-service.js';
import type { RawContentResponse, RawSearchResponse } from '@/services/smithsonian/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(): SmithsonianService {
  return new SmithsonianService({} as never, {} as never);
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
    });

    it('appends api_key to the request URL', async () => {
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
      expect(calledUrl).toContain('api_key=test-key-12345');
    });

    it('appends fq params for filters', async () => {
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
        { query: 'test', rows: 5, start: 0, fq: ['unit_code:NASM', 'media_usage:CC0'] },
        ctx,
      );
      const calledUrl = (fetchMock.mock.calls[0] as [string])[0];
      expect(calledUrl).toContain('fq=unit_code%3ANASM');
      expect(calledUrl).toContain('fq=media_usage%3ACC0');
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

    it('throws notFound when response is absent', async () => {
      mockFetch({ status: 200, responseCode: 1, response: null });
      const svc = makeService();
      const ctx = createMockContext();
      await expect(svc.getContent('nasm_MISSING', ctx)).rejects.toThrow(/No Smithsonian object/i);
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
      expect(full.media_summary.has_cc0_images).toBe(true);
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
});
