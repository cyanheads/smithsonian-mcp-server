/**
 * @fileoverview Tests for smithsonian_get_object tool.
 * @module tests/mcp-server/tools/definitions/smithsonian-get-object.tool.test
 */

import { JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('propagates not_found with reason from the service (issue #10)', async () => {
    // The service throws the real notFound() factory carrying { recordId, reason }.
    // The tool must propagate that data untouched so structuredContent.error.data.reason
    // reaches the wire; the service test verifies the factory populates reason for real.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockRejectedValue(
        notFound('No Smithsonian object found for ID "nasm_MISSING".', {
          recordId: 'nasm_MISSING',
          reason: 'not_found',
        }),
      ),
      toFullObject: vi.fn(),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianGetObject.errors });
    const input = smithsonianGetObject.input.parse({ id: 'nasm_MISSING' });
    await expect(smithsonianGetObject.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
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

  it('format handles sparse object without throwing', () => {
    const sparse: FullObject = {
      record_id: 'nmnh_SPARSE',
      title: 'Sparse Object',
      unit_code: 'NMNH',
      museum_name: 'National Museum of Natural History',
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
});
