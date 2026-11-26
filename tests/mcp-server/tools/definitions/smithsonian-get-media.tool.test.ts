/**
 * @fileoverview Tests for smithsonian_get_media tool.
 * @module tests/mcp-server/tools/definitions/smithsonian-get-media.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
import {
  createInMemoryStorage,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadClampSwitch } from '@/config/server-config.js';
import { smithsonianGetMedia } from '@/mcp-server/tools/definitions/smithsonian-get-media.tool.js';
import { noticeTrailer } from '@/mcp-server/tools/markdown-encoders.js';
import * as svcModule from '@/services/smithsonian/smithsonian-service.js';
import type {
  ImageItem,
  ModelPackage,
  RawEDAN,
  RawMediaItem,
} from '@/services/smithsonian/types.js';
import { codeSpans, headings, images, items, labelValues, links } from '../markdown-read-back.js';
import { textOf } from './tool-result.js';

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
      getContent: vi.fn().mockResolvedValue({ record: makeCc0Raw(1, true) }),
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

  for (const branch of ['success', 'no_media', 'no_images', 'not_cc0']) {
    it.each([
      ['<I>Southern Women</I> &amp; &#39; &#x27;', "Southern Women & ' '"],
      ['&amp;#39; &lt;b&gt;', '&#39; <b>'],
      ['Depth <20 m & a > b', 'Depth <20 m & a > b'],
      [undefined, ''],
    ])(`normalizes media title once on ${branch}: %s`, async (title, expected) => {
      const raw = makeCc0Raw(branch === 'no_media' ? 0 : 1);
      if (title === undefined) delete raw.title;
      else raw.title = title;
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
        getContent: vi.fn().mockResolvedValue({ record: raw }),
        isCC0: vi.fn().mockReturnValue(true),
        toImageItems: vi
          .fn()
          .mockReturnValue(
            branch === 'no_images' ? [] : [{ ...makeCc0Image(), is_cc0: branch !== 'not_cc0' }],
          ),
        toModelPackages: vi.fn().mockReturnValue([]),
      } as unknown as svcModule.SmithsonianService);
      const result = await runToolContract(smithsonianGetMedia, { id: 'nasm_TEST001' });
      if (branch === 'success') {
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ title: expected });
        // The heading reads back as the title under CommonMark, whatever it escapes; an empty
        // title leaves the heading's own trailing space, which CommonMark trims.
        expect(headings(textOf(result))[0]).toBe(expected ? `Media: ${expected}` : 'Media:');
      } else {
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            data: { title: expected, reason: branch, recovery: { hint: expect.any(String) } },
          },
        });
        expect(result.content).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ text: expect.stringContaining(branch) }),
          ]),
        );
      }
    });
  }

  it('throws invalid_id for empty ID', async () => {
    const result = await runToolContract(smithsonianGetMedia, { id: '  ' });
    const expectedHint = smithsonianGetMedia.errors?.find(
      (e) => e.reason === 'invalid_id',
    )?.recovery;
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_id', recovery: { hint: expectedHint } } },
    });
  });

  it('throws no_media when object has no online media', async () => {
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue({ record: makeCc0Raw(0, true) }),
      isCC0: vi.fn().mockReturnValue(true),
      toImageItems: vi.fn().mockReturnValue([]),
    } as unknown as svcModule.SmithsonianService);

    const result = await runToolContract(smithsonianGetMedia, { id: 'nmnh_NOMEDIA' });
    const expectedHint = smithsonianGetMedia.errors?.find((e) => e.reason === 'no_media')?.recovery;
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'no_media', recovery: { hint: expectedHint } } },
    });
  });

  it('throws no_images when the object has media but none of it is an image (issue #34)', async () => {
    // Real siris_sil_893158 shape: mediaCount 2, both items type "Scanned books".
    // extractImageItems keeps only 'Images'/untyped, so this falls between no_media
    // (mediaCount is non-zero) and not_cc0 (there are no images to be restricted).
    const raw: RawEDAN = {
      id: 'ld1-scanned',
      title: 'Senkeiban zushiki',
      content: {
        descriptiveNonRepeating: {
          record_ID: 'siris_sil_893158',
          metadata_usage: { access: 'CC0' },
          online_media: {
            mediaCount: 2,
            media: [
              { id: 'a', type: 'Scanned books', usage: { access: 'CC0' } },
              { id: 'b', type: 'Scanned books', usage: { access: 'CC0' } },
            ],
          },
        },
      },
    };
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue({ record: raw }),
      isCC0: vi.fn().mockReturnValue(true),
      toImageItems: vi.fn().mockReturnValue([]),
      toModelPackages: vi.fn().mockReturnValue([]),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianGetMedia.errors });
    const input = smithsonianGetMedia.input.parse({ id: 'siris_sil_893158' });
    await expect(smithsonianGetMedia.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'no_images',
        media_count: 2,
        media_types: ['Scanned books'],
        record_id: 'siris_sil_893158',
      },
    });
  });

  it('no_images recovery hint names the media types present and routes a 3D package to media "3d" (issue #83)', async () => {
    // Real dpo_3d_200012 shape: a single 3d_voyager item. The hint has to name the
    // type the object DOES carry — a static hint can't, so it is built at the throw site.
    serveRecord({
      id: 'ld1-3d',
      title: 'Cassiopeia A Supernova Remnant',
      content: {
        descriptiveNonRepeating: {
          record_ID: 'dpo_3d_200012',
          metadata_usage: { access: 'CC0' },
          online_media: {
            mediaCount: 1,
            media: [{ id: '3d_package:x', type: '3d_voyager', usage: { access: 'CC0' } }],
          },
        },
      },
    });

    const ctx = createMockContext({ errors: smithsonianGetMedia.errors });
    const input = smithsonianGetMedia.input.parse({ id: 'dpo_3d_200012' });
    const err = await smithsonianGetMedia.handler(input, ctx).then(
      () => null,
      (e: unknown) => e as { data?: { recovery?: { hint?: string } } },
    );
    expect(err?.data?.recovery?.hint).toBe(
      'This object\'s online media is 3d_voyager, none of it images. Call smithsonian_get_media { id: "dpo_3d_200012", media: "3d" } for its 3D model files.',
    );
  });

  it('throws not_cc0 when object has images but none are CC0', async () => {
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue({ record: makeCc0Raw(1, false) }),
      isCC0: vi.fn().mockReturnValue(false),
      toImageItems: vi
        .fn()
        .mockReturnValue([
          { media_id: 'NASM-RESTRICTED', is_cc0: false, thumbnail_url: 'https://ids.si.edu/thumb' },
        ]),
    } as unknown as svcModule.SmithsonianService);

    const result = await runToolContract(smithsonianGetMedia, { id: 'nasm_RESTRICTED' });
    const expectedHint = smithsonianGetMedia.errors?.find((e) => e.reason === 'not_cc0')?.recovery;
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'not_cc0', recovery: { hint: expectedHint } } },
    });
  });

  it('throws not_cc0 when object-level CC0=true but all per-image CC0=false (dual-level gating)', async () => {
    // Design spec: CC0 is checked at BOTH object-level (metadata_usage.access) AND
    // per-image (media[].usage.access). An object can be CC0-metadata but have restricted images.
    // The tool gates on the per-image flag — only cc0Images.length > 0 passes.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue({ record: makeCc0Raw(2, true) }), // object-level CC0=true
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
      getContent: vi.fn().mockResolvedValue({ record: makeCc0Raw(2, true) }),
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

  it('propagates not_found with reason and recovery from the service (issues #10, #25)', async () => {
    // The stand-in mirrors the real service throw site: reason only, no recovery. The
    // framework fills this tool's declared not_found hint on the wire.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockRejectedValue(
        notFound('No Smithsonian object found for ID "nasm_GONE".', {
          recordId: 'nasm_GONE',
          reason: 'not_found',
        }),
      ),
      isCC0: vi.fn(),
      toImageItems: vi.fn(),
    } as unknown as svcModule.SmithsonianService);

    const result = await runToolContract(smithsonianGetMedia, { id: 'nasm_GONE' });
    const expectedHint = smithsonianGetMedia.errors?.find(
      (e) => e.reason === 'not_found',
    )?.recovery;
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'not_found', recovery: { hint: expectedHint } },
      },
    });
  });

  it('image URLs use IDS (ids.si.edu) not IIIF — per design decision', () => {
    // Design spec: Smithsonian uses IDS delivery service, not IIIF manifests.
    // All image URLs should point to ids.si.edu.
    const output = {
      record_id: 'nasm_TEST001',
      title: 'Test Object',
      is_cc0: true,
      cc0_image_count: 1,
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

  describe('no_images recovery routes to media_summary.non_image_media (issue #62)', () => {
    function stubService(media: NonNullable<RawEDAN['content']>['descriptiveNonRepeating']) {
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
        getContent: vi.fn().mockResolvedValue({
          record: {
            title: 'Cassiopeia A Supernova Remnant',
            content: {
              descriptiveNonRepeating: {
                record_ID: 'dpo_3d_200012',
                metadata_usage: { access: 'CC0' },
                ...media,
              },
            },
          } satisfies RawEDAN,
        }),
        isCC0: vi.fn().mockReturnValue(true),
        toImageItems: vi.fn().mockReturnValue([]),
        toModelPackages: vi.fn().mockReturnValue([]),
      } as unknown as svcModule.SmithsonianService);
    }

    it('names non_image_media, not record_link, in the runtime hint on both surfaces', async () => {
      // siris_sil_893158 carries two Scanned books items and no record_link.
      stubService({
        online_media: {
          mediaCount: 2,
          media: [
            { type: 'Scanned books', content: 'https://doi.org/10.5479/sil.893158.39088019035187' },
            {
              type: 'Scanned books',
              content: 'https://biodiversitylibrary.org/bibliography/179335',
            },
          ],
        },
      });
      const result = await runToolContract(smithsonianGetMedia, { id: 'siris_sil_893158' });
      const hint = (
        result.structuredContent as {
          error?: { data?: { reason?: string; recovery?: { hint?: string } } };
        }
      ).error?.data;
      expect(hint?.reason).toBe('no_images');
      // The release's hint for media with no 3D package, unchanged.
      expect(hint?.recovery?.hint).toBe(
        'This object\'s online media is Scanned books, which smithsonian_get_media does not deliver. Call smithsonian_get_object { id: "siris_sil_893158" } and read media_summary.non_image_media for each item\'s link.',
      );
      expect(textOf(result)).toContain(`Recovery: ${hint?.recovery?.hint}`);
      expect(textOf(result)).not.toContain('record_link');
    });

    it('names non_image_media, not record_link, in the declared recovery on both surfaces', async () => {
      // Untyped items with no media id: nothing normalizes to an image and no type
      // can be named, so the declared recovery is what reaches the caller.
      stubService({ online_media: { mediaCount: 1, media: [{}] } });
      const declared = smithsonianGetMedia.errors?.find((e) => e.reason === 'no_images')?.recovery;
      expect(declared).toContain('media_summary.non_image_media');
      expect(declared).not.toContain('record_link');

      const result = await runToolContract(smithsonianGetMedia, { id: 'dpo_3d_200012' });
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'no_images', recovery: { hint: declared } } },
      });
      expect(textOf(result)).toContain('media_summary.non_image_media');
    });

    it('no longer cites sound recordings, which carry no media items and end at no_media', () => {
      const entry = smithsonianGetMedia.errors?.find((e) => e.reason === 'no_images');
      expect(entry?.when).not.toMatch(/sound recording/i);
      expect(smithsonianGetMedia.description).not.toMatch(/sound recording/i);
    });
  });

  it('format renders media_id, CC0 status, and image URLs', () => {
    const output = {
      record_id: 'nasm_TEST001',
      title: 'Test Object',
      is_cc0: true,
      cc0_image_count: 1,
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

/**
 * Serve `raw` through the real normalization and CC0 tests: only the record read is stubbed,
 * so the images and model packages the tool pages are the ones the service builds.
 */
