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
import {
  codeSpans,
  headings,
  images,
  items,
  labelValues,
  links,
  paragraphs,
} from '../markdown-read-back.js';
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
    physical_description: [
      { label: 'Materials', value: 'Aluminum' },
      { label: 'Dimensions', value: '12 m wingspan' },
    ],
    place: [{ label: 'Place of Origin', value: 'United States of America' }],
    culture: ['American'],
    topics: ['Aviation', 'Space Exploration'],
    indexed: {
      name: ['Lockheed'],
      place: ['United States of America'],
      object_type: ['Aircraft'],
      date: ['1960s'],
      topic: ['Aviation'],
    },
    exhibitions: [{ name: 'Milestones of Flight', building: 'Milestones of Flight Hall' }],
    current_exhibitions: [],
    sets: [{ label: 'See more items in', value: 'National Air and Space Museum Collection' }],
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
 * Records are keyed by bare record_id; the service requests `edanmdm:<id>`. Each answer
 * carries the requested `url` unless the record sets its own, as every live record does.
 */
function stubContent(records: Record<string, RawEDAN>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const { hostname, pathname } = new URL(String(input));
      const segment = /\/content\/([^/]+)$/.exec(pathname)?.[1];
      const id = segment ? decodeURIComponent(segment).replace(/^edanmdm:/, '') : undefined;
      const record = hostname === 'api.si.edu' && id ? records[id] : undefined;
      if (!record) throw new Error(`unmocked fetch: ${String(input)}`);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 200,
          responseCode: 1,
          response: { url: `edanmdm:${id}`, ...record },
        }),
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

/**
 * nasm_A19700102000's indexed block as `/content` returns it (2026-11-15), with one free-text
 * name: the name filter matches the indexed "Armstrong, Neil A." and nothing for the free-text
 * "Neil A. Armstrong". It is flagged on view, at a venue named by building alone.
 */
const APOLLO_11: RawEDAN = {
  title: 'Command Module Columbia, Apollo 11',
  unitCode: 'NASM',
  url: 'edanmdm:nasm_A19700102000',
  content: {
    descriptiveNonRepeating: { record_ID: 'nasm_A19700102000', unit_code: 'NASM' },
    freetext: { name: [{ label: 'Astronaut', content: 'Neil A. Armstrong' }] },
    indexedStructured: {
      name: ['Collins, Michael', 'Armstrong, Neil A.', 'Aldrin, Buzz', 'North American Rockwell'],
      place: ['United States of America'],
      object_type: ['Spacecraft'],
      topic: ['Outer space', 'Spaceflight'],
      onPhysicalExhibit: ['Yes'],
      exhibition: [{ building: 'NASM' }],
    },
  },
};

