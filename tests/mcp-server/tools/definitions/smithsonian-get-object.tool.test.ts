/**
 * @fileoverview Tests for smithsonian_get_object tool.
 * @module tests/mcp-server/tools/definitions/smithsonian-get-object.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createInMemoryStorage, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { smithsonianGetObject } from '@/mcp-server/tools/definitions/smithsonian-get-object.tool.js';
import * as svcModule from '@/services/smithsonian/smithsonian-service.js';
import type { FullObject } from '@/services/smithsonian/types.js';

function makeFullObject(id = 'nasm_TEST001'): FullObject {
  return {
    record_id: id,
    title: 'Test Object',
    unit_code: 'NASM',
    museum_name: 'National Air and Space Museum',
    dates: [{ label: 'Date', value: '1965' }],
    description: 'A historic aircraft.',
    makers: [{ role: 'Manufacturer', name: 'Lockheed' }],
    materials: ['Aluminum'],
    dimensions: ['12 m wingspan'],
    place: [{ label: 'Place of Origin', value: 'United States of America' }],
    culture: ['American'],
    topics: ['Aviation', 'Space Exploration'],
    exhibitions: [{ name: 'Milestones of Flight', building: 'Milestones of Flight Hall' }],
    credit_line: 'Transferred from NASA',
    identifiers: [{ label: 'Accession Number', value: 'A19670093000' }],
    object_rights: 'CC0',
    is_cc0: true,
    record_link: 'http://n2t.net/ark:/65665/test',
    media_summary: {
      count: 5,
      cc0_image_count: 4,
      has_cc0_images: true,
      thumbnail_url: 'https://ids.si.edu/thumb',
    },
  };
}

describe('smithsonianGetObject', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns full object for a valid ID', async () => {
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue({ content: {} }),
      toFullObject: vi.fn().mockReturnValue(makeFullObject()),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianGetObject.errors });
    const input = smithsonianGetObject.input.parse({ id: 'nasm_TEST001' });
    const result = await smithsonianGetObject.handler(input, ctx);

    expect(result.record_id).toBe('nasm_TEST001');
    expect(result.title).toBe('Test Object');
    expect(result.is_cc0).toBe(true);
    expect(result.makers).toHaveLength(1);
    expect(result.media_summary.count).toBe(5);
    expect(result.media_summary.cc0_image_count).toBe(4);
  });

  it('throws invalid_id for empty ID', async () => {
    const ctx = createMockContext({ errors: smithsonianGetObject.errors });
    const input = smithsonianGetObject.input.parse({ id: '   ' });
    const expectedHint = smithsonianGetObject.errors?.find(
      (e) => e.reason === 'invalid_id',
    )?.recovery;
    await expect(smithsonianGetObject.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id', recovery: { hint: expectedHint } },
    });
  });

  it('propagates not_found with reason and recovery from the service (issues #10, #25)', async () => {
    // The stand-in mirrors the real service throw site: it resolves the recovery from
    // the ctx the tool handed it. That proves the tool passes a contract-bound ctx down
    // and propagates the resulting data untouched onto both wire surfaces — the service
    // test verifies the real factory populates reason and hint for real.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn((_id: string, svcCtx: Context) =>
        Promise.reject(
          notFound('No Smithsonian object found for ID "nasm_MISSING".', {
            recordId: 'nasm_MISSING',
            reason: 'not_found',
            ...svcCtx.recoveryFor('not_found'),
          }),
        ),
      ),
      toFullObject: vi.fn(),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianGetObject.errors });
    const input = smithsonianGetObject.input.parse({ id: 'nasm_MISSING' });
    const expectedHint = smithsonianGetObject.errors?.find(
      (e) => e.reason === 'not_found',
    )?.recovery;
    await expect(smithsonianGetObject.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found', recovery: { hint: expectedHint } },
    });
  });

  it('format renders all key fields including record_id, title, dates, and media count', () => {
    const obj = makeFullObject();
    const blocks = smithsonianGetObject.format!(obj);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('nasm_TEST001');
    expect(text).toContain('Test Object');
    expect(text).toContain('1965');
    expect(text).toContain('Manufacturer');
    expect(text).toContain('Lockheed');
    expect(text).toContain('5 total item');
    expect(text).toContain('4 CC0 image');
    expect(text).toContain('A19670093000');
    expect(text).toContain('http://n2t.net');
  });

  it('format renders every topic — no cap — for content/structuredContent parity (issue #17)', () => {
    // 15 topics exceeds the old slice(0, 10); every one must appear in content[]
    // so the text surface matches structuredContent.topics exactly.
    const manyTopics = Array.from(
      { length: 15 },
      (_, i) => `Topic ${String(i + 1).padStart(2, '0')}`,
    );
    const obj: FullObject = { ...makeFullObject(), topics: manyTopics };
    const blocks = smithsonianGetObject.format!(obj);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    for (const topic of manyTopics) {
      expect(text).toContain(topic);
    }
    // Guard the specific regression: topics past the old 10-item boundary render.
    expect(text).toContain('Topic 11');
    expect(text).toContain('Topic 15');
  });

  it('format handles sparse object without throwing', () => {
    const sparse: FullObject = {
      record_id: 'nmnh_SPARSE',
      title: 'Sparse Object',
      unit_code: 'NMNHPALEO',
      museum_name: 'NMNH - Paleobiology Dept.',
      dates: [],
      makers: [],
      materials: [],
      dimensions: [],
      place: [],
      culture: [],
      topics: [],
      exhibitions: [],
      identifiers: [],
      is_cc0: false,
      media_summary: { count: 0, cc0_image_count: 0, has_cc0_images: false },
    };
    const blocks = smithsonianGetObject.format!(sparse);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('nmnh_SPARSE');
    expect(text).toContain('Sparse Object');
  });

  describe('upstream markup and entities (issue #49)', () => {
    // The real service over a stubbed fetch, not a stand-in: the decode happens
    // inside normalizeToFull, so only the live projection proves it reaches the
    // tool's own output and rendered text.
    beforeEach(() => {
      vi.stubEnv('SMITHSONIAN_API_KEY', 'test-key-12345');
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            status: 200,
            responseCode: 1,
            response: {
              id: 'ld1-markup',
              title: 'A nonpotential model for the Sun&#39;s open magnetic flux',
              unitCode: 'SLA_SRO',
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
                        'Yeates, A. R. 2010. "<a href="http://adsabs.harvard.edu/abs/2010JGRA">A nonpotential model</a>." <em>JGR</em> 115.',
                    },
                  ],
                },
              },
            },
          }),
        }),
      );
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(
        new svcModule.SmithsonianService(createInMemoryStorage()),
      );
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    it('returns decoded title and tag-free description', async () => {
      const ctx = createMockContext({ errors: smithsonianGetObject.errors });
      const input = smithsonianGetObject.input.parse({ id: 'slasro_92924' });
      const result = await smithsonianGetObject.handler(input, ctx);

      expect(result.title).toBe("A nonpotential model for the Sun's open magnetic flux");
      expect(result.description).toBe('Yeates, A. R. 2010. "A nonpotential model." JGR 115.');
    });

    it('renders the decoded text in format() too — both wire surfaces agree', async () => {
      const ctx = createMockContext({ errors: smithsonianGetObject.errors });
      const input = smithsonianGetObject.input.parse({ id: 'slasro_92924' });
      const result = await smithsonianGetObject.handler(input, ctx);
      const text = smithsonianGetObject.format!(result)
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('');

      expect(text).toContain("Sun's open magnetic flux");
      expect(text).not.toContain('&#39;');
      expect(text).not.toContain('<a href');
    });
  });
});