function serveRecord(raw: RawEDAN) {
  const real = new svcModule.SmithsonianService(createInMemoryStorage());
  const getContent = vi.spyOn(real, 'getContent').mockResolvedValue({ record: raw });
  vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(real);
  return { real, getContent };
}

/** A CC0 record whose media is `media`, counted as given. */
function mediaRecord(media: RawMediaItem[]): RawEDAN {
  return {
    title: "Dyer's record book",
    content: {
      descriptiveNonRepeating: {
        record_ID: 'chndm_1945-55-16',
        metadata_usage: { access: 'CC0' },
        online_media: { mediaCount: media.length, media },
      },
    },
  };
}

/** `count` CC0 images in catalog order, IMG-0 first, shaped like chndm_1945-55-16's. */
function cc0Images(count: number): RawMediaItem[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'Images',
    idsId: `IMG-${i}`,
    content: `https://ids.si.edu/ids/deliveryService?id=IMG-${i}`,
    usage: { access: 'CC0' },
    altTextAccessibility: '',
  }));
}

/** The fields these tests read off a successful `structuredContent`. */
interface MediaPage {
  cap?: number;
  cc0_image_count?: number;
  images?: ImageItem[];
  notice?: string;
  shown?: number;
  truncated?: boolean;
  truncationCeiling?: number;
}

const pageOf = (result: { structuredContent?: unknown }) => result.structuredContent as MediaPage;
const idsOf = (result: { structuredContent?: unknown }) =>
  pageOf(result).images?.map((img) => img.media_id);

