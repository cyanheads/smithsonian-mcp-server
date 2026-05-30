/**
 * @fileoverview Tests for smithsonian_get_media tool.
 * @module tests/mcp-server/tools/definitions/smithsonian-get-media.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { smithsonianGetMedia } from '@/mcp-server/tools/definitions/smithsonian-get-media.tool.js';
import * as svcModule from '@/services/smithsonian/smithsonian-service.js';
import type { ImageItem, RawEDAN } from '@/services/smithsonian/types.js';

function makeCc0Raw(mediaCount = 1, isCC0 = true): RawEDAN {
  return {
    id: 'ld1-test',
    title: 'Test Object',
    content: {
      descriptiveNonRepeating: {
        record_ID: 'nasm_TEST001',
        metadata_usage: { access: isCC0 ? 'CC0' : 'Usage Conditions Apply' },
        online_media: {
          mediaCount,
          media:
            mediaCount > 0
              ? [
                  {
                    id: 'media:TEST',
                    idsId: 'NASM-TEST',
                    type: 'Images',
                    usage: { access: isCC0 ? 'CC0' : 'Usage Conditions Apply' },
                  },
                ]
              : [],
        },
      },
    },
  };
}

function makeCc0Image(): ImageItem {
  return {
    media_id: 'NASM-TEST001',
    is_cc0: true,
    alt_text: 'A test aircraft on display.',
    thumbnail_url: 'https://ids.si.edu/thumb',
    screen_url: 'https://ids.si.edu/screen',
    high_res_jpeg: { url: 'https://ids.si.edu/hires.jpg', width: 8000, height: 5000 },
  };
}

describe('smithsonianGetMedia', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns CC0 images for a valid CC0 object', async () => {
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue(makeCc0Raw(1, true)),
      isCC0: vi.fn().mockReturnValue(true),
      toImageItems: vi.fn().mockReturnValue([makeCc0Image()]),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianGetMedia.errors });
    const input = smithsonianGetMedia.input.parse({ id: 'nasm_TEST001' });
    const result = await smithsonianGetMedia.handler(input, ctx);

    expect(result.is_cc0).toBe(true);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.media_id).toBe('NASM-TEST001');
    expect(result.images[0]?.high_res_jpeg?.url).toContain('.jpg');
  });

  it('throws invalid_id for empty ID', async () => {
    const ctx = createMockContext({ errors: smithsonianGetMedia.errors });
    const input = smithsonianGetMedia.input.parse({ id: '  ' });
    await expect(smithsonianGetMedia.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id' },
    });
  });

  it('throws no_media when object has no online media', async () => {
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue(makeCc0Raw(0, true)),
      isCC0: vi.fn().mockReturnValue(true),
      toImageItems: vi.fn().mockReturnValue([]),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianGetMedia.errors });
    const input = smithsonianGetMedia.input.parse({ id: 'nmnh_NOMEDIA' });
    await expect(smithsonianGetMedia.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_media' },
    });
  });

  it('throws not_cc0 when object has images but none are CC0', async () => {
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue(makeCc0Raw(1, false)),
      isCC0: vi.fn().mockReturnValue(false),
      toImageItems: vi
        .fn()
        .mockReturnValue([
          { media_id: 'NASM-RESTRICTED', is_cc0: false, thumbnail_url: 'https://ids.si.edu/thumb' },
        ]),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianGetMedia.errors });
    const input = smithsonianGetMedia.input.parse({ id: 'nasm_RESTRICTED' });
    await expect(smithsonianGetMedia.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_cc0' },
    });
  });

  it('throws not_cc0 when object-level CC0=true but all per-image CC0=false (dual-level gating)', async () => {
    // Design spec: CC0 is checked at BOTH object-level (metadata_usage.access) AND
    // per-image (media[].usage.access). An object can be CC0-metadata but have restricted images.
    // The tool gates on the per-image flag — only cc0Images.length > 0 passes.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue(makeCc0Raw(2, true)), // object-level CC0=true
      isCC0: vi.fn().mockReturnValue(true), // object says CC0
      toImageItems: vi.fn().mockReturnValue([
        // Both images have per-image CC0=false — individual restriction overrides object level
        { media_id: 'NASM-IMG001', is_cc0: false },
        { media_id: 'NASM-IMG002', is_cc0: false },
      ]),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianGetMedia.errors });
    const input = smithsonianGetMedia.input.parse({ id: 'nasm_PARTIAL' });
    await expect(smithsonianGetMedia.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_cc0' },
    });
  });

  it('returns only the CC0 images when mixed CC0 and restricted images exist', async () => {
    // Partial case: some images are CC0, some aren't — only the CC0 ones should be returned
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue(makeCc0Raw(2, true)),
      isCC0: vi.fn().mockReturnValue(true),
      toImageItems: vi.fn().mockReturnValue([
        { media_id: 'NASM-IMG-CC0', is_cc0: true, thumbnail_url: 'https://ids.si.edu/thumb1' },
        { media_id: 'NASM-IMG-RESTRICTED', is_cc0: false },
      ]),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianGetMedia.errors });
    const input = smithsonianGetMedia.input.parse({ id: 'nasm_MIXED' });
    const result = await smithsonianGetMedia.handler(input, ctx);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.media_id).toBe('NASM-IMG-CC0');
    expect(result.images[0]?.is_cc0).toBe(true);
  });

  it('propagates not_found when getContent throws for an unknown ID', async () => {
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockRejectedValue(
        Object.assign(new Error('No Smithsonian object found for ID "nasm_GONE".'), {
          code: JsonRpcErrorCode.NotFound,
        }),
      ),
      isCC0: vi.fn(),
      toImageItems: vi.fn(),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianGetMedia.errors });
    const input = smithsonianGetMedia.input.parse({ id: 'nasm_GONE' });
    await expect(smithsonianGetMedia.handler(input, ctx)).rejects.toThrow(/No Smithsonian object/i);
  });

  it('image URLs use IDS (ids.si.edu) not IIIF — per design decision', () => {
    // Design spec: Smithsonian uses IDS delivery service, not IIIF manifests.
    // All image URLs should point to ids.si.edu.
    const output = {
      record_id: 'nasm_TEST001',
      title: 'Test Object',
      is_cc0: true,
      images: [
        {
          media_id: 'NASM-TEST001',
          is_cc0: true,
          thumbnail_url: 'https://ids.si.edu/ids/deliveryService?id=NASM-TEST001_thumb',
          screen_url: 'https://ids.si.edu/ids/deliveryService?id=NASM-TEST001_screen',
          high_res_jpeg: {
            url: 'https://ids.si.edu/ids/download?id=NASM-TEST001.jpg',
            width: 8000,
            height: 5000,
          },
          high_res_tiff: {
            url: 'https://ids.si.edu/ids/download?id=NASM-TEST001.tif',
            width: 8000,
            height: 5000,
          },
        },
      ],
    };
    const blocks = smithsonianGetMedia.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    // All URLs must point to ids.si.edu (IDS), not iiif.* or manifests
    expect(text).toContain('ids.si.edu');
    expect(text).not.toContain('iiif');
  });

  it('format renders media_id, CC0 status, and image URLs', () => {
    const output = {
      record_id: 'nasm_TEST001',
      title: 'Test Object',
      is_cc0: true,
      images: [makeCc0Image()],
    };
    const blocks = smithsonianGetMedia.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('nasm_TEST001');
    expect(text).toContain('NASM-TEST001');
    expect(text).toContain('.jpg');
    expect(text).toContain('https://ids.si.edu/screen');
    expect(text).toContain('A test aircraft on display.');
  });
});
