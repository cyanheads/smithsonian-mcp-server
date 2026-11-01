/**
 * @fileoverview Tests for smithsonian_get_object tool.
 * @module tests/mcp-server/tools/definitions/smithsonian-get-object.tool.test
 */

import { JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
import {
  createInMemoryStorage,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { smithsonianGetObject } from '@/mcp-server/tools/definitions/smithsonian-get-object.tool.js';
import * as svcModule from '@/services/smithsonian/smithsonian-service.js';
import type { FullObject, RawEDAN } from '@/services/smithsonian/types.js';
import { textOf } from './tool-result.js';

function makeFullObject(id = 'nasm_TEST001'): FullObject {
  return {
    record_id: id,
    title: 'Test Object',
    unit_code: 'NASM',
    museum_name: 'National Air and Space Museum',
    dates: [{ label: 'Date', value: '1965' }],
    description: 'A historic aircraft.',
    notes: [{ label: 'Summary', content: 'A historic aircraft.' }],
    scientific_names: [],
    coordinates: [],
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
      non_image_media: [],
    },
  };
}

/**
 * Route `fetch` to `/content/{id}` records by pathname, rejecting every other call.
 * Records are keyed by bare record_id; the service requests `edanmdm:<id>`.
 */
function stubContent(records: Record<string, RawEDAN>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const { hostname, pathname } = new URL(String(input));
      const segment = /\/content\/([^/]+)$/.exec(pathname)?.[1];
      const record =
        hostname === 'api.si.edu' && segment
          ? records[decodeURIComponent(segment).replace(/^edanmdm:/, '')]
          : undefined;
      if (!record) throw new Error(`unmocked fetch: ${String(input)}`);
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 200, responseCode: 1, response: record }),
      };
    }),
  );
}

const VOYAGER_URL = 'https://3d-api.si.edu/voyager/3d_package:732d123d-7a35-411b-a4e1-5e355adcacf8';

/** dpo_3d_200012 as `/content` returns it: indexed under OCIO_DPO3D, held by SAO, one 3D package. */
const CASSIOPEIA: RawEDAN = {
  id: '123-1580492962881-1580492968342-0',
  title: 'Cassiopeia A Supernova Remnant',
  unitCode: 'OCIO_DPO3D',
  url: 'edanmdm:dpo_3d_200012',
  content: {
    descriptiveNonRepeating: {
      record_ID: 'dpo_3d_200012',
      unit_code: 'SAO',
      data_source: 'Smithsonian Astrophysical Observatory',
      metadata_usage: { access: 'CC0' },
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
            ],
          },
        ],
      },
    },
  },
};

/** siris_sil_893158: indexed and held by SIL, two scanned-book links. */
const SENKEIBAN: RawEDAN = {
  id: 'ld1-1646149545906-1646150527695-2',
  title: 'Senkeiban zushiki',
  unitCode: 'SIL',
  url: 'edanmdm:siris_sil_893158',
  content: {
    descriptiveNonRepeating: {
      record_ID: 'siris_sil_893158',
      unit_code: 'SIL',
      data_source: 'Smithsonian Libraries',
      record_link:
        'https://siris-libraries.si.edu/ipac20/ipac.jsp?&profile=liball&source=~!silibraries&uri=full=3100001~!893158~!0#focus',
      metadata_usage: { access: 'CC0' },
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
    },
  },
};

/** fbr_item_MODSI843: a field book with a page viewer and a PDF, no record_link. */
const FIELD_BOOK: RawEDAN = {
  title: 'Field book',
  unitCode: 'FBR',
  url: 'edanmdm:fbr_item_MODSI843',
  content: {
    descriptiveNonRepeating: {
      record_ID: 'fbr_item_MODSI843',
      unit_code: 'FBR',
      data_source: 'Smithsonian Field Book Project',
      metadata_usage: { access: 'CC0' },
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
    },
  },
};

/** nmnhvz_7047834's media shape: 13 CC0 images, then 49 3D packages. */
const GORILLA: RawEDAN = {
  title: 'Gorilla beringei beringei',
  unitCode: 'NMNHMAMMALS',
  url: 'edanmdm:nmnhvz_7047834',
  content: {
    descriptiveNonRepeating: {
      record_ID: 'nmnhvz_7047834',
      unit_code: 'NMNHMAMMALS',
      data_source: 'NMNH - Vertebrate Zoology - Mammals Division',
      metadata_usage: { access: 'CC0' },
      online_media: {
        mediaCount: 62,
        media: [
          ...Array.from({ length: 13 }, (_, i) => ({
            id: `media-${i}`,
            idsId: `NMNH-IMG-${i}`,
            type: 'Images',
            usage: { access: 'CC0' },
          })),
          ...Array.from({ length: 49 }, (_, i) => ({
            id: `3d_package:${i}`,
            type: '3d_voyager',
            content: `https://3d-api.si.edu/voyager/3d_package:${i}`,
            usage: { access: 'CC0' },
          })),
        ],
      },
    },
  },
};