describe('paging the CC0 images with start and limit (issue #76)', () => {
  const ID = 'chndm_1945-55-16';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    loadClampSwitch();
  });

  it('limit 5 returns the first 5 of 229 and names start 5 in the truncation notice', async () => {
    serveRecord(mediaRecord(cc0Images(229)));

    const result = await runToolContract(smithsonianGetMedia, { id: ID, limit: 5 });

    expect(result.isError).not.toBe(true);
    expect(idsOf(result)).toEqual(['IMG-0', 'IMG-1', 'IMG-2', 'IMG-3', 'IMG-4']);
    expect(result.structuredContent).toMatchObject({
      cc0_image_count: 229,
      truncated: true,
      shown: 5,
      cap: 5,
      truncationCeiling: 229,
    });
    const notice =
      '229 CC0 images; this page shows 5 from start 0. Retrieve the next page with start: 5, or omit limit to return every remaining image.';
    expect(pageOf(result).notice).toBe(notice);
    expect(textOf(result)).toContain('**Images:** 5 of 229 CC0 image(s)');
    expect(textOf(result)).toContain(notice);
  });

  it('start 225 returns the last 4 images with no truncation', async () => {
    serveRecord(mediaRecord(cc0Images(229)));

    const result = await runToolContract(smithsonianGetMedia, { id: ID, start: 225 });

    expect(idsOf(result)).toEqual(['IMG-225', 'IMG-226', 'IMG-227', 'IMG-228']);
    expect(pageOf(result).cc0_image_count).toBe(229);
    expect(result.structuredContent).not.toHaveProperty('truncated');
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(textOf(result)).toContain('**Images:** 4 of 229 CC0 image(s)');
  });

  it('a page that ends on the last image is not truncated', async () => {
    serveRecord(mediaRecord(cc0Images(229)));

    const result = await runToolContract(smithsonianGetMedia, { id: ID, start: 224, limit: 5 });

    expect(idsOf(result)).toEqual(['IMG-224', 'IMG-225', 'IMG-226', 'IMG-227', 'IMG-228']);
    expect(result.structuredContent).not.toHaveProperty('truncated');
  });

  it('an omitted limit returns every image, as calls without paging always have', async () => {
    serveRecord(mediaRecord(cc0Images(229)));

    const result = await runToolContract(smithsonianGetMedia, { id: ID });

    expect(pageOf(result).images).toHaveLength(229);
    expect(pageOf(result).cc0_image_count).toBe(229);
    expect(result.structuredContent).not.toHaveProperty('truncated');
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(textOf(result)).toContain('**Images:** 229 of 229 CC0 image(s)');
  });

  it.each([229, 500])(
    'start %d, at or past the last image, returns no images and the count, with no error or notice',
    async (start) => {
      serveRecord(mediaRecord(cc0Images(229)));

      const result = await runToolContract(smithsonianGetMedia, { id: ID, start });

      expect(result.isError).not.toBe(true);
      expect(pageOf(result).images).toEqual([]);
      expect(pageOf(result).cc0_image_count).toBe(229);
      expect(result.structuredContent).not.toHaveProperty('truncated');
      expect(result.structuredContent).not.toHaveProperty('notice');
      expect(textOf(result)).toContain('**Images:** 0 of 229 CC0 image(s)');
    },
  );

  it('serves a limit over the cap at 1,000, the clamp sentence leading the notice', async () => {
    serveRecord(mediaRecord(cc0Images(1001)));

    const result = await runToolContract(smithsonianGetMedia, { id: ID, limit: 1500 });

    expect(pageOf(result).images).toHaveLength(1000);
    expect(result.structuredContent).toMatchObject({
      cc0_image_count: 1001,
      truncated: true,
      shown: 1000,
      cap: 1000,
      truncationCeiling: 1001,
    });
    expect(pageOf(result).notice).toBe(
      'limit 1500 exceeds the cap of 1000; the page was served with limit 1000. 1001 CC0 images; this page shows 1000 from start 0. Retrieve the next page with start: 1000, or omit limit to return every remaining image.',
    );
  });

  it('a clamped limit on a shorter list carries the clamp sentence alone', async () => {
    serveRecord(mediaRecord(cc0Images(229)));

    const result = await runToolContract(smithsonianGetMedia, { id: ID, limit: 1500 });

    expect(pageOf(result).images).toHaveLength(229);
    expect(pageOf(result).notice).toBe(
      'limit 1500 exceeds the cap of 1000; the page was served with limit 1000.',
    );
    expect(result.structuredContent).not.toHaveProperty('truncated');
  });

  it('rejects a limit over the cap under SMITHSONIAN_CLAMP_LIMITS=false, before reading the record', async () => {
    vi.stubEnv('SMITHSONIAN_CLAMP_LIMITS', 'false');
    loadClampSwitch();
    const { getContent } = serveRecord(mediaRecord(cc0Images(229)));

    const result = await runToolContract(smithsonianGetMedia, { id: ID, limit: 1500 });

    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(textOf(result)).toContain('limit');
    expect(getContent).not.toHaveBeenCalled();
  });

  it.each([{ start: -1 }, { start: 1.5 }, { limit: 0 }, { limit: 2.5 }])(
    'rejects %o as invalid_arguments, before reading the record',
    async (paging) => {
      const { getContent } = serveRecord(mediaRecord(cc0Images(3)));

      const result = await runToolContract(smithsonianGetMedia, { id: ID, ...paging });

      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
      });
      expect(getContent).not.toHaveBeenCalled();
    },
  );

  const NOTHING_TO_PAGE: Array<[reason: string, media: RawMediaItem[]]> = [
    ['no_media', []],
    [
      'no_images',
      [{ type: 'Scanned books', content: 'https://doi.org/10.5479/sil.893158', usage: {} }],
    ],
    ['not_cc0', [{ type: 'Images', idsId: 'R-1', usage: { access: 'Usage Conditions Apply' } }]],
  ];

  it.each(NOTHING_TO_PAGE)(
    'fails %s from the whole record, whatever start is',
    async (reason, media) => {
      for (const start of [0, 3, 500]) {
        serveRecord(mediaRecord(media));
        const result = await runToolContract(smithsonianGetMedia, { id: ID, start, limit: 1 });
        expect(result.structuredContent).toMatchObject({ error: { data: { reason } } });
      }
    },
  );

  /** CC0 images A, C, D among a restricted image, an image with no id, and a 3D package. */
  const MIXED: RawMediaItem[] = [
    { type: 'Images', idsId: 'A', usage: { access: 'CC0' } },
    { type: 'Images', idsId: 'B', usage: { access: 'Usage Conditions Apply' } },
    { type: 'Images', usage: { access: 'CC0' } },
    { type: 'Images', idsId: 'C', usage: { access: 'CC0' } },
    { type: '3d_voyager', content: 'https://3d-api.si.edu/voyager/x', usage: { access: 'CC0' } },
    { idsId: 'D', usage: { access: 'CC0' } },
  ];

  it('pages the CC0 images only, in catalog order', async () => {
    serveRecord(mediaRecord(MIXED));

    const second = await runToolContract(smithsonianGetMedia, { id: ID, start: 1, limit: 1 });
    expect(idsOf(second)).toEqual(['C']);
    expect(pageOf(second)).toMatchObject({ cc0_image_count: 3, truncated: true });
    expect(pageOf(second).notice).toContain('start: 2');

    const last = await runToolContract(smithsonianGetMedia, { id: ID, start: 2, limit: 1 });
    expect(idsOf(last)).toEqual(['D']);
    expect(last.structuredContent).not.toHaveProperty('truncated');
  });

  it("reports the same cc0_image_count as smithsonian_get_object's media_summary", async () => {
    const raw = mediaRecord(MIXED);
    const { real } = serveRecord(raw);

    const result = await runToolContract(smithsonianGetMedia, { id: ID, limit: 1 });

    expect(pageOf(result).cc0_image_count).toBe(3);
    expect(pageOf(result).cc0_image_count).toBe(
      real.toFullObject(raw).media_summary.cc0_image_count,
    );
  });

  /** The advertised input schema, as `tools/list` emits it. */
  const advertised = () =>
    z.toJSONSchema(smithsonianGetMedia.input, { io: 'input' }) as {
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
    };

  it('advertises start and an optional limit with no maximum while clamping is on', () => {
    const schema = advertised();
    expect(schema.properties.start).toMatchObject({ type: 'integer', minimum: 0, default: 0 });
    expect(schema.properties.limit).toMatchObject({ type: 'integer', minimum: 1 });
    expect(schema.properties.limit).not.toHaveProperty('maximum');
    expect(schema.required).toEqual(['id']);
  });

  it('advertises the limit cap as the schema maximum under SMITHSONIAN_CLAMP_LIMITS=false', () => {
    vi.stubEnv('SMITHSONIAN_CLAMP_LIMITS', 'false');
    loadClampSwitch();
    expect(advertised().properties.limit).toMatchObject({ type: 'integer', maximum: 1000 });
  });
});

describe('full-size JPEG on both surfaces (issue #71)', () => {
  const NASM_ID = 'NASM-NASM2022-05013-000003';
  const NASM_CONTENT = `https://ids.si.edu/ids/deliveryService?id=${NASM_ID}`;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a JPEG taken from content with no size suffix, and no empty Alt line (nasm_A19700102000)', async () => {
    serveRecord(
      mediaRecord([
        {
          type: 'Images',
          idsId: NASM_ID,
          content: NASM_CONTENT,
          usage: { access: 'CC0' },
          altTextAccessibility: '',
          extDescrAccessibility: 'The Apollo 11 Command Module Columbia displayed in a gallery.',
          resources: [
            { label: 'Screen Image', url: `https://ids.si.edu/ids/download?id=${NASM_ID}_screen` },
            {
              label: 'Thumbnail Image',
              url: `https://ids.si.edu/ids/download?id=${NASM_ID}_thumb`,
            },
          ],
        },
      ]),
    );

    const result = await runToolContract(smithsonianGetMedia, { id: 'nasm_A19700102000' });

    const image = pageOf(result).images?.[0];
    expect(image?.high_res_jpeg).toEqual({ url: NASM_CONTENT });
    expect(image).not.toHaveProperty('alt_text');
    const lines = textOf(result).split('\n');
    expect(lines).toContain(`**JPEG:** [Full-size JPEG](<${NASM_CONTENT}>)`);
    expect(lines.some((line) => line.startsWith('**Alt:**'))).toBe(false);
  });

  it('keeps the size suffix on a JPEG the catalog lists', async () => {
    const id = 'NPG-NPG_94_15BoydenM_int';
    serveRecord(
      mediaRecord([
        {
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
        },
      ]),
    );

    const result = await runToolContract(smithsonianGetMedia, { id: 'npg_NPG.94.15' });

    expect(textOf(result).split('\n')).toContain(
      `**JPEG:** [Full-size JPEG](<https://ids.si.edu/ids/download?id=${id}.jpg>) (4000×2322px)`,
    );
  });
});

describe('smithsonianGetMedia content[] encoding (issue #70)', () => {
  const render = (images: ImageItem[], title = 'Pattern book') =>
    smithsonianGetMedia.format!({
      record_id: 'nmah_`1`',
      title,
      is_cc0: true,
      cc0_image_count: images.length,
      images,
    })
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');

  it('renders a description with a blank line as hard breaks that read back as the value', () => {
    const description = 'Book of woven designs.\n\n72 pages of samples.';
    const text = render([{ ...makeCc0Image(), description }]);
    expect(text).toContain('**Description:** Book of woven designs.\\\n\\\n72 pages of samples.\n');
    expect(labelValues(text, 'Description')).toEqual([description]);
  });

  it('reads the title, IDs, text, and every URL back under CommonMark', () => {
    const image: ImageItem = {
      media_id: 'NMAH-<1>_*a*',
      is_cc0: true,
      alt_text: 'Patterned *silk* <swatch>',
      thumbnail_url: 'https://ids.si.edu/ids/deliveryService?id=NMAH-1&max=150',
      screen_url: 'https://ids.si.edu/ids/deliveryService?id=NMAH-1&max=1200',
      high_res_jpeg: {
        url: 'https://ids.si.edu/ids/download?id=NMAH-1.jpg',
        width: 4000,
        height: 2322,
      },
      high_res_tiff: { url: 'https://ids.si.edu/ids/download?id=NMAH-1.tif' },
    };
    const title = 'Trees and Flowers in Washington, \nDC';
    const text = render([image], title);

    expect(text.split('\n')[0]).toBe('# Media: Trees and Flowers in Washington,&#32;&#10;DC');
    expect(headings(text)).toEqual([`Media: ${title}`, `Image: ${image.media_id}`]);
    expect(codeSpans(text)).toEqual(['nmah_`1`']);
    expect(labelValues(text, 'Alt')).toEqual([image.alt_text]);
    expect(images(text).map((img) => img.url)).toEqual([image.thumbnail_url]);
    expect(links(text).map((link) => link.url)).toEqual([
      image.screen_url,
      image.high_res_jpeg?.url,
      image.high_res_tiff?.url,
    ]);
    expect(labelValues(text, 'JPEG')).toEqual(['Full-size JPEG (4000×2322px)']);
  });

  it('renders its notice through the escaping trailer', () => {
    expect(smithsonianGetMedia.enrichmentTrailer?.notice).toBe(noticeTrailer);
  });
});