/** npg_NPG.2020.41's on-view keys as `/content` returns them (2026-11-15): all three venue parts. */
const NPG_PORTRAIT: RawEDAN = {
  title: 'Portrait',
  unitCode: 'NPG',
  url: 'edanmdm:npg_NPG.2020.41',
  content: {
    descriptiveNonRepeating: { record_ID: 'npg_NPG.2020.41', unit_code: 'NPG' },
    indexedStructured: {
      onPhysicalExhibit: ['Yes'],
      exhibition: [
        {
          room: 'East Gallery 142',
          building: 'NPG',
          exhibitionTitle: 'Out of Many: Portraits from 1600 to 1900',
        },
      ],
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
      physical_description: [],
      place: [],
      culture: [],
      topics: [],
      indexed: { name: [], place: [], object_type: [], date: [], topic: [] },
      exhibitions: [],
      current_exhibitions: [],
      sets: [],
      identifiers: [],
      is_cc0: false,
      media_summary: { count: 0, cc0_image_count: 0, has_cc0_images: false, non_image_media: [] },
    };
    const blocks = smithsonianGetObject.format!(sparse);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('nmnh_SPARSE');
    expect(text).toContain('Sparse Object');
    expect(text).not.toContain('Physical description');
    expect(text).not.toContain('**Sets:**');
    expect(text).not.toContain('**Rights:**');
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

  describe('indexed filter values (issue #73)', () => {
    // The real service over a pathname-routed fetch: the values come from normalizeToFull,
    // and runToolContract parses the output schema, so an undeclared field is stripped here.
    beforeEach(() => {
      vi.stubEnv('SMITHSONIAN_API_KEY', 'test-key-12345');
      stubContent({
        nasm_A19700102000: APOLLO_11,
        slasro_79883: {
          title: 'Paper',
          url: 'edanmdm:slasro_79883',
          unitCode: 'SLA_SRO',
          content: {
            descriptiveNonRepeating: { record_ID: 'slasro_79883', unit_code: 'SLA_SRO' },
            indexedStructured: {
              // RawIndexedName models the wrapper's content only; `type` is its provenance.
              name: [
                { type: 'author', content: 'Stewart, M. M.' } as never,
                { type: 'author', content: 'Biuso, L. F.' } as never,
              ],
              object_type: ['Journal articles'],
              date: ['1980s'],
            },
          },
        },
        nmah_mash: {
          title: 'Costume',
          url: 'edanmdm:nmah_mash',
          unitCode: 'NMAH',
          content: {
            descriptiveNonRepeating: { record_ID: 'nmah_mash', unit_code: 'NMAH' },
            indexedStructured: { topic: ['M*A*S*H Television Series', '<b>x</b>'] },
          },
        },
        nmah_bare: {
          title: 'Bare',
          url: 'edanmdm:nmah_bare',
          unitCode: 'NMAH',
          content: { descriptiveNonRepeating: { record_ID: 'nmah_bare', unit_code: 'NMAH' } },
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

    /** The lines from the `**Indexed filter values:**` heading through its last list item. */
    function indexedBlock(text: string): string[] {
      const lines = text.split('\n');
      const at = lines.indexOf('**Indexed filter values:**');
      if (at === -1) return [];
      const end = lines.findIndex((line, i) => i > at && !line.startsWith('- '));
      return lines.slice(at, end === -1 ? undefined : end);
    }

    it('returns the indexed values of nasm_A19700102000 and lists one per line', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'nasm_A19700102000' });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        indexed: {
          name: [
            'Collins, Michael',
            'Armstrong, Neil A.',
            'Aldrin, Buzz',
            'North American Rockwell',
          ],
          place: ['United States of America'],
          object_type: ['Spacecraft'],
          date: [],
          topic: ['Outer space', 'Spaceflight'],
        },
        makers: [{ role: 'Astronaut', name: 'Neil A. Armstrong' }],
      });
      expect(indexedBlock(textOf(result))).toEqual([
        '**Indexed filter values:**',
        '- name: Collins, Michael',
        '- name: Armstrong, Neil A.',
        '- name: Aldrin, Buzz',
        '- name: North American Rockwell',
        '- place: United States of America',
        '- object_type: Spacecraft',
        '- topic: Outer space',
        '- topic: Spaceflight',
      ]);
    });

    it('returns the content of each wrapped name (slasro_79883)', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'slasro_79883' });

      expect(result.structuredContent).toMatchObject({
        indexed: { name: ['Stewart, M. M.', 'Biuso, L. F.'], object_type: ['Journal articles'] },
      });
      expect(indexedBlock(textOf(result))).toContain('- name: Biuso, L. F.');
    });

    it('escapes Markdown syntax in a value on content[] and keeps it raw on structuredContent', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'nmah_mash' });

      expect(result.structuredContent).toMatchObject({
        indexed: { topic: ['M*A*S*H Television Series', '<b>x</b>'] },
      });
      expect(indexedBlock(textOf(result))).toEqual([
        '**Indexed filter values:**',
        '- topic: M\\*A\\*S\\*H Television Series',
        '- topic: \\<b>x\\</b>',
      ]);
    });

    it('renders no block for a record with no indexed values', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'nmah_bare' });

      expect(result.structuredContent).toMatchObject({
        indexed: { name: [], place: [], object_type: [], date: [], topic: [] },
      });
      expect(textOf(result)).not.toContain('Indexed filter values');
    });
  });

  describe('on view and current exhibitions (issue #74)', () => {
    // The real service over a pathname-routed fetch: the flag and venues come from
    // normalizeToFull, and runToolContract parses the output schema, so an undeclared field
    // is stripped here.
    const unflagged = (id: string, indexedStructured?: Record<string, unknown>): RawEDAN => ({
      title: `Object ${id}`,
      unitCode: 'NMAH',
      content: {
        descriptiveNonRepeating: { record_ID: id, unit_code: 'NMAH' },
        ...(indexedStructured && { indexedStructured }),
      },
    });

    beforeEach(() => {
      vi.stubEnv('SMITHSONIAN_API_KEY', 'test-key-12345');
      stubContent({
        nasm_A19700102000: APOLLO_11,
        'npg_NPG.2020.41': NPG_PORTRAIT,
        // Neither key, as /content returns nmah_556181 (2026-11-15).
        nmah_556181: unflagged('nmah_556181'),
        nmah_off: unflagged('nmah_off', { onPhysicalExhibit: ['No'] }),
        nmah_venues: unflagged('nmah_venues', {
          exhibition: [
            { building: 'NMAH', room: 'East Wing 1' },
            { exhibitionTitle: 'Entertainment Nation', building: 'NMAH' },
          ],
        }),
        nmah_markup: unflagged('nmah_markup', {
          onPhysicalExhibit: ['Yes'],
          exhibition: [
            { exhibitionTitle: 'M*A*S*H <b>x</b>', building: 'NMAH', room: '[Gallery]' },
            { exhibitionTitle: '# 1 Hits', building: 'NMAH' },
          ],
        }),
      });
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(
        new svcModule.SmithsonianService(createInMemoryStorage()),
      );
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    /** The `**On view:**` or `**Current exhibitions:**` line and the venue items under it. */
    function displayBlock(text: string): string[] {
      const lines = text.split('\n');
      const at = lines.findIndex(
        (line) => line.startsWith('**On view:**') || line === '**Current exhibitions:**',
      );
      if (at === -1) return [];
      const end = lines.findIndex((line, i) => i > at && !line.startsWith('- '));
      return lines.slice(at, end === -1 ? undefined : end);
    }

    it('reports nasm_A19700102000 on view at NASM on both surfaces, its history still empty', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'nasm_A19700102000' });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        on_view: true,
        current_exhibitions: [{ building: 'NASM' }],
        exhibitions: [],
      });
      expect(displayBlock(textOf(result))).toEqual(['**On view:** Yes', '- NASM']);
    });

    it('names the title, building, and room of npg_NPG.2020.41 in one item', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'npg_NPG.2020.41' });

      expect(
        (result.structuredContent as { current_exhibitions: unknown }).current_exhibitions,
      ).toStrictEqual([
        {
          building: 'NPG',
          room: 'East Gallery 142',
          title: 'Out of Many: Portraits from 1600 to 1900',
        },
      ]);
      expect(displayBlock(textOf(result))).toEqual([
        '**On view:** Yes',
        '- Out of Many: Portraits from 1600 to 1900 · NPG, East Gallery 142',
      ]);
    });

    it('omits on_view and renders neither line for a record with no flag (nmah_556181)', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'nmah_556181' });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).not.toHaveProperty('on_view');
      expect(result.structuredContent).toMatchObject({ current_exhibitions: [] });
      expect(textOf(result)).not.toContain('**On view:**');
      expect(textOf(result)).not.toContain('**Current exhibitions:**');
    });

    it('reports a record flagged off view as on_view false and "No"', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'nmah_off' });

      expect(result.structuredContent).toMatchObject({ on_view: false, current_exhibitions: [] });
      expect(displayBlock(textOf(result))).toEqual(['**On view:** No']);
    });

    it('lists venues without a flag under their own heading, one item each in order', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'nmah_venues' });

      expect(result.structuredContent).not.toHaveProperty('on_view');
      expect(result.structuredContent).toMatchObject({
        current_exhibitions: [
          { building: 'NMAH', room: 'East Wing 1' },
          { building: 'NMAH', title: 'Entertainment Nation' },
        ],
      });
      expect(displayBlock(textOf(result))).toEqual([
        '**Current exhibitions:**',
        '- NMAH, East Wing 1',
        '- Entertainment Nation · NMAH',
      ]);
    });

    it('escapes Markdown syntax in a venue on content[] and keeps it raw on structuredContent', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'nmah_markup' });

      expect(result.structuredContent).toMatchObject({
        current_exhibitions: [
          { title: 'M*A*S*H <b>x</b>', building: 'NMAH', room: '[Gallery]' },
          { title: '# 1 Hits', building: 'NMAH' },
        ],
      });
      expect(displayBlock(textOf(result))).toEqual([
        '**On view:** Yes',
        '- M\\*A\\*S\\*H \\<b>x\\</b> · NMAH, \\[Gallery\\]',
        '- \\# 1 Hits · NMAH',
      ]);
    });
  });

  describe('physical description, sets, and rights (issues #79, #81, #82)', () => {
    // The real service over a pathname-routed fetch: the three fields come from
    // normalizeToFull, and runToolContract parses the output schema, so an undeclared field is
    // stripped here. Free-text blocks as /content returns them (2026-11-26).
    const record = (
      id: string,
      unitCode: string,
      freetext: NonNullable<NonNullable<RawEDAN['content']>['freetext']>,
      indexedStructured?: NonNullable<RawEDAN['content']>['indexedStructured'],
    ): RawEDAN => ({
      title: `Object ${id}`,
      unitCode,
      content: {
        descriptiveNonRepeating: { record_ID: id, unit_code: unitCode },
        freetext,
        ...(indexedStructured && { indexedStructured }),
      },
    });

    beforeEach(() => {
      vi.stubEnv('SMITHSONIAN_API_KEY', 'test-key-12345');
      stubContent({
        nmnhvz_7453723: record('nmnhvz_7453723', 'NMNHMAMMALS', {
          physicalDescription: [
            { label: 'Length - Total', content: '335 mm' },
            { label: 'Length - Tail', content: '143 mm' },
            { label: 'Length - Tail', content: '36 mm' },
            { label: 'Preparation', content: 'Skin' },
            { label: 'Preparation', content: 'Skull' },
            { label: 'Sex', content: 'Male' },
          ],
          setName: [
            { label: 'See more items in', content: 'Vertebrate Zoology' },
            { label: 'See more items in', content: 'Mammals' },
          ],
        }),
        nasm_A19610048000: record(
          'nasm_A19610048000',
          'NASM',
          {
            physicalDescription: [
              { label: 'Materials', content: 'Airframe: Wood' },
              { label: 'Materials', content: 'Fabric Covering: Muslin' },
              { label: 'Materials', content: 'Engine Crankcase: Aluminum' },
              { label: 'Dimensions', content: 'Wingspan: 12.3 m (40 ft 4 in)' },
              { label: 'Dimensions', content: 'Length: 6.4 m (21 ft 1 in)' },
              { label: 'Dimensions', content: 'Height: 2.8 m (9 ft 4 in)' },
              { label: 'Dimensions', content: 'Weight: Empty, 274 kg (605 lb)' },
              { label: 'Dimensions', content: 'Gross, 341 kg (750 lb)' },
            ],
            setName: [
              { label: 'See more items in', content: 'National Air and Space Museum Collection' },
              { label: 'Location', content: 'National Air and Space Museum in Washington, DC' },
              { label: 'Exhibition', content: 'Wright Brothers & The Invention of the Aerial Age' },
            ],
            objectRights: [{ label: 'Restrictions & Rights', content: 'CC0' }],
          },
          { onPhysicalExhibit: ['Yes'], exhibition: [{ building: 'NASM' }] },
        ),
        siris_arc_291804: record('siris_arc_291804', 'SIA', {
          physicalDescription: [{ label: 'Physical description', content: '4.38 x 2.59' }],
          setName: [{ label: 'See more items in', content: '007355' }],
          objectRight: [
            { label: 'Restrictions & Rights', content: 'No access restrictions' },
            { label: 'Restrictions & Rights', content: 'No Copyright – United States' },
          ],
        }),
        'nmaahc_2019.26.2': record('nmaahc_2019.26.2', 'NMAAHC', {
          objectRights: [
            { label: 'Restrictions & Rights', content: 'Public domain' },
            {
              label: 'Restrictions & Rights',
              content: 'Proper usage is the responsibility of the user.',
            },
          ],
        }),
        NMAI_58046: record(
          'NMAI_58046',
          'NMAI',
          {
            setName: [
              { label: 'See related items', content: 'Iñupiaq' },
              { label: 'See related items', content: 'Containers and Vessels' },
              {
                label: 'On View',
                content: 'NMAI, New York, NY: Infinity of Nations, Arctic & Subarctic',
              },
            ],
          },
          { onPhysicalExhibit: ['Yes'], exhibition: [{ building: 'NMAI NY' }] },
        ),
        'npg_NPG.91.126.5.A': record('npg_NPG.91.126.5.A', 'NPG', {
          setName: [
            { label: 'See more items in', content: 'National Portrait Gallery Collection' },
            { label: 'Location', content: 'Currently not on view' },
          ],
          objectRights: [{ label: 'Restrictions & Rights', content: 'CC0' }],
        }),
        siris_sil_10451: record('siris_sil_10451', 'SIL', {
          physicalDescription: [
            {
              label: 'Physical description',
              content: '79 p illustrations, facsimile, maps, plan 24 cm',
            },
          ],
        }),
        nmah_bare: record('nmah_bare', 'NMAH', {}),
      });
      vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue(
        new svcModule.SmithsonianService(createInMemoryStorage()),
      );
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    /** The `**<heading>:**` line and the list items under it. */
    function listBlock(text: string, heading: string): string[] {
      const lines = text.split('\n');
      const at = lines.indexOf(`**${heading}:**`);
      if (at === -1) return [];
      const end = lines.findIndex((line, i) => i > at && !line.startsWith('- '));
      return lines.slice(at, end === -1 ? undefined : end);
    }

    it('labels the six specimen entries of nmnhvz_7453723 on both surfaces, with no materials or dimensions', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'nmnhvz_7453723' });

      expect(result.isError).not.toBe(true);
      expect(
        (result.structuredContent as { physical_description: unknown }).physical_description,
      ).toStrictEqual([
        { label: 'Length - Total', value: '335 mm' },
        { label: 'Length - Tail', value: '143 mm' },
        { label: 'Length - Tail', value: '36 mm' },
        { label: 'Preparation', value: 'Skin' },
        { label: 'Preparation', value: 'Skull' },
        { label: 'Sex', value: 'Male' },
      ]);
      expect(result.structuredContent).not.toHaveProperty('materials');
      expect(result.structuredContent).not.toHaveProperty('dimensions');
      const text = textOf(result);
      expect(listBlock(text, 'Physical description')).toEqual([
        '**Physical description:**',
        '- Length - Total: 335 mm',
        '- Length - Tail: 143 mm',
        '- Length - Tail: 36 mm',
        '- Preparation: Skin',
        '- Preparation: Skull',
        '- Sex: Male',
      ]);
      expect(text).not.toContain('**Materials:**');
      expect(text).not.toContain('**Dimensions:**');
    });

    it('renders each of the eight entries of nasm_A19610048000 once, in catalog order (issue #9)', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'nasm_A19610048000' });

      const block = listBlock(textOf(result), 'Physical description');
      expect(block).toEqual([
        '**Physical description:**',
        '- Materials: Airframe: Wood',
        '- Materials: Fabric Covering: Muslin',
        '- Materials: Engine Crankcase: Aluminum',
        '- Dimensions: Wingspan: 12.3 m (40 ft 4 in)',
        '- Dimensions: Length: 6.4 m (21 ft 1 in)',
        '- Dimensions: Height: 2.8 m (9 ft 4 in)',
        '- Dimensions: Weight: Empty, 274 kg (605 lb)',
        '- Dimensions: Gross, 341 kg (750 lb)',
      ]);
      expect(textOf(result).split('Wingspan: 12.3 m')).toHaveLength(2);
    });

    it('returns the three sets of nasm_A19610048000 on both surfaces, and keeps its rights "CC0"', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'nasm_A19610048000' });

      expect((result.structuredContent as { sets: unknown }).sets).toStrictEqual([
        { label: 'See more items in', value: 'National Air and Space Museum Collection' },
        { label: 'Location', value: 'National Air and Space Museum in Washington, DC' },
        { label: 'Exhibition', value: 'Wright Brothers & The Invention of the Aerial Age' },
      ]);
      expect(result.structuredContent).toMatchObject({
        on_view: true,
        current_exhibitions: [{ building: 'NASM' }],
        object_rights: 'CC0',
      });
      const text = textOf(result);
      expect(listBlock(text, 'Sets')).toEqual([
        '**Sets:**',
        '- See more items in: National Air and Space Museum Collection',
        '- Location: National Air and Space Museum in Washington, DC',
        '- Exhibition: Wright Brothers & The Invention of the Aerial Age',
      ]);
      expect(labelValues(text, 'Rights')).toEqual(['CC0']);
    });

    it('returns the On View entry of NMAI_58046 last', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'NMAI_58046' });

      const { sets } = result.structuredContent as {
        sets: Array<{ label: string; value: string }>;
      };
      expect(sets).toHaveLength(3);
      expect(sets.at(-1)).toStrictEqual({
        label: 'On View',
        value: 'NMAI, New York, NY: Infinity of Nations, Arctic & Subarctic',
      });
      expect(listBlock(textOf(result), 'Sets').at(-1)).toBe(
        '- On View: NMAI, New York, NY: Infinity of Nations, Arctic & Subarctic',
      );
    });

    it('relays the not-on-view Location of npg_NPG.91.126.5.A in sets and still omits on_view', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'npg_NPG.91.126.5.A' });

      expect((result.structuredContent as { sets: unknown }).sets).toStrictEqual([
        { label: 'See more items in', value: 'National Portrait Gallery Collection' },
        { label: 'Location', value: 'Currently not on view' },
      ]);
      expect(result.structuredContent).not.toHaveProperty('on_view');
      const text = textOf(result);
      expect(listBlock(text, 'Sets')).toContain('- Location: Currently not on view');
      expect(text).not.toContain('**On view:**');
    });

    it('returns sets [] and renders no Sets heading for siris_sil_10451', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'siris_sil_10451' });

      expect(result.structuredContent).toMatchObject({
        sets: [],
        physical_description: [
          {
            label: 'Physical description',
            value: '79 p illustrations, facsimile, maps, plan 24 cm',
          },
        ],
      });
      expect(textOf(result)).not.toContain('**Sets:**');
    });

    it('joins both singular-key statements of siris_arc_291804 into one Rights line', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'siris_arc_291804' });

      expect(result.structuredContent).toMatchObject({
        object_rights: 'No access restrictions; No Copyright – United States',
        physical_description: [{ label: 'Physical description', value: '4.38 x 2.59' }],
      });
      expect(textOf(result)).toContain(
        '**Rights:** No access restrictions; No Copyright – United States',
      );
    });

    it('keeps the second rights statement of nmaahc_2019.26.2', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'nmaahc_2019.26.2' });

      expect(result.structuredContent).toMatchObject({
        object_rights: 'Public domain; Proper usage is the responsibility of the user.',
      });
      expect(labelValues(textOf(result), 'Rights')).toEqual([
        'Public domain; Proper usage is the responsibility of the user.',
      ]);
    });

    it('returns empty lists, no rights, and none of the three headings for a record without the blocks', async () => {
      const result = await runToolContract(smithsonianGetObject, { id: 'nmah_bare' });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ physical_description: [], sets: [] });
      expect(result.structuredContent).not.toHaveProperty('object_rights');
      const text = textOf(result);
      expect(text).not.toContain('**Physical description:**');
      expect(text).not.toContain('**Sets:**');
      expect(text).not.toContain('**Rights:**');
    });
  });

  describe('content[] encoding (issue #70)', () => {
    /** A projection whose strings carry Markdown syntax, separators, edge spaces, and line breaks. */
    function hostileObject(): FullObject {
      return {
        record_id: 'siris_sil_43136',
        title:
          'Tables of functions with formulae and curves <Funktionentafeln mit Formeln und Kurven> by Dr. Eugene Jahnke ... and Fritz Emde ..',
        unit_code: 'SIL',
        museum_name: 'Smithsonian <Libraries>',
        holding_museum_name: 'Held *here*',
        dates: [{ label: 'Date', value: '©1981-<c1985>' }],
        description: 'A *catalog* description\n\nwith a blank line ',
        notes: [
          { label: 'Notes', content: 'Issues for <winter 1988-> carry also whole numbering.' },
          {
            label: '[Citation]',
            content: '238–241. https://doi.org/10.1130/0091-7613(1986)14<238:CLOARB>2.0.CO;2.',
          },
        ],
        scientific_names: ['Crotalus horridus', 'Genus *sp.*, nov.'],
        taxonomy: { kingdom: ['Animalia'], family: ['Viperidae; sensu lato', '[Incertae sedis]'] },
        coordinates: [
          { latitude: -12.5, longitude: 40, locality: 'Near <river> _bank_' },
          { latitude: 1, longitude: 2 },
        ],
        makers: [
          { role: 'Author', name: 'Jahnke, Eugen, 1861-1921' },
          { role: '*Printer*', name: '[Teubner]' },
        ],
        physical_description: [
          { label: 'Materials', value: 'Ink, paper' },
          { label: '*Medium*', value: 'Gold *leaf*' },
          { label: 'Dimensions', value: '24 cm; 1 vol.' },
          { label: 'Physical description', value: '<2> parts' },
        ],
        place: [
          { label: 'Place', value: 'Leipzig; Berlin' },
          { label: 'Site', value: '# 1 Main St' },
        ],
        culture: ['German, Saxon', 'Plains `Indian`'],
        topics: ['Berberin <Frau>', 'M*A*S*H Television Series', 'Korean War, 1950-1953'],
        indexed: { name: ['Jahnke, Eugen'], place: [], object_type: [], date: [], topic: [] },
        exhibitions: [
          { name: 'Math <Tables>', building: 'NMAH *East*' },
          { name: '- Mathematics' },
        ],
        on_view: true,
        current_exhibitions: [{ title: 'Numbers', building: 'NMAH' }],
        sets: [
          { label: 'See more items in', value: 'Smithsonian <Libraries> Collection' },
          { label: '[On View]', value: '# 1 Gallery: East *Wing*; Floor 2' },
        ],
        credit_line: 'Gift of *someone* ',
        identifiers: [{ label: 'Call number', value: 'QA55 .J27 1909_x' }],
        object_rights: '<a> rights; No *known* copyright',
        is_cc0: true,
        record_link:
          'https://siris-libraries.si.edu/ipac20/ipac.jsp?uri=full=3100001~!43136~!0#focus',
        media_summary: {
          count: 2,
          cc0_image_count: 1,
          has_cc0_images: true,
          thumbnail_url: 'https://ids.si.edu/ids/deliveryService?id=SIL-43136&max=150',
          non_image_media: [
            {
              type: 'Scanned *books*',
              url: 'https://library.si.edu/digital-library/book/tablesoffunctio00jahn',
              is_cc0: true,
            },
          ],
        },
      };
    }

    const render = (obj: FullObject) =>
      smithsonianGetObject.format!(obj)
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('');

    it('renders the bracketed title, date, and topic escaped (siris_sil_43136, _1091363, _1155821)', () => {
      const text = render(hostileObject());
      expect(text.split('\n')[0]).toBe(
        '# Tables of functions with formulae and curves \\<Funktionentafeln mit Formeln und Kurven> by Dr. Eugene Jahnke ... and Fritz Emde ..',
      );
      expect(text).toContain('\n- Date: ©1981-\\<c1985>\n');
      expect(text).toContain('\n- Berberin \\<Frau>\n');
      expect(text).toContain('\n- M\\*A\\*S\\*H Television Series\n');
    });

    it('reads back to every structuredContent value under CommonMark', () => {
      const obj = hostileObject();
      const text = render(obj);

      expect(headings(text)).toEqual([obj.title]);
      expect(codeSpans(text)).toContain(obj.record_id);
      expect(labelValues(text, 'Museum')).toEqual([`${obj.museum_name} (${obj.unit_code})`]);
      expect(labelValues(text, 'Held by')).toEqual([obj.holding_museum_name]);
      expect(labelValues(text, 'Credit')).toEqual([obj.credit_line]);
      expect(labelValues(text, 'Rights')).toEqual([obj.object_rights]);
      expect(paragraphs(text)).toContain(obj.description);
      expect(links(text).map((link) => link.url)).toEqual([
        obj.record_link,
        obj.media_summary.non_image_media[0]?.url,
      ]);
      expect(images(text).map((image) => image.url)).toEqual([obj.media_summary.thumbnail_url]);
      // Every multi-value field one item per value, in order, and no label line folded into the
      // item before it.
      expect(items(text)).toEqual([
        'Date: ©1981-<c1985>',
        'Notes: Issues for <winter 1988-> carry also whole numbering.',
        '[Citation]: 238–241. https://doi.org/10.1130/0091-7613(1986)14<238:CLOARB>2.0.CO;2.',
        'Crotalus horridus',
        'Genus *sp.*, nov.',
        'Animalia',
        'Viperidae; sensu lato',
        '[Incertae sedis]',
        '-12.5, 40 (Near <river> _bank_)',
        '1, 2',
        'Author: Jahnke, Eugen, 1861-1921',
        '*Printer*: [Teubner]',
        'Materials: Ink, paper',
        '*Medium*: Gold *leaf*',
        'Dimensions: 24 cm; 1 vol.',
        'Physical description: <2> parts',
        'German, Saxon',
        'Plains `Indian`',
        'Berberin <Frau>',
        'M*A*S*H Television Series',
        'Korean War, 1950-1953',
        'Place: Leipzig; Berlin',
        'Site: # 1 Main St',
        'name: Jahnke, Eugen',
        'Numbers · NMAH',
        'See more items in: Smithsonian <Libraries> Collection',
        '[On View]: # 1 Gallery: East *Wing*; Floor 2',
        'Math <Tables> (NMAH *East*)',
        '- Mathematics',
        'Call number: QA55 .J27 1909_x',
        'Scanned *books* · CC0: Yes',
      ]);
    });

    it('lists each of the seven topics of nmah_680562 as its own item', () => {
      // nmah_680562 as /content returns its topics (2026-11-15): four indexed, four free-text.
      const raw: RawEDAN = {
        title: 'M*A*S*H Signpost',
        unitCode: 'NMAH',
        content: {
          descriptiveNonRepeating: { record_ID: 'nmah_680562', unit_code: 'NMAH' },
          indexedStructured: {
            topic: ['M*A*S*H Television Series', 'Amusements', 'Military', 'Korean War, 1950-1953'],
          },
          freetext: {
            topic: [
              { label: 'related object association proper name', content: 'M*A*S*H' },
              { label: 'general subject association', content: 'Television' },
              { label: 'general subject association', content: 'Television' },
              { label: 'related event', content: 'Korean War' },
            ],
          },
        },
      };
      const obj = new svcModule.SmithsonianService(createInMemoryStorage()).toFullObject(raw);
      const topics = [
        'M*A*S*H Television Series',
        'Amusements',
        'Military',
        'Korean War, 1950-1953',
        'M*A*S*H',
        'Television',
        'Korean War',
      ];
      expect(obj.topics).toEqual(topics);
      const text = render(obj);
      expect(headings(text)).toEqual(['M*A*S*H Signpost']);
      expect(items(text)).toEqual([...topics, ...obj.indexed.topic.map((t) => `topic: ${t}`)]);
    });
  });
});