describe('smithsonianGetObject', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns full object for a valid ID', async () => {
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue({ record: { content: {} } }),
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
    const result = await runToolContract(smithsonianGetObject, { id: '   ' });
    const expectedHint = smithsonianGetObject.errors?.find(
      (e) => e.reason === 'invalid_id',
    )?.recovery;
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_id', recovery: { hint: expectedHint } } },
    });
  });

  it('propagates not_found with reason and recovery from the service (issues #10, #25)', async () => {
    // The stand-in mirrors the real service throw site: reason only, no recovery. The
    // framework fills this tool's declared not_found hint on the wire — the service
    // test verifies the real factory populates the reason for real.
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockRejectedValue(
        notFound('No Smithsonian object found for ID "nasm_MISSING".', {
          recordId: 'nasm_MISSING',
          reason: 'not_found',
        }),
      ),
      toFullObject: vi.fn(),
    } as unknown as svcModule.SmithsonianService);

    const result = await runToolContract(smithsonianGetObject, { id: 'nasm_MISSING' });
    const expectedHint = smithsonianGetObject.errors?.find(
      (e) => e.reason === 'not_found',
    )?.recovery;
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'not_found', recovery: { hint: expectedHint } },
      },
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
      notes: [],
      scientific_names: [],
      coordinates: [],
      makers: [],
      materials: [],
      dimensions: [],
      place: [],
      culture: [],
      topics: [],
      exhibitions: [],
      identifiers: [],
      is_cc0: false,
      media_summary: { count: 0, cc0_image_count: 0, has_cc0_images: false, non_image_media: [] },
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

    it('exposes labeled notes on both wire surfaces', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'slasro_92924' });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        notes: [
          { label: 'Summary', content: 'Yeates, A. R. 2010. "A nonpotential model." JGR 115.' },
        ],
      });
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('Summary: Yeates, A. R. 2010.'),
          }),
        ]),
      );
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

  describe('indexed unit code, holding museum, and non-image media (issues #62, #64)', () => {
    // The real service over a pathname-routed fetch: unit-code precedence and the
    // non-image selection both live in normalizeToFull, and runToolContract parses
    // the output schema, so a field the schema does not declare is stripped here.
    beforeEach(() => {
      vi.stubEnv('SMITHSONIAN_API_KEY', 'test-key-12345');
      stubContent({
        dpo_3d_200012: CASSIOPEIA,
        siris_sil_893158: SENKEIBAN,
        fbr_item_MODSI843: FIELD_BOOK,
        nmnhvz_7047834: GORILLA,
        dpo_3d_200018: {
          title: 'Fossil whale excavation site MPC 665-667',
          unitCode: 'OCIO_DPO3D',
          content: {
            descriptiveNonRepeating: {
              record_ID: 'dpo_3d_200018',
              unit_code: 'DPO',
              data_source: 'NMNH - Paleobiology Dept.',
            },
          },
        },
        no_indexed_code: {
          title: 'Row without a top-level unitCode',
          content: {
            descriptiveNonRepeating: {
              record_ID: 'no_indexed_code',
              unit_code: 'NMNHPALEO',
              data_source: 'NMNH - Paleobiology Dept.',
            },
          },
        },
        no_content: {
          title: 'Item without content',
          unitCode: 'NASM',
          content: {
            descriptiveNonRepeating: {
              record_ID: 'no_content',
              unit_code: 'NASM',
              online_media: {
                mediaCount: 1,
                media: [{ type: '3d_voyager', usage: { access: 'Usage Conditions Apply' } }],
              },
            },
          },
        },
      });
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(
        new svcModule.SmithsonianService(createInMemoryStorage()),
      );
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    it('reports the indexed code and the holding museum on both surfaces (dpo_3d_200012)', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'dpo_3d_200012' });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        unit_code: 'OCIO_DPO3D',
        museum_name:
          'Office of the Chief Information Officer - Digitization Program Office (3D digitization)',
        holding_museum_name: 'Smithsonian Astrophysical Observatory',
      });
      const lines = textOf(result).split('\n');
      const museumLine = lines.findIndex((line) => line.includes('**Museum:**'));
      expect(lines[museumLine]).toContain(
        '**Museum:** Office of the Chief Information Officer - Digitization Program Office (3D digitization) (OCIO_DPO3D)',
      );
      expect(lines[museumLine + 1]).toBe('**Held by:** Smithsonian Astrophysical Observatory');
    });

    it('names the holding museum from data_source when the record code is DPO (dpo_3d_200018)', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'dpo_3d_200018' });
      expect(result.structuredContent).toMatchObject({
        unit_code: 'OCIO_DPO3D',
        holding_museum_name: 'NMNH - Paleobiology Dept.',
      });
      expect(textOf(result)).toContain('**Held by:** NMNH - Paleobiology Dept.');
    });

    it.each([
      ['siris_sil_893158', 'SIL', 'Smithsonian Libraries'],
      ['no_indexed_code', 'NMNHPALEO', 'NMNH - Paleobiology Dept.'],
    ])(
      'carries no holding museum when the codes agree or only one exists (%s)',
      async (id, unitCode, museumName) => {
        const result = await runToolContract(smithsonianGetObject, { id });
        expect(result.structuredContent).toMatchObject({
          unit_code: unitCode,
          museum_name: museumName,
        });
        expect(result.structuredContent).not.toHaveProperty('holding_museum_name');
        expect(textOf(result)).not.toContain('Held by');
      },
    );

    it('links the one 3D package of dpo_3d_200012 on both surfaces', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'dpo_3d_200012' });
      expect(result.structuredContent).toMatchObject({
        media_summary: {
          count: 1,
          cc0_image_count: 0,
          non_image_media: [{ type: '3d_voyager', url: VOYAGER_URL, is_cc0: true }],
        },
      });
      const text = textOf(result);
      expect(text).toContain('**Non-image media:**');
      expect(text).toContain(`- [3d_voyager](<${VOYAGER_URL}>) · CC0: Yes`);
      // The per-file resources stay out — only the package's viewer is listed.
      expect(text).not.toContain('.usdz');
    });

    it('links both scanned-book entries of siris_sil_893158', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'siris_sil_893158' });
      const urls = [
        'https://doi.org/10.5479/sil.893158.39088019035187',
        'https://biodiversitylibrary.org/bibliography/179335',
      ];
      expect(result.structuredContent).toMatchObject({
        media_summary: {
          non_image_media: urls.map((url) => ({ type: 'Scanned books', url, is_cc0: true })),
        },
      });
      for (const url of urls)
        expect(textOf(result)).toContain(`- [Scanned books](<${url}>) · CC0: Yes`);
    });

    it('links the viewer and PDF of fbr_item_MODSI843, which has no record_link', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'fbr_item_MODSI843' });
      expect(result.structuredContent).not.toHaveProperty('record_link');
      expect(result.structuredContent).toMatchObject({
        media_summary: {
          non_image_media: [
            { type: 'slideshowXML', is_cc0: true },
            { type: 'Electronic resource', is_cc0: true },
          ],
        },
      });
      const text = textOf(result);
      expect(text).toContain(
        '- [slideshowXML](<http://siarchives.si.edu/sites/default/files/viewers/csc/viewer_MODSI843_007267_B02_F08.xml>) · CC0: Yes',
      );
      expect(text).toContain(
        '- [Electronic resource](<http://siarchives.si.edu/sites/default/files/media/SIA-SIA_007267_B02_F08.pdf>) · CC0: Yes',
      );
    });

    it('lists all 49 3D packages of nmnhvz_7047834 on both surfaces; cc0_image_count stays 13', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'nmnhvz_7047834' });
      const summary = (result.structuredContent as { media_summary: FullObject['media_summary'] })
        .media_summary;
      expect(summary.cc0_image_count).toBe(13);
      expect(summary.non_image_media).toHaveLength(49);
      const listed = textOf(result)
        .split('\n')
        .filter((line) => line.startsWith('- [3d_voyager]('));
      expect(listed).toHaveLength(49);
      for (const item of summary.non_image_media) expect(textOf(result)).toContain(`<${item.url}>`);
    });

    it('lists an item without content with no url, and renders a non-CC0 item as such', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'no_content' });
      const summary = (result.structuredContent as { media_summary: FullObject['media_summary'] })
        .media_summary;
      expect(summary.non_image_media).toEqual([{ type: '3d_voyager', is_cc0: false }]);
      expect(textOf(result)).toContain('- 3d_voyager (no URL) · CC0: No');
    });

    it('returns an empty list and no heading when the object has no non-image media', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'dpo_3d_200018' });
      expect(result.structuredContent).toMatchObject({ media_summary: { non_image_media: [] } });
      expect(textOf(result)).not.toContain('Non-image media');
    });
  });
});