/** A 3D package shaped like the CC0 `3d_voyager` items of nmnhvz_7047834. */
function voyagerPackage(uuid: string, access = 'CC0'): RawMediaItem {
  const doc = `https://3d-api.si.edu/content/document/3d_package:${uuid}`;
  return {
    id: `3d_package:${uuid}`,
    type: '3d_voyager',
    content: `https://3d-api.si.edu/voyager/3d_package:${uuid}`,
    thumbnail: `${doc}/scene-image-thumb.jpg`,
    usage: { access },
    resources: [
      {
        url: `${doc}/resources/skull-150k-4096_std.glb`,
        category: 'Low resolution',
        filename: 'skull-150k-4096_std.glb',
        attributes: [
          { UNITS: 'mm', FILE_TYPE: 'glb', MODEL_FILE_TYPE: 'glb', DRACO_COMPRESSED: false },
          { FILE_SIZE: 9214208 },
        ],
      },
    ],
  };
}

/**
 * Mixed media like nmnhvz_7047834's — images among 3D packages — with the image fields
 * that render differently on each surface: markup in the title, accessibility text that needs
 * escaping, every resolution, and a restricted image the CC0 gate drops.
 */
function mixedRecord(): RawEDAN {
  const ids = (n: number) => `https://ids.si.edu/ids/deliveryService?id=NMNH-2024-0000${n}`;
  return {
    title: 'Tamias striatus <i>skull</i> &amp; mandible',
    content: {
      descriptiveNonRepeating: {
        record_ID: 'nmnhvz_7047834',
        metadata_usage: { access: 'CC0' },
        online_media: {
          mediaCount: 6,
          media: [
            voyagerPackage('0b46b532-888e-419b-bb18-c6b8dd1cec6c'),
            {
              id: 'media:NMNH-2024-00001',
              idsId: 'NMNH-2024-00001',
              type: 'Images',
              content: ids(1),
              thumbnail: ids(1),
              usage: { access: 'CC0' },
              altTextAccessibility: 'Skull of *Tamias*, <dorsal> view',
              resources: [
                { label: 'Screen Image', url: `${ids(1)}&max=1200` },
                { label: 'Thumbnail Image', url: `${ids(1)}&max=150` },
                {
                  label: 'High-resolution JPEG',
                  url: 'https://ids.si.edu/ids/download?id=NMNH-2024-00001.jpg',
                  width: 4000,
                  height: 2667,
                },
                {
                  label: 'High-resolution TIFF',
                  url: 'https://ids.si.edu/ids/download?id=NMNH-2024-00001.tif',
                },
              ],
            },
            {
              idsId: 'NMNH-2024-00002',
              type: 'Images',
              content: ids(2),
              usage: { access: 'CC0' },
              extDescrAccessibility: 'Lateral view.\n\nScale bar 10 mm.',
            },
            {
              idsId: 'NMNH-2024-00003',
              type: 'Images',
              usage: { access: 'Usage Conditions Apply' },
            },
            voyagerPackage('732d123d-7a35-411b-a4e1-5e355adcacf8'),
            { idsId: 'NMNH-2024-00004', type: 'Images', content: ids(4), usage: { access: 'CC0' } },
          ],
        },
      },
    },
  };
}

/** Images that are all restricted beside a CC0 3D package: images mode fails not_cc0. */
function restrictedRecord(): RawEDAN {
  return {
    title: 'Patent model',
    content: {
      descriptiveNonRepeating: {
        record_ID: 'nmah_RESTRICTED',
        metadata_usage: { access: 'CC0' },
        online_media: {
          mediaCount: 3,
          media: [
            { idsId: 'NMAH-R1', type: 'Images', usage: { access: 'Usage Conditions Apply' } },
            { idsId: 'NMAH-R2', type: 'Images', usage: { access: 'Usage Conditions Apply' } },
            voyagerPackage('c0bc58e6-b172-4543-ad58-50261aea523c'),
          ],
        },
      },
    },
  };
}

/** A record with nothing digitized. */
function bareRecord(): RawEDAN {
  return {
    title: 'Field notes',
    content: {
      descriptiveNonRepeating: {
        record_ID: 'nmnhvz_5105499',
        metadata_usage: { access: 'CC0' },
        online_media: { mediaCount: 0, media: [] },
      },
    },
  };
}

/**
 * Images-mode output as the release before the `media` input (0.4.1) wrote it: an image page, a
 * truncated page, a page past the end, and the no_media and not_cc0 failures. Each row is the
 * record, the paging, `structuredContent` as an object whose key order is its JSON, and the
 * `content[]` text.
 *
 * Every row matches 0.4.1 byte for byte except not_cc0, which holds this release's declared
 * recovery: `smithsonian_search_objects { query: "", filters: { cc0_only: true } }`, a call that
 * runs as written. 0.4.1 wrote "Use smithsonian_search_objects with filters.cc0_only: true to find
 * CC0 objects with downloadable images.", a call that fails as written because `query` is
 * required. no_images has no row: its hint for a 3D object now names the `media: "3d"` call
 * (#83), so it no longer matches 0.4.1.
 */
const RELEASED_IMAGES_MODE: Array<
  [name: string, record: () => RawEDAN, paging: object, structured: object, text: string]
> = [
  [
    'every image of a mixed record',
    mixedRecord,
    {},
    {
      record_id: 'nmnhvz_7047834',
      title: 'Tamias striatus skull & mandible',
      is_cc0: true,
      cc0_image_count: 3,
      images: [
        {
          media_id: 'NMNH-2024-00001',
          is_cc0: true,
          alt_text: 'Skull of *Tamias*, <dorsal> view',
          thumbnail_url: 'https://ids.si.edu/ids/deliveryService?id=NMNH-2024-00001&max=150',
          screen_url: 'https://ids.si.edu/ids/deliveryService?id=NMNH-2024-00001&max=1200',
          high_res_jpeg: {
            url: 'https://ids.si.edu/ids/download?id=NMNH-2024-00001.jpg',
            width: 4000,
            height: 2667,
          },
          high_res_tiff: { url: 'https://ids.si.edu/ids/download?id=NMNH-2024-00001.tif' },
        },
        {
          media_id: 'NMNH-2024-00002',
          is_cc0: true,
          description: 'Lateral view.\n\nScale bar 10 mm.',
          screen_url: 'https://ids.si.edu/ids/deliveryService?id=NMNH-2024-00002',
          high_res_jpeg: { url: 'https://ids.si.edu/ids/deliveryService?id=NMNH-2024-00002' },
        },
        {
          media_id: 'NMNH-2024-00004',
          is_cc0: true,
          screen_url: 'https://ids.si.edu/ids/deliveryService?id=NMNH-2024-00004',
          high_res_jpeg: { url: 'https://ids.si.edu/ids/deliveryService?id=NMNH-2024-00004' },
        },
      ],
    },
    [
      '# Media: Tamias striatus skull & mandible',
      '**ID:** `nmnhvz_7047834` | **Object CC0:** Yes',
      '**Images:** 3 of 3 CC0 image(s)',
      '',
      '### Image: NMNH-2024-00001',
      '**CC0:** Yes',
      '**Alt:** Skull of \\*Tamias\\*, \\<dorsal> view',
      '**Thumbnail:** ![Thumbnail](<https://ids.si.edu/ids/deliveryService?id=NMNH-2024-00001&max=150>)',
      '**Screen:** [Screen size](<https://ids.si.edu/ids/deliveryService?id=NMNH-2024-00001&max=1200>)',
      '**JPEG:** [Full-size JPEG](<https://ids.si.edu/ids/download?id=NMNH-2024-00001.jpg>) (4000×2667px)',
      '**TIFF:** [Archival TIFF](<https://ids.si.edu/ids/download?id=NMNH-2024-00001.tif>)',
      '### Image: NMNH-2024-00002',
      '**CC0:** Yes',
      '**Description:** Lateral view.\\',
      '\\',
      'Scale bar 10 mm.',
      '**Screen:** [Screen size](<https://ids.si.edu/ids/deliveryService?id=NMNH-2024-00002>)',
      '**JPEG:** [Full-size JPEG](<https://ids.si.edu/ids/deliveryService?id=NMNH-2024-00002>)',
      '### Image: NMNH-2024-00004',
      '**CC0:** Yes',
      '**Screen:** [Screen size](<https://ids.si.edu/ids/deliveryService?id=NMNH-2024-00004>)',
      '**JPEG:** [Full-size JPEG](<https://ids.si.edu/ids/deliveryService?id=NMNH-2024-00004>)',
    ].join('\n'),
  ],
  [
    'a truncated page',
    mixedRecord,
    { start: 1, limit: 1 },
    {
      record_id: 'nmnhvz_7047834',
      title: 'Tamias striatus skull & mandible',
      is_cc0: true,
      cc0_image_count: 3,
      images: [
        {
          media_id: 'NMNH-2024-00002',
          is_cc0: true,
          description: 'Lateral view.\n\nScale bar 10 mm.',
          screen_url: 'https://ids.si.edu/ids/deliveryService?id=NMNH-2024-00002',
          high_res_jpeg: { url: 'https://ids.si.edu/ids/deliveryService?id=NMNH-2024-00002' },
        },
      ],
      truncated: true,
      shown: 1,
      cap: 1,
      truncationCeiling: 3,
      notice:
        '3 CC0 images; this page shows 1 from start 1. Retrieve the next page with start: 2, or omit limit to return every remaining image.',
    },
    [
      '# Media: Tamias striatus skull & mandible',
      '**ID:** `nmnhvz_7047834` | **Object CC0:** Yes',
      '**Images:** 1 of 3 CC0 image(s)',
      '',
      '### Image: NMNH-2024-00002',
      '**CC0:** Yes',
      '**Description:** Lateral view.\\',
      '\\',
      'Scale bar 10 mm.',
      '**Screen:** [Screen size](<https://ids.si.edu/ids/deliveryService?id=NMNH-2024-00002>)',
      '**JPEG:** [Full-size JPEG](<https://ids.si.edu/ids/deliveryService?id=NMNH-2024-00002>)',
      '',
      '',
      '**truncated:** true',
      '**shown:** 1',
      '**cap:** 1',
      '**truncationCeiling:** 3',
      '> 3 CC0 images; this page shows 1 from start 1. Retrieve the next page with start: 2, or omit limit to return every remaining image.',
    ].join('\n'),
  ],
  [
    'a start past the last image',
    mixedRecord,
    { start: 9 },
    {
      record_id: 'nmnhvz_7047834',
      title: 'Tamias striatus skull & mandible',
      is_cc0: true,
      cc0_image_count: 3,
      images: [],
    },
    [
      '# Media: Tamias striatus skull & mandible',
      '**ID:** `nmnhvz_7047834` | **Object CC0:** Yes',
      '**Images:** 0 of 3 CC0 image(s)',
      '',
    ].join('\n'),
  ],
  [
    'no_media',
    bareRecord,
    {},
    {
      error: {
        code: -32001,
        message: 'Object "nmnhvz_5105499" has no digitized online media.',
        data: {
          record_id: 'nmnhvz_5105499',
          title: 'Field notes',
          reason: 'no_media',
          recovery: {
            hint: 'The physical object may not have been digitized. Use smithsonian_search_objects to find similar objects with media.',
          },
        },
      },
    },
    [
      'Error: Object "nmnhvz_5105499" has no digitized online media.',
      '',
      'Recovery: The physical object may not have been digitized. Use smithsonian_search_objects to find similar objects with media.',
      '',
      '(reason no_media)',
    ].join('\n'),
  ],
  [
    'not_cc0 beside a CC0 3D package',
    restrictedRecord,
    { start: 2, limit: 1 },
    {
      error: {
        code: -32005,
        message: 'Object "nmah_RESTRICTED" has 2 image(s) but none are CC0 open access.',
        data: {
          record_id: 'nmah_RESTRICTED',
          title: 'Patent model',
          image_count: 2,
          reason: 'not_cc0',
          recovery: {
            hint: 'Use smithsonian_search_objects { query: "", filters: { cc0_only: true } } to find CC0 objects with downloadable images.',
          },
        },
      },
    },
    [
      'Error: Object "nmah_RESTRICTED" has 2 image(s) but none are CC0 open access.',
      '',
      'Recovery: Use smithsonian_search_objects { query: "", filters: { cc0_only: true } } to find CC0 objects with downloadable images.',
      '',
      '(reason not_cc0)',
    ].join('\n'),
  ],
];

describe('images mode is byte-identical to the release before the media input (issue #83)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each(RELEASED_IMAGES_MODE)(
    '%s, with media omitted',
    async (_name, record, paging, structured, text) => {
      const raw = record();
      serveRecord(raw);

      const result = await runToolContract(smithsonianGetMedia, {
        id: raw.content?.descriptiveNonRepeating?.record_ID ?? '',
        ...paging,
      });

      expect(JSON.stringify(result.structuredContent)).toBe(JSON.stringify(structured));
      expect(textOf(result)).toBe(text);
    },
  );

  it.each(RELEASED_IMAGES_MODE)(
    '%s, with media: "images"',
    async (_name, record, paging, structured, text) => {
      const raw = record();
      serveRecord(raw);

      const result = await runToolContract(smithsonianGetMedia, {
        id: raw.content?.descriptiveNonRepeating?.record_ID ?? '',
        media: 'images',
        ...paging,
      });

      expect(JSON.stringify(result.structuredContent)).toBe(JSON.stringify(structured));
      expect(textOf(result)).toBe(text);
    },
  );
});

// ---------------------------------------------------------------------------
// media: "3d" (issue #83)
// ---------------------------------------------------------------------------

/** A CC0 record `recordId` titled `title` whose media is `media`, counted as given. */
function modelRecord(recordId: string, title: string, media: RawMediaItem[]): RawEDAN {
  return {
    title,
    content: {
      descriptiveNonRepeating: {
        record_ID: recordId,
        metadata_usage: { access: 'CC0' },
        online_media: { mediaCount: media.length, media },
      },
    },
  };
}

const VOYAGER = 'https://3d-api.si.edu/voyager';
const DOCUMENT = 'https://3d-api.si.edu/content/document';
const HESPEROCYON = '3d_package:0b46b532-888e-419b-bb18-c6b8dd1cec6c';

/** nmnhpaleobiology_13278478's one package and its six files, every attribute in one object. */
function hesperocyon(): RawEDAN {
  const file = (filename: string, category: string, fileType: string, model: string) => ({
    url: `${DOCUMENT}/${HESPEROCYON}/resources/${filename}`,
    name: 'Hesperocyon sp',
    type: '3D mesh',
    category,
    filename,
    attributes: [
      {
        UNITS: 'm',
        FILE_TYPE: fileType,
        MODEL_FILE_TYPE: model,
        DRACO_COMPRESSED: filename.endsWith('_draco.glb'),
      },
    ],
  });
  return modelRecord('nmnhpaleobiology_13278478', 'Hesperocyon sp', [
    {
      id: HESPEROCYON,
      type: '3d_voyager',
      usage: { access: 'CC0' },
      content: `${VOYAGER}/${HESPEROCYON}`,
      thumbnail: `${DOCUMENT}/${HESPEROCYON}/Hesperocyon_sp-image-thumb.jpg`,
      resources: [
        file('Hesperocyon_sp-150k-4096_std.glb', 'Low resolution', 'glb', 'glb'),
        file('Hesperocyon_sp-100k-2048_std_draco.glb', 'Low resolution', 'glb', 'glb'),
        file('Hesperocyon_sp-100k-2048_std.usdz', 'iOS AR model', 'usdz', 'usdz'),
        file('Hesperocyon_sp-full_resolution-obj_std.zip', 'Full resolution', 'zip', 'obj'),
        file('Hesperocyon_sp-150k-4096-gltf_std.zip', 'Low resolution', 'zip', 'gltf'),
        file('Hesperocyon_sp-150k-4096-obj_std.zip', 'Low resolution', 'zip', 'obj'),
      ],
    },
  ]);
}

/** nmnhvz_7047834: 13 CC0 images and 49 CC0 packages of one file each, interleaved. */
function gorilla(): RawEDAN {
  const media: RawMediaItem[] = [];
  for (let i = 0; i < 49; i++) {
    const id = `3d_package:gorilla-${i}`;
    media.push({
      id,
      type: '3d_voyager',
      usage: { access: 'CC0' },
      content: `${VOYAGER}/${id}`,
      thumbnail: `${DOCUMENT}/${id}/scene-image-thumb.jpg`,
      resources: [
        {
          url: `${DOCUMENT}/${id}/resources/USNM395636_bone_${i}.ply`,
          category: 'Full resolution',
          filename: `USNM395636_bone_${i}.ply`,
          attributes: [
            { UNITS: 'mm' },
            { MODEL_FILE_TYPE: 'ply' },
            { FILE_TYPE: 'ply' },
            { FILE_SIZE: 19025414 + i },
          ],
        },
      ],
    });
    if (i < 13) {
      media.push({
        idsId: `NMNH-GORILLA-${i}`,
        type: 'Images',
        content: `https://ids.si.edu/ids/deliveryService?id=NMNH-GORILLA-${i}`,
        usage: { access: 'CC0' },
      });
    }
  }
  return modelRecord('nmnhvz_7047834', 'Gorilla beringei beringei', media);
}

/** The fields these tests read off a successful 3D-mode `structuredContent`. */
interface ModelPage extends MediaPage {
  cc0_model_count?: number;
  models?: ModelPackage[];
}

const modelsOf = (result: { structuredContent?: unknown }) => result.structuredContent as ModelPage;

describe('media: "3d" returns CC0 model packages and their files (issue #83)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    loadClampSwitch();
  });

  it('returns nmnhpaleobiology_13278478 as one model with its viewer and six files on both surfaces', async () => {
    serveRecord(hesperocyon());

    const result = await runToolContract(smithsonianGetMedia, {
      id: 'nmnhpaleobiology_13278478',
      media: '3d',
    });

    expect(result.isError).not.toBe(true);
    const page = modelsOf(result);
    expect(page).toMatchObject({ images: [], cc0_image_count: 0, cc0_model_count: 1 });
    expect(page.models).toHaveLength(1);
    const model = page.models?.[0];
    expect(model).toMatchObject({
      media_id: HESPEROCYON,
      is_cc0: true,
      viewer_url: `${VOYAGER}/${HESPEROCYON}`,
      thumbnail_url: `${DOCUMENT}/${HESPEROCYON}/Hesperocyon_sp-image-thumb.jpg`,
    });
    expect(model?.files.map((f) => f.filename)).toEqual([
      'Hesperocyon_sp-150k-4096_std.glb',
      'Hesperocyon_sp-100k-2048_std_draco.glb',
      'Hesperocyon_sp-100k-2048_std.usdz',
      'Hesperocyon_sp-full_resolution-obj_std.zip',
      'Hesperocyon_sp-150k-4096-gltf_std.zip',
      'Hesperocyon_sp-150k-4096-obj_std.zip',
    ]);
    expect(model?.files.every((f) => f.units === 'm')).toBe(true);
    expect(model?.files.filter((f) => f.draco_compressed).map((f) => f.filename)).toEqual([
      'Hesperocyon_sp-100k-2048_std_draco.glb',
    ]);
    expect(result.structuredContent).not.toHaveProperty('truncated');

    const text = textOf(result);
    expect(headings(text)).toEqual(['Media: Hesperocyon sp', `Model: ${HESPEROCYON}`]);
    expect(labelValues(text, 'Models')).toEqual(['1 of 1 CC0 3D model package(s)']);
    expect(labelValues(text, 'CC0 images')).toEqual(['0']);
    expect(labelValues(text, 'Files')).toEqual(['6']);
    expect(images(text)).toEqual([{ alt: 'Thumbnail', url: model?.thumbnail_url }]);
    expect(links(text)).toEqual([
      { text: 'Voyager 3D viewer', url: model?.viewer_url },
      ...(model?.files ?? []).map((f) => ({ text: f.filename, url: f.url })),
    ]);
    expect(items(text)[1]).toBe(
      'Hesperocyon_sp-100k-2048_std_draco.glb · Category: Low resolution · File type: glb · Model file type: glb · Units: m · Draco compressed: Yes',
    );
  });

  it('carries every file field of nmnhvz_7511097 on both surfaces, its Watertight meshes included', async () => {
    const id = '3d_package:a8ab02ba-bcae-470a-9df4-db1265b25905';
    const watertight = (filename: string, size: number) => ({
      url: `${DOCUMENT}/${id}/resources/${filename}`,
      category: 'Watertight',
      filename,
      attributes: [
        { UNITS: 'mm', FILE_TYPE: 'zip', MODEL_FILE_TYPE: 'stl', DRACO_COMPRESSED: false },
        { FILE_SIZE: size },
      ],
    });
    const others = Array.from({ length: 12 }, (_, i) => ({
      url: `${DOCUMENT}/${id}/resources/USNM_VZ_20957_${i}-100k-2048_std_draco.glb`,
      category: i % 2 ? 'Low resolution' : 'Medium resolution',
      filename: `USNM_VZ_20957_${i}-100k-2048_std_draco.glb`,
      attributes: [
        {
          UNITS: 'm',
          FILE_TYPE: 'draco compressed glb',
          MODEL_FILE_TYPE: 'draco compressed glb',
          DRACO_COMPRESSED: false,
        },
        { FILE_SIZE: 958444 + i },
      ],
    }));
    serveRecord(
      modelRecord('nmnhvz_7511097', 'Globicephala melas melas (Traill, 1809)', [
        { idsId: 'NMNH-PILOT-1', type: 'Images', usage: { access: 'CC0' } },
        {
          id,
          type: '3d_voyager',
          usage: { access: 'CC0' },
          content: `${VOYAGER}/${id}`,
          resources: [
            ...others,
            watertight('USNM_VZ_20957_jaw_cleaned_999k.zip', 28063568),
            watertight('USNM_VZ_20957_pilot_whale_skull_processed.zip', 59317548),
          ],
        },
      ]),
    );

    const result = await runToolContract(smithsonianGetMedia, {
      id: 'nmnhvz_7511097',
      media: '3d',
    });

    const page = modelsOf(result);
    expect(page.cc0_image_count).toBe(1);
    const files = page.models?.[0]?.files ?? [];
    expect(files).toHaveLength(14);
    expect(files.filter((f) => f.category === 'Watertight')).toStrictEqual([
      {
        url: `${DOCUMENT}/${id}/resources/USNM_VZ_20957_jaw_cleaned_999k.zip`,
        filename: 'USNM_VZ_20957_jaw_cleaned_999k.zip',
        category: 'Watertight',
        file_type: 'zip',
        model_file_type: 'stl',
        units: 'mm',
        draco_compressed: false,
        size_bytes: 28063568,
      },
      {
        url: `${DOCUMENT}/${id}/resources/USNM_VZ_20957_pilot_whale_skull_processed.zip`,
        filename: 'USNM_VZ_20957_pilot_whale_skull_processed.zip',
        category: 'Watertight',
        file_type: 'zip',
        model_file_type: 'stl',
        units: 'mm',
        draco_compressed: false,
        size_bytes: 59317548,
      },
    ]);

    // content[] carries every file field structuredContent does, one list item per file.
    const text = textOf(result);
    expect(items(text)).toEqual(
      files.map((f) =>
        [
          f.filename,
          `Category: ${f.category}`,
          `File type: ${f.file_type}`,
          `Model file type: ${f.model_file_type}`,
          `Units: ${f.units}`,
          `Draco compressed: ${f.draco_compressed ? 'Yes' : 'No'}`,
          `Size: ${f.size_bytes} bytes`,
        ].join(' · '),
      ),
    );
    expect(links(text).slice(1)).toEqual(files.map((f) => ({ text: f.filename, url: f.url })));
    expect(labelValues(text, 'CC0 images')).toEqual(['1 — call with media "images" to list them']);
  });

  it('gives nmah_213141 files with url, filename, and size_bytes only, and renders no other field', async () => {
    const id = '3d_package:9172faae-dbbe-424a-a9e7-56f4428a06dd';
    const names = [
      'lincoln_patent_model-100k-2048_std_draco.glb',
      'lincoln_patent_model-150k-4096-obj_std.zip',
      'lincoln_patent_model-150k-4096-gltf_std.zip',
      'lincoln_patent_model-150k-4096_std.glb',
      'lincoln_patent_model-full_resolution-obj_std.zip',
      'lincoln_patent_model-100k-2048_std.usdz',
    ];
    const sizes = [2223008, 8583524, 8340668, 10205544, 623383950, 11430246];
    serveRecord(
      modelRecord('nmah_213141', "Abraham Lincoln's Patent Model", [
        ...cc0Images(11),
        {
          id,
          type: '3d_voyager',
          usage: { access: 'CC0' },
          content: `${VOYAGER}/${id}`,
          resources: names.map((filename, i) => ({
            url: `${DOCUMENT}/${id}/resources/${filename}`,
            name: "Abraham Lincoln's Patent Model",
            title: "Abraham Lincoln's Patent Model",
            filename,
            attributes: [{ FILE_SIZE: sizes[i] }],
          })),
        },
      ]),
    );

    const result = await runToolContract(smithsonianGetMedia, { id: 'nmah_213141', media: '3d' });

    const files = modelsOf(result).models?.[0]?.files;
    expect(files).toStrictEqual(
      names.map((filename, i) => ({
        url: `${DOCUMENT}/${id}/resources/${filename}`,
        filename,
        size_bytes: sizes[i],
      })),
    );
    expect(files?.[4]).toMatchObject({
      filename: 'lincoln_patent_model-full_resolution-obj_std.zip',
      size_bytes: 623383950,
    });
    expect(items(textOf(result))[4]).toBe(
      'lincoln_patent_model-full_resolution-obj_std.zip · Size: 623383950 bytes',
    );
  });

  it('returns dpo_3d_200017 as one model with its viewer and no files, not an error', async () => {
    const id = '3d_package:016ceecb-49ea-43e8-b629-c5a2f4ded297';
    serveRecord(
      modelRecord('dpo_3d_200017', 'Fossil whale excavation site MPC 685', [
        { id, type: '3d_voyager', usage: { access: 'CC0' }, content: `${VOYAGER}/${id}` },
      ]),
    );

    const result = await runToolContract(smithsonianGetMedia, { id: 'dpo_3d_200017', media: '3d' });

    expect(result.isError).not.toBe(true);
    expect(modelsOf(result).models).toStrictEqual([
      { media_id: id, is_cc0: true, viewer_url: `${VOYAGER}/${id}`, files: [] },
    ]);
    const text = textOf(result);
    expect(labelValues(text, 'Files')).toEqual(['0']);
    expect(items(text)).toEqual([]);
    expect(links(text)).toEqual([{ text: 'Voyager 3D viewer', url: `${VOYAGER}/${id}` }]);
  });

  it('counts only CC0 images beside the packages: restricted images leave cc0_image_count 0 on both surfaces', async () => {
    serveRecord(restrictedRecord());

    const result = await runToolContract(smithsonianGetMedia, {
      id: 'nmah_RESTRICTED',
      media: '3d',
    });

    expect(result.isError).not.toBe(true);
    expect(modelsOf(result)).toMatchObject({
      images: [],
      cc0_image_count: 0,
      cc0_model_count: 1,
    });
    const text = textOf(result);
    expect(text).toContain('**CC0 images:** 0\n');
    expect(labelValues(text, 'CC0 images')).toEqual(['0']);
    expect(text).not.toContain('call with media "images"');
  });

  describe('paging the 49 packages of nmnhvz_7047834', () => {
    const ID = 'nmnhvz_7047834';

    it('omits limit to return all 49, with images empty and cc0_image_count 13', async () => {
      serveRecord(gorilla());

      const result = await runToolContract(smithsonianGetMedia, { id: ID, media: '3d' });

      const page = modelsOf(result);
      expect(page).toMatchObject({ cc0_model_count: 49, cc0_image_count: 13, images: [] });
      expect(page.models).toHaveLength(49);
      expect(page.models?.every((m) => m.files.length === 1)).toBe(true);
      expect(result.structuredContent).not.toHaveProperty('truncated');
      expect(result.structuredContent).not.toHaveProperty('notice');
      expect(labelValues(textOf(result), 'Models')).toEqual(['49 of 49 CC0 3D model package(s)']);
      expect(labelValues(textOf(result), 'CC0 images')).toEqual([
        '13 — call with media "images" to list them',
      ]);
    });

    it('start 40, limit 5 returns 5 models and a notice naming start 45', async () => {
      serveRecord(gorilla());

      const result = await runToolContract(smithsonianGetMedia, {
        id: ID,
        media: '3d',
        start: 40,
        limit: 5,
      });

      const page = modelsOf(result);
      expect(page.models?.map((m) => m.media_id)).toEqual(
        [40, 41, 42, 43, 44].map((i) => `3d_package:gorilla-${i}`),
      );
      expect(result.structuredContent).toMatchObject({
        cc0_model_count: 49,
        truncated: true,
        shown: 5,
        cap: 5,
        truncationCeiling: 49,
      });
      const notice =
        '49 CC0 model packages; this page shows 5 from start 40. Retrieve the next page with start: 45, or omit limit to return every remaining package.';
      expect(page.notice).toBe(notice);
      expect(textOf(result)).toContain(`> ${notice}`);
      expect(labelValues(textOf(result), 'Models')).toEqual(['5 of 49 CC0 3D model package(s)']);
    });

    it('a page ending on the last package is not truncated', async () => {
      serveRecord(gorilla());

      const result = await runToolContract(smithsonianGetMedia, {
        id: ID,
        media: '3d',
        start: 45,
        limit: 4,
      });

      expect(modelsOf(result).models).toHaveLength(4);
      expect(result.structuredContent).not.toHaveProperty('truncated');
    });

    it.each([49, 500])(
      'start %d, at or past the last package, returns no models and the count',
      async (start) => {
        serveRecord(gorilla());

        const result = await runToolContract(smithsonianGetMedia, { id: ID, media: '3d', start });

        expect(result.isError).not.toBe(true);
        expect(modelsOf(result)).toMatchObject({ models: [], cc0_model_count: 49 });
        expect(result.structuredContent).not.toHaveProperty('notice');
        expect(labelValues(textOf(result), 'Models')).toEqual(['0 of 49 CC0 3D model package(s)']);
      },
    );

    it('serves a limit over the cap with the clamp sentence alone', async () => {
      serveRecord(gorilla());

      const result = await runToolContract(smithsonianGetMedia, {
        id: ID,
        media: '3d',
        limit: 1500,
      });

      expect(modelsOf(result).models).toHaveLength(49);
      expect(modelsOf(result).notice).toBe(
        'limit 1500 exceeds the cap of 1000; the page was served with limit 1000.',
      );
      expect(result.structuredContent).not.toHaveProperty('truncated');
    });

    it('images mode on the same record is unchanged: 13 images and no model fields', async () => {
      serveRecord(gorilla());

      const result = await runToolContract(smithsonianGetMedia, { id: ID });

      expect(pageOf(result).images).toHaveLength(13);
      expect(result.structuredContent).not.toHaveProperty('models');
      expect(result.structuredContent).not.toHaveProperty('cc0_model_count');
      expect(textOf(result)).not.toContain('Model');
    });
  });

  describe('whole-record failures', () => {
    it('fails no_models on npg_NPG.77.61, one image and no 3D, naming the images call', async () => {
      serveRecord(modelRecord('npg_NPG.77.61', 'Self-portrait', cc0Images(1)));

      const result = await runToolContract(smithsonianGetMedia, {
        id: 'npg_NPG.77.61',
        media: '3d',
      });

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message:
            'Object "npg_NPG.77.61" has 1 media item(s), but no 3D model package (media types: Images).',
          data: {
            reason: 'no_models',
            record_id: 'npg_NPG.77.61',
            media_count: 1,
            media_types: ['Images'],
            recovery: {
              hint: 'This object has no 3D model package; its online media is Images. Call smithsonian_get_media { id: "npg_NPG.77.61" } for its images.',
            },
          },
        },
      });
      expect(textOf(result)).toContain(
        'Recovery: This object has no 3D model package; its online media is Images. Call smithsonian_get_media { id: "npg_NPG.77.61" } for its images.',
      );
      expect(textOf(result)).toContain('(reason no_models)');
    });

    it('fails no_models with the get_object route when the media is neither images nor 3D', async () => {
      serveRecord(
        modelRecord('siris_sil_893158', 'Senkeiban zushiki', [
          { type: 'Scanned books', content: 'https://doi.org/10.5479/sil.893158.39088019035187' },
        ]),
      );

      const result = await runToolContract(smithsonianGetMedia, {
        id: 'siris_sil_893158',
        media: '3d',
      });

      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: 'no_models',
            recovery: {
              hint: 'This object has no 3D model package; its online media is Scanned books. Call smithsonian_get_object { id: "siris_sil_893158" } and read media_summary.non_image_media for each item\'s link.',
            },
          },
        },
      });
    });

    /** An image the catalog does not release as CC0. */
    const restrictedImage = {
      type: 'Images',
      idsId: 'NMAH-RESTRICTED-1',
      content: 'https://ids.si.edu/ids/deliveryService?id=NMAH-RESTRICTED-1',
      usage: { access: 'Usage Conditions Apply' },
    };

    it('fails no_models without naming the images call when no image is CC0', async () => {
      serveRecord(modelRecord('nmah_RESTRICTED', 'Patent model', [restrictedImage]));

      const result = await runToolContract(smithsonianGetMedia, {
        id: 'nmah_RESTRICTED',
        media: '3d',
      });

      const hint =
        'This object has no 3D model package; its online media is Images. None of its images are CC0, and this tool returns CC0 media only. Use smithsonian_search_objects { query: "", filters: { online_media_type: "3D Models" } } to find objects with 3D models.';
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'no_models', recovery: { hint } } },
      });
      expect(textOf(result)).toContain(`Recovery: ${hint}`);
    });

    it('fails no_models with the get_object route when no image is CC0 beside other media', async () => {
      serveRecord(
        modelRecord('nmah_RESTRICTED_BOOK', 'Patent model', [
          restrictedImage,
          { type: 'Scanned books', content: 'https://doi.org/10.5479/sil.893158.39088019035187' },
        ]),
      );

      const result = await runToolContract(smithsonianGetMedia, {
        id: 'nmah_RESTRICTED_BOOK',
        media: '3d',
      });

      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: 'no_models',
            recovery: {
              hint: 'This object has no 3D model package; its online media is Images, Scanned books. Call smithsonian_get_object { id: "nmah_RESTRICTED_BOOK" } and read media_summary.non_image_media for each item\'s link.',
            },
          },
        },
      });
    });

    it('fails no_models with the declared recovery when no item names a type', async () => {
      serveRecord(modelRecord('nmnh_UNTYPED', 'Untyped', [{}]));

      const result = await runToolContract(smithsonianGetMedia, {
        id: 'nmnh_UNTYPED',
        media: '3d',
      });

      const declared = smithsonianGetMedia.errors?.find((e) => e.reason === 'no_models')?.recovery;
      expect(declared).toContain('smithsonian_get_media without media');
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'no_models', recovery: { hint: declared } } },
      });
      expect(textOf(result)).toContain(`Recovery: ${declared}`);
    });

    it('fails no_media in 3D mode exactly as in images mode', async () => {
      serveRecord(bareRecord());
      const images = await runToolContract(smithsonianGetMedia, { id: 'nmnhvz_5105499' });
      serveRecord(bareRecord());
      const models = await runToolContract(smithsonianGetMedia, {
        id: 'nmnhvz_5105499',
        media: '3d',
      });

      expect(models.structuredContent).toMatchObject({ error: { data: { reason: 'no_media' } } });
      expect(JSON.stringify(models.structuredContent)).toBe(
        JSON.stringify(images.structuredContent),
      );
      expect(textOf(models)).toBe(textOf(images));
    });

    it('leaves out a non-CC0 package and pages the CC0 ones', async () => {
      serveRecord(
        modelRecord('nmnh_MIXED3D', 'Mixed packages', [
          voyagerPackage('a'),
          voyagerPackage('b', 'Usage Conditions Apply'),
          voyagerPackage('c'),
        ]),
      );

      const result = await runToolContract(smithsonianGetMedia, {
        id: 'nmnh_MIXED3D',
        media: '3d',
        start: 1,
      });

      expect(modelsOf(result).cc0_model_count).toBe(2);
      expect(modelsOf(result).models?.map((m) => m.media_id)).toEqual(['3d_package:c']);
    });

    it('fails not_cc0 when no package is CC0, with a 3D hint, at any start', async () => {
      for (const start of [0, 1, 50]) {
        serveRecord(
          modelRecord('nmnh_RESTRICTED3D', 'Restricted scan', [
            ...cc0Images(2),
            voyagerPackage('r1', 'Usage Conditions Apply'),
            voyagerPackage('r2', 'Usage Conditions Apply'),
          ]),
        );

        const result = await runToolContract(smithsonianGetMedia, {
          id: 'nmnh_RESTRICTED3D',
          media: '3d',
          start,
          limit: 1,
        });

        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.Forbidden,
            message:
              'Object "nmnh_RESTRICTED3D" has 2 3D model package(s) but none are CC0 open access.',
            data: {
              reason: 'not_cc0',
              model_count: 2,
              recovery: {
                hint: 'None of this object\'s 3D model packages are CC0, and this tool returns CC0 media only. Use smithsonian_search_objects { query: "", filters: { online_media_type: "3D Models" } } to find objects with 3D models.',
              },
            },
          },
        });
      }
    });

    it('fails no_models at any start on a record without 3D packages', async () => {
      for (const start of [0, 3, 500]) {
        serveRecord(mediaRecord(cc0Images(3)));
        const result = await runToolContract(smithsonianGetMedia, {
          id: 'chndm_1945-55-16',
          media: '3d',
          start,
          limit: 1,
        });
        expect(result.structuredContent).toMatchObject({
          error: { data: { reason: 'no_models' } },
        });
      }
    });

    it.each(['3D', 'models', '', 'image'])(
      'rejects media %j as invalid_arguments, before reading the record',
      async (media) => {
        const { getContent } = serveRecord(hesperocyon());

        const result = await runToolContract(smithsonianGetMedia, {
          id: 'nmnhpaleobiology_13278478',
          media,
        });

        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
        });
        expect(textOf(result)).toContain('media');
        expect(getContent).not.toHaveBeenCalled();
      },
    );
  });

  describe('no_images names the media: "3d" call for a 3D record', () => {
    it('names it on both surfaces for dpo_3d_200012', async () => {
      serveRecord(
        modelRecord('dpo_3d_200012', 'Cassiopeia A Supernova Remnant', [
          voyagerPackage('732d123d-7a35-411b-a4e1-5e355adcacf8'),
        ]),
      );

      const result = await runToolContract(smithsonianGetMedia, { id: 'dpo_3d_200012' });

      const hint =
        'This object\'s online media is 3d_voyager, none of it images. Call smithsonian_get_media { id: "dpo_3d_200012", media: "3d" } for its 3D model files.';
      expect(result.structuredContent).toMatchObject({
        error: {
          message:
            'Object "dpo_3d_200012" has 1 media item(s), but none of them are images (media types: 3d_voyager).',
          data: { reason: 'no_images', media_types: ['3d_voyager'], recovery: { hint } },
        },
      });
      expect(textOf(result)).toContain(`Recovery: ${hint}`);
    });

    it('names both routes when a 3D package sits beside other non-image media', async () => {
      serveRecord(
        modelRecord('nmnh_3DBOOK', 'Scan and catalog', [
          voyagerPackage('p'),
          { type: 'Scanned books', content: 'https://doi.org/10.5479/sil.1' },
        ]),
      );

      const result = await runToolContract(smithsonianGetMedia, { id: 'nmnh_3DBOOK' });

      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: 'no_images',
            recovery: {
              hint: 'This object\'s online media is 3d_voyager, Scanned books, none of it images. Call smithsonian_get_media { id: "nmnh_3DBOOK", media: "3d" } for its 3D model files, and smithsonian_get_object { id: "nmnh_3DBOOK" } and read media_summary.non_image_media for each other item\'s link.',
            },
          },
        },
      });
    });

    it('declares a recovery that names both the media "3d" call and non_image_media', () => {
      const entry = smithsonianGetMedia.errors?.find((e) => e.reason === 'no_images');
      expect(entry?.recovery).toContain('media: "3d"');
      expect(entry?.recovery).toContain('media_summary.non_image_media');
      expect(smithsonianGetMedia.description).not.toMatch(/does not deliver|images only/);
    });
  });

  describe('content[] encoding of model fields', () => {
    const render = (models: ModelPackage[]) =>
      smithsonianGetMedia.format!({
        record_id: 'nmnh_`3d`',
        title: 'Skull *cast*',
        is_cc0: true,
        cc0_image_count: 0,
        images: [],
        cc0_model_count: models.length,
        models,
      })
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('');

    it('reads every upstream string back under CommonMark', () => {
      const model: ModelPackage = {
        media_id: '3d_package:<x>_*y*',
        is_cc0: true,
        viewer_url: 'https://3d-api.si.edu/voyager/3d_package:x?a=1&b=2',
        thumbnail_url: 'https://3d-api.si.edu/content/document/x/scene-image-thumb.jpg',
        files: [
          {
            url: 'https://3d-api.si.edu/content/document/x/resources/a b.glb',
            filename: 'skull_*final*<v2>.glb',
            category: 'Full_resolution [print]',
            file_type: '`glb`',
            model_file_type: 'draco compressed glb',
            units: '<mm>',
            draco_compressed: false,
            size_bytes: 0,
          },
          { url: 'https://3d-api.si.edu/content/document/x/resources/nameless' },
        ],
      };

      const text = render([model]);

      expect(headings(text)).toEqual(['Media: Skull *cast*', `Model: ${model.media_id}`]);
      expect(codeSpans(text)).toEqual(['nmnh_`3d`']);
      expect(links(text)).toEqual([
        { text: 'Voyager 3D viewer', url: model.viewer_url },
        { text: 'skull_*final*<v2>.glb', url: model.files[0]?.url },
        { text: 'Download', url: model.files[1]?.url },
      ]);
      expect(images(text)).toEqual([{ alt: 'Thumbnail', url: model.thumbnail_url }]);
      expect(items(text)).toEqual([
        'skull_*final*<v2>.glb · Category: Full_resolution [print] · File type: `glb` · Model file type: draco compressed glb · Units: <mm> · Draco compressed: No · Size: 0 bytes',
        'Download',
      ]);
    });
  });
});
