/**
 * @fileoverview Tests for the Open Access mirror store: stored-doc parity with the bulk lines,
 * facet derivation, the read API (`searchFacets`, `getDoc`, readiness), the scan budget and how
 * the service routes a search past it, the query plans of every statement the mirror runs, and
 * the mirror path and refresh schedule config.
 * @module tests/services/smithsonian/oa-mirror.test
 */

import { readFileSync } from 'node:fs';
import { createInMemoryStorage, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMirrorConfig } from '@/config/server-config.js';
import {
  decodeDoc,
  encodeDoc,
  type FacetFilter,
  type FacetSearchResult,
  facetTerms,
  SCAN_BUDGET,
  trimRecord,
} from '@/services/smithsonian/oa-mirror.js';
import {
  SmithsonianService,
  startCallDeadline,
} from '@/services/smithsonian/smithsonian-service.js';
import type { RawEDAN } from '@/services/smithsonian/types.js';
import { bulkLine, FakeBucket, openTestMirror, type TestMirror } from './oa-bucket-fake.js';

type Line = Record<string, unknown> & RawEDAN;

/**
 * Real `metadata/edan/` lines, byte for byte: eight `edanmdm` records and one `ead_component`
 * from the 2026-10-26 publish, then `siris_arc_396415` (`sia/0f.txt`) and `dpo_3d_200016`
 * (`ocio_dpo3d/bf.txt`) from the 2026-11-23 publish.
 */
const FIXTURE_LINES = readFileSync(
  new URL('./fixtures/oa-bulk-lines.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter(Boolean);
const LINES = FIXTURE_LINES.map((l) => JSON.parse(l) as Line);
const RECORDS = LINES.filter((l) => l.type === 'edanmdm');

const svc = new SmithsonianService(createInMemoryStorage());

const stored = (line: Line) => decodeDoc(encodeDoc(trimRecord(line)));
const byUrl = (url: string) => {
  const line = RECORDS.find((r) => r.url === url);
  if (!line) throw new Error(`fixture lacks ${url}`);
  return line;
};

/**
 * Every output a normalizer derives from a record, plus what smithsonian_find_related reads
 * from the raw anchor: the indexed signal fields, the indexed names it can pick from, and the
 * freetext names that carry content.
 */
function readings(raw: RawEDAN) {
  const indexed = raw.content?.indexedStructured;
  return {
    full: svc.toFullObject(raw),
    summary: svc.toSummary(raw),
    images: svc.toImageItems(raw),
    cc0: svc.isCC0(raw),
    related: {
      culture: indexed?.culture,
      topic: indexed?.topic,
      object_type: indexed?.object_type,
      date: indexed?.date,
      names: (indexed?.name ?? [])
        .map((n) => (typeof n === 'string' ? n : n.content))
        .filter(Boolean),
      freetextNames: (raw.content?.freetext?.name ?? [])
        .filter((e) => e.content)
        .map((e) => ({ label: e.label, content: e.content })),
    },
  };
}

describe('stored doc', () => {
  it('fixture covers the shapes parity depends on', () => {
    const ocio = RECORDS.filter(
      (r) =>
        r.unitCode === 'OCIO_DPO3D' && r.content?.descriptiveNonRepeating?.unit_code !== r.unitCode,
    );
    expect(ocio.length).toBeGreaterThan(0);
    const media = RECORDS.flatMap(
      (r) => r.content?.descriptiveNonRepeating?.online_media?.media ?? [],
    );
    expect(media.some((m) => m.type && m.type !== 'Images')).toBe(true);
    expect(media.some((m) => (m.resources ?? []).some((res) => res.width !== undefined))).toBe(
      true,
    );
    expect(RECORDS.some((r) => svc.toFullObject(r).coordinates.length > 0)).toBe(true);
    expect(RECORDS.some((r) => svc.toFullObject(r).taxonomy !== undefined)).toBe(true);
    expect(
      RECORDS.some((r) => r.content?.indexedStructured?.name?.some((n) => typeof n !== 'string')),
    ).toBe(true);
    expect(RECORDS.some((r) => svc.toFullObject(r).current_exhibitions.length > 0)).toBe(true);
    expect(LINES.some((l) => l.type !== 'edanmdm')).toBe(true);
  });

  it.each(RECORDS.map((r) => [r.url, r] as const))(
    'normalizes %s identically from the stored doc',
    (_, line) => {
      expect(readings(stored(line))).toStrictEqual(readings(line));
    },
  );

  it('returns the indexed filter values of a wrapped-name record from the stored doc (issue #73)', () => {
    const line = byUrl('edanmdm:slasro_79883');
    const fromStored = svc.toFullObject(stored(line)).indexed;
    expect(fromStored.name).toEqual(['Stewart, M. M.', 'Biuso, L. F.']);
    expect(fromStored).toStrictEqual(svc.toFullObject(line).indexed);
  });

  it('returns the on-view flag and venue of nasm_A19820121000 from the stored doc (issue #74)', () => {
    const line = byUrl('edanmdm:nasm_A19820121000');
    const fromStored = svc.toFullObject(stored(line));
    expect(fromStored).toMatchObject({
      on_view: true,
      current_exhibitions: [{ building: 'HAZY' }],
    });
    expect(fromStored.current_exhibitions).toStrictEqual(
      svc.toFullObject(line).current_exhibitions,
    );
  });

  it('stores each exhibition entry as its building, room, and exhibitionTitle only (issue #74)', () => {
    const doc = trimRecord(
      JSON.parse(
        bulkLine('ex1', {
          content: {
            indexedStructured: {
              onPhysicalExhibit: ['Yes'],
              exhibition: [
                {
                  building: 'NPG',
                  room: 'East Gallery 142',
                  exhibitionTitle: 'Out of Many: Portraits from 1600 to 1900',
                  exhibitionId: 'npg-oom',
                  startDate: '2020-11-20',
                  sponsors: [{ name: 'Sponsor' }],
                },
                { exhibitionId: 'nothing-kept' },
                'HAZY',
                { building: 'HAZY', endDate: '2027-01-01' },
              ],
            },
          },
        }),
      ),
    );
    expect(doc.content?.indexedStructured).toStrictEqual({
      onPhysicalExhibit: ['Yes'],
      exhibition: [
        {
          building: 'NPG',
          room: 'East Gallery 142',
          exhibitionTitle: 'Out of Many: Portraits from 1600 to 1900',
        },
        { building: 'HAZY' },
      ],
    });
  });

  it('keeps the indexed unit of an OCIO_DPO3D record whose own unit code differs', () => {
    const line = byUrl('edanmdm:dpo_3d_200122');
    expect(line.content?.descriptiveNonRepeating?.unit_code).toBe('SAO');
    const summary = svc.toSummary(stored(line));
    expect(summary.unit_code).toBe('OCIO_DPO3D');
    expect(summary).toStrictEqual(svc.toSummary(line));
  });

  it('keeps every setName and objectRight entry with content as its label and content (issues #81, #82)', () => {
    const doc = trimRecord(
      JSON.parse(
        bulkLine('ft1', {
          content: {
            freetext: {
              setName: [
                {
                  label: 'See more items in',
                  content: 'National Air and Space Museum Collection',
                  indexedContent: 'National Air and Space Museum Collection',
                },
                { label: 'Location' },
                {
                  label: 'Exhibition',
                  content: 'Wright Brothers & The Invention of the Aerial Age',
                },
              ],
              objectRight: [
                { label: 'Restrictions & Rights', content: 'No access restrictions' },
                { label: 'Restrictions & Rights', content: '' },
                { label: 'Restrictions & Rights', content: 'No Copyright – United States' },
              ],
              publisher: [{ label: 'Publisher', content: 'Not stored' }],
            },
          },
        }),
      ),
    );
    expect(doc.content?.freetext).toStrictEqual({
      setName: [
        { label: 'See more items in', content: 'National Air and Space Museum Collection' },
        { label: 'Exhibition', content: 'Wright Brothers & The Invention of the Aerial Age' },
      ],
      objectRight: [
        { label: 'Restrictions & Rights', content: 'No access restrictions' },
        { label: 'Restrictions & Rights', content: 'No Copyright – United States' },
      ],
    });
  });

  it('keeps the setName and SIA objectRight entries of the fixture lines (issues #81, #82)', () => {
    expect(stored(byUrl('edanmdm:siris_arc_396415')).content?.freetext?.objectRight).toStrictEqual([
      { label: 'Restrictions & Rights', content: 'No access restrictions' },
      { label: 'Restrictions & Rights', content: 'No Copyright – United States' },
    ]);
    expect(stored(byUrl('edanmdm:nasm_A19820121000')).content?.freetext?.setName).toStrictEqual([
      { label: 'See more items in', content: 'National Air and Space Museum Collection' },
      { label: 'Location', content: 'Steven F. Udvar-Hazy Center in Chantilly, VA' },
      { label: 'Exhibit Station', content: 'Rockets & Missiles' },
    ]);
    const withSets = RECORDS.filter((r) => r.content?.freetext?.setName);
    expect(withSets).toHaveLength(6);
    for (const line of withSets) {
      expect(stored(line).content?.freetext?.setName).toStrictEqual(
        line.content?.freetext?.setName?.map(({ label, content }) => ({ label, content })),
      );
    }
  });

  it('keeps each 3D file’s category, filename, and model attributes in their upstream layout, and image resources as before (issue #83)', () => {
    const file = (filename: string, attributes: unknown) => ({
      url: `https://3d-api.si.edu/content/document/3d_package:p1/resources/${filename}`,
      name: 'Model',
      type: '3D mesh',
      title: `Model (${filename})`,
      category: 'Low resolution',
      filename,
      attributes,
    });
    const url = (filename: string) =>
      `https://3d-api.si.edu/content/document/3d_package:p1/resources/${filename}`;
    const doc = trimRecord(
      JSON.parse(
        bulkLine('m1', {
          content: {
            descriptiveNonRepeating: {
              online_media: {
                mediaCount: 2,
                media: [
                  {
                    id: '3d_package:p1',
                    type: '3d_voyager',
                    usage: { text: '', codes: '', access: 'CC0' },
                    content: 'https://3d-api.si.edu/voyager/3d_package:p1',
                    voyagerId: '3d_package:p1',
                    resources: [
                      // One object holding every key.
                      file('combined.glb', [
                        {
                          UNITS: 'm',
                          FILE_TYPE: 'glb',
                          MODEL_FILE_TYPE: 'glb',
                          DRACO_COMPRESSED: false,
                          GLTF_STANDARDIZED: true,
                          FILE_SIZE: 100,
                        },
                      ]),
                      // FILE_SIZE in an object of its own.
                      file('split.glb', [
                        {
                          UNITS: 'm',
                          FILE_TYPE: 'draco compressed glb',
                          MODEL_FILE_TYPE: 'draco compressed glb',
                          DRACO_COMPRESSED: true,
                          GLTF_STANDARDIZED: false,
                        },
                        { FILE_SIZE: 200 },
                      ]),
                      // One key per object.
                      file('per-key.zip', [
                        { UNITS: 'mm' },
                        { MODEL_FILE_TYPE: 'obj' },
                        { FILE_TYPE: 'zip' },
                        { GLTF_STANDARDIZED: false },
                        { FILE_SIZE: 300 },
                      ]),
                      { url: url('bare.zip'), name: 'Model', filename: 'bare.zip', attributes: [] },
                    ],
                  },
                  {
                    idsId: 'img1',
                    type: 'Images',
                    usage: { access: 'CC0' },
                    resources: [
                      {
                        label: 'High-resolution JPEG',
                        url: 'https://ids.si.edu/ids/download?id=img1.jpg',
                        width: 3000,
                        height: 2000,
                        dimensions: '3000x2000',
                      },
                      {
                        label: 'Screen Image',
                        url: 'https://ids.si.edu/ids/deliveryService?id=img1',
                      },
                    ],
                  },
                ],
              },
            },
          },
        }),
      ),
    );
    const media = doc.content?.descriptiveNonRepeating?.online_media?.media ?? [];
    expect(media.map((m) => m.resources)).toStrictEqual([
      [
        {
          url: url('combined.glb'),
          category: 'Low resolution',
          filename: 'combined.glb',
          attributes: [
            {
              UNITS: 'm',
              FILE_TYPE: 'glb',
              MODEL_FILE_TYPE: 'glb',
              DRACO_COMPRESSED: false,
              FILE_SIZE: 100,
            },
          ],
        },
        {
          url: url('split.glb'),
          category: 'Low resolution',
          filename: 'split.glb',
          attributes: [
            {
              UNITS: 'm',
              FILE_TYPE: 'draco compressed glb',
              MODEL_FILE_TYPE: 'draco compressed glb',
              DRACO_COMPRESSED: true,
            },
            { FILE_SIZE: 200 },
          ],
        },
        {
          url: url('per-key.zip'),
          category: 'Low resolution',
          filename: 'per-key.zip',
          attributes: [
            { UNITS: 'mm' },
            { MODEL_FILE_TYPE: 'obj' },
            { FILE_TYPE: 'zip' },
            {},
            { FILE_SIZE: 300 },
          ],
        },
        { url: url('bare.zip'), filename: 'bare.zip', attributes: [] },
      ],
      [
        {
          label: 'High-resolution JPEG',
          url: 'https://ids.si.edu/ids/download?id=img1.jpg',
          width: 3000,
          height: 2000,
        },
        { label: 'Screen Image', url: 'https://ids.si.edu/ids/deliveryService?id=img1' },
      ],
    ]);
  });

  it('stores the 3D files of the fixture lines as their bulk lines list them (issue #83)', () => {
    type File = Record<string, unknown> & { attributes: Array<Record<string, unknown>> };
    const files = (doc: RawEDAN) =>
      (doc.content?.descriptiveNonRepeating?.online_media?.media ?? [])
        .filter((m) => m.type === '3d_voyager')
        .flatMap((m) => (m.resources ?? []) as unknown as File[]);
    for (const url of ['edanmdm:dpo_3d_200122', 'edanmdm:dpo_3d_200016']) {
      const line = byUrl(url);
      const listed = files(line);
      expect(listed.length).toBeGreaterThan(0);
      expect(files(stored(line))).toStrictEqual(
        listed.map(({ url, category, filename, attributes }) => ({
          url,
          category,
          filename,
          attributes: attributes.map(({ GLTF_STANDARDIZED: _, ...kept }) => kept),
        })),
      );
    }
    expect(files(stored(byUrl('edanmdm:dpo_3d_200016')))[0]).toStrictEqual({
      url: 'https://3d-api.si.edu/content/document/3d_package:64ff5dbe-cf46-486e-8b3a-cb8e1fd7895c/resources/mpc_684-full-res.obj.zip',
      category: 'Full resolution',
      filename: 'mpc_684-full-res.obj.zip',
      attributes: [
        { UNITS: 'mm' },
        { MODEL_FILE_TYPE: 'obj' },
        { FILE_TYPE: 'zip' },
        { FILE_SIZE: 56991185 },
      ],
    });
  });

  it('drops every field no reader uses', () => {
    const kept = {
      record: ['content', 'title', 'unitCode', 'url'],
      descriptive: [
        'data_source',
        'metadata_usage',
        'online_media',
        'record_ID',
        'record_link',
        'unit_code',
      ],
      media: [
        'altTextAccessibility',
        'content',
        'extDescrAccessibility',
        'id',
        'idsId',
        'resources',
        'thumbnail',
        'type',
        'usage',
      ],
      resource: ['attributes', 'category', 'filename', 'height', 'label', 'url', 'width'],
      attribute: ['DRACO_COMPRESSED', 'FILE_SIZE', 'FILE_TYPE', 'MODEL_FILE_TYPE', 'UNITS'],
      freetext: [
        'creditLine',
        'date',
        'exhibitionHistory',
        'identifier',
        'name',
        'notes',
        'objectRight',
        'objectRights',
        'physicalDescription',
        'place',
        'setName',
        'topic',
      ],
    };
    const keysAt = (docs: RawEDAN[]) => {
      const dnrs = docs.flatMap((d) => d.content?.descriptiveNonRepeating ?? []);
      const media = dnrs.flatMap((d) => d.online_media?.media ?? []);
      const resources = media.flatMap((m) => (m.resources ?? []) as Array<Record<string, unknown>>);
      return {
        record: new Set(docs.flatMap(Object.keys)),
        descriptive: new Set(dnrs.flatMap(Object.keys)),
        media: new Set(media.flatMap(Object.keys)),
        resource: new Set(resources.flatMap(Object.keys)),
        attribute: new Set(
          resources
            .flatMap((r) => (Array.isArray(r.attributes) ? r.attributes : []))
            .flatMap(Object.keys),
        ),
        freetext: new Set(docs.flatMap((d) => Object.keys(d.content?.freetext ?? {}))),
      };
    };
    const raw = keysAt(RECORDS);
    const trimmed = keysAt(RECORDS.map(stored));
    for (const level of Object.keys(kept) as Array<keyof typeof kept>) {
      // The fixture carries fields to drop at every level (hash, guid, maxsize, name, GLTF_STANDARDIZED, publisher, …).
      expect([...raw[level]].filter((k) => !kept[level].includes(k)).length).toBeGreaterThan(0);
      expect([...trimmed[level]].filter((k) => !kept[level].includes(k))).toEqual([]);
    }
  });

  const base = () => structuredClone(byUrl('edanmdm:nmnhvz_14945304')) as Line;
  const content = (line: Line) => line.content as NonNullable<Line['content']>;
  const variants: Array<[string, (line: Line) => void]> = [
    [
      'null and empty accessibility text',
      (line) => {
        const media = content(line).descriptiveNonRepeating?.online_media?.media ?? [];
        Object.assign(media[0] ?? {}, { altTextAccessibility: null, extDescrAccessibility: '' });
      },
    ],
    [
      'resources with null and missing dimensions',
      (line) => {
        const item = content(line).descriptiveNonRepeating?.online_media?.media?.[0];
        if (item) {
          Object.assign(item, {
            resources: [
              { label: 'High-resolution JPEG', url: 'https://x/a.jpg', width: null, height: null },
              { label: 'Screen Image', url: 'https://x/s.jpg' },
              { label: 'TIFF', width: 10, height: 20 },
            ],
          });
        }
      },
    ],
    [
      'media items without ids or types',
      (line) => {
        content(line).descriptiveNonRepeating?.online_media?.media?.push(
          { thumbnail: 'https://x/t.jpg' },
          { type: 'Images' },
          { type: '3d_voyager', content: 'https://x/v', usage: { access: 'CC0' } },
          { type: 'Electronic resource' },
        );
      },
    ],
    [
      'mediaCount without media',
      (line) => {
        const dnr = content(line).descriptiveNonRepeating ?? {};
        dnr.online_media = { mediaCount: 3 };
      },
    ],
    [
      'media without mediaCount',
      (line) => {
        delete content(line).descriptiveNonRepeating?.online_media?.mediaCount;
      },
    ],
    [
      'empty taxonomy arrays',
      (line) => {
        Object.assign(content(line).indexedStructured ?? {}, { tax_class: [], tax_order: [] });
      },
    ],
    [
      'freetext entries without content',
      (line) => {
        content(line).freetext = {
          ...content(line).freetext,
          notes: [
            { label: 'Summary' },
            { label: 'Summary', content: '' },
            { label: 'Summary', content: 'Real' },
          ],
          exhibitionHistory: [
            { label: 'Hall', content: 'Ex' },
            { content: 'Ex2' },
            { label: 'Only' },
          ],
          name: [{ label: 'Collector' }, { label: 'Collector', content: 'Smith, J.' }],
        };
      },
    ],
    [
      'geoLocations of every shape',
      (line) => {
        Object.assign(content(line).indexedStructured ?? {}, {
          geoLocation: [
            {
              points: {
                point: {
                  latitude: { type: 'decimal', content: '10.5' },
                  longitude: { type: 'decimal', content: '-20' },
                },
              },
              Other: { type: 'Locality', content: 'Reef' },
            },
            {
              points: {
                point: {
                  latitude: { type: 'degrees', content: '10' },
                  longitude: { type: 'degrees', content: '20' },
                },
              },
            },
            { Other: { type: 'Ocean', content: 'Atlantic' } },
            {},
          ],
        });
      },
    ],
    [
      'indexed names of both forms',
      (line) => {
        Object.assign(content(line).indexedStructured ?? {}, {
          name: ['Plain, Name', { type: 'author', content: 'Wrapped, Name' }, { type: 'author' }],
        });
      },
    ],
    [
      'on-view flags and exhibitions of every shape',
      (line) => {
        Object.assign(content(line).indexedStructured ?? {}, {
          onPhysicalExhibit: ['No', 'Yes'],
          exhibition: [
            { building: 'NPG', room: 'East Gallery 142', exhibitionTitle: 'Out of Many' },
            { room: 'Gallery 1', exhibitionId: 'x' },
            { exhibitionTitle: 'Untitled' },
            { building: '', room: null, exhibitionTitle: 7 },
            {},
            null,
            'NASM',
          ],
        });
      },
    ],
    [
      'an off-view flag and no exhibitions',
      (line) => {
        Object.assign(content(line).indexedStructured ?? {}, {
          onPhysicalExhibit: ['No'],
          exhibition: [],
        });
      },
    ],
    [
      'no record_ID',
      (line) => {
        delete content(line).descriptiveNonRepeating?.record_ID;
      },
    ],
    [
      'no content block',
      (line) => {
        delete line.content;
      },
    ],
  ];

  it.each(variants)('normalizes a record with %s identically from the stored doc', (_, mutate) => {
    const line = base();
    mutate(line);
    expect(readings(stored(line))).toStrictEqual(readings(line));
  });
});

describe('facetTerms', () => {
  const values = (doc: RawEDAN) =>
    [...facetTerms(doc).values()].map((t) => `${t.field}=${t.value}`).sort();

  it('indexes the top-level unitCode, not the record’s own unit code', () => {
    const terms = values(stored(byUrl('edanmdm:dpo_3d_200122')));
    expect(terms).toContain('unit_code=OCIO_DPO3D');
    expect(terms.some((t) => t.includes('SAO'))).toBe(false);
  });

  it('indexes every source field, name in both forms, and the presence flags', () => {
    const doc = trimRecord(
      JSON.parse(
        bulkLine('f1', {
          unitCode: 'NMAH',
          content: {
            descriptiveNonRepeating: {
              online_media: { media: [{ type: 'Images', usage: { access: 'CC0' } }] },
            },
            indexedStructured: {
              object_type: ['Quilts', 'Quilts'],
              date: ['1860s'],
              culture: ['Amish'],
              place: ['Ohio', ''],
              topic: ['Textiles'],
              scientific_name: ['Gossypium'],
              online_media_type: ['Images'],
              name: ['Doe, Jane', { type: 'maker', content: 'Roe, Rick' }, { type: 'maker' }],
            },
          },
        }),
      ),
    );
    expect(values(doc)).toEqual([
      'cc0=true',
      'culture=Amish',
      'date=1860s',
      'name=Doe, Jane',
      'name=Roe, Rick',
      'object_type=Quilts',
      'online_media_type=Images',
      'online_only=true',
      'place=Ohio',
      'scientific_name=Gossypium',
      'topic=Textiles',
      'unit_code=NMAH',
    ]);
  });

  it('sets no presence flag without online media types or CC0 media', () => {
    const doc = trimRecord(
      JSON.parse(
        bulkLine('f2', {
          content: {
            descriptiveNonRepeating: {
              online_media: { media: [{ type: 'Images', usage: { access: 'In Copyright' } }] },
            },
            indexedStructured: { online_media_type: [] },
          },
        }),
      ),
    );
    expect(values(doc)).toEqual(['unit_code=TST']);
  });

  it.each([
    ['["Yes"]', ['Yes'], ['on_view=true', 'unit_code=TST']],
    ['["No", "Yes"]', ['No', 'Yes'], ['on_view=true', 'unit_code=TST']],
    ['["No"]', ['No'], ['unit_code=TST']],
    ['[]', [], ['unit_code=TST']],
    ['no flag', undefined, ['unit_code=TST']],
  ])(
    'sets on_view for onPhysicalExhibit %s only when it holds "Yes" (issue #74)',
    (_, flag, expected) => {
      const doc = trimRecord(
        JSON.parse(
          bulkLine('ov', {
            content: {
              indexedStructured: {
                ...(flag && { onPhysicalExhibit: flag }),
                exhibition: [{ building: 'NASM', room: 'Hall', exhibitionTitle: 'Flight' }],
              },
            },
          }),
        ),
      );
      expect(values(doc)).toEqual(expected);
    },
  );

  it('indexes the fixture record flagged on view under on_view (issue #74)', () => {
    const flagged = RECORDS.filter((r) => facetTerms(stored(r)).has('on_view\u0000true'));
    expect(flagged.map((r) => r.url)).toEqual(['edanmdm:nasm_A19820121000']);
  });
});

describe('read API', () => {
  let bucket: FakeBucket;
  let t: TestMirror;

  beforeEach(async () => {
    bucket = new FakeBucket();
    vi.stubGlobal('fetch', bucket.fetch);
    t = openTestMirror();
    bucket.put('metadata/edan/aaa/00.txt', FIXTURE_LINES.slice(0, 5));
    bucket.put('metadata/edan/bbb/00.txt', FIXTURE_LINES.slice(5));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  const page = (result: FacetSearchResult) => {
    if (result.kind !== 'page') throw new Error(`expected a page, got ${JSON.stringify(result)}`);
    return { total: result.total, urls: result.docs.map((d) => d.url) };
  };
  const search = async (filters: FacetFilter[], start = 0, rows = 10) =>
    page(await t.reader.searchFacets(filters, start, rows));

  it('is not ready, and has no snapshot, before a sync completes', async () => {
    expect(await t.reader.ready()).toBe(false);
    expect(await t.reader.snapshot()).toBeUndefined();
    await expect(t.reader.searchFacets([], 0, 10)).rejects.toThrow(/not completed a sync/);
  });

  it('returns a stored doc by url, and undefined for one it does not hold', async () => {
    await t.mirror.runSync({ mode: 'init' });
    const doc = await t.reader.getDoc('edanmdm:hac_FJP.1987.074');
    expect(doc).toStrictEqual(stored(byUrl('edanmdm:hac_FJP.1987.074')));
    expect(await t.reader.getDoc('edanmdm:not_mirrored')).toBeUndefined();
    expect(await t.reader.getDoc('ead_component:sova-eepa-1986-011-ref515')).toBeUndefined();
  });

  describe('searchFacets', () => {
    beforeEach(async () => {
      await t.mirror.runSync({ mode: 'init' });
    });

    it('pages one term in ingest order, with its total from the term count', async () => {
      expect(await search([{ field: 'unit_code', value: 'OCIO_DPO3D' }])).toEqual({
        total: 3,
        urls: ['edanmdm:dpo_3d_200122', 'edanmdm:dpo_3d_200085', 'edanmdm:dpo_3d_200016'],
      });
      expect(await search([{ field: 'online_only' }], 1, 2)).toEqual({
        total: 5,
        urls: ['edanmdm:nmnhvz_14945304', 'edanmdm:hac_FJP.1987.074'],
      });
      expect(await search([{ field: 'online_only' }], 5, 2)).toEqual({ total: 5, urls: [] });
    });

    it('intersects several terms and counts the intersection', async () => {
      expect(await search([{ field: 'online_only' }, { field: 'cc0' }])).toEqual({
        total: 3,
        urls: ['edanmdm:nasm_A19820121000', 'edanmdm:nmnhvz_14945304', 'edanmdm:hac_FJP.1987.074'],
      });
      expect(
        await search([
          { field: 'topic', value: 'Fishes' },
          { field: 'online_only' },
          { field: 'cc0' },
        ]),
      ).toEqual({ total: 1, urls: ['edanmdm:nmnhvz_14945304'] });
      expect(await search([{ field: 'online_only' }, { field: 'cc0' }], 2, 5)).toEqual({
        total: 3,
        urls: ['edanmdm:hac_FJP.1987.074'],
      });
    });

    it('matches values exactly and case-sensitively, including wrapped names', async () => {
      expect(await search([{ field: 'name', value: 'Stewart, M. M.' }])).toEqual({
        total: 1,
        urls: ['edanmdm:slasro_79883'],
      });
      expect(await search([{ field: 'unit_code', value: 'nasm' }])).toEqual({ total: 0, urls: [] });
      expect(await search([{ field: 'unit_code', value: 'SAO' }])).toEqual({ total: 0, urls: [] });
      expect(
        await search([
          { field: 'unit_code', value: 'NASM' },
          { field: 'topic', value: 'Nope' },
        ]),
      ).toEqual({ total: 0, urls: [] });
    });

    it('counts a repeated filter once', async () => {
      expect(
        await search([
          { field: 'unit_code', value: 'NMNHFISHES' },
          { field: 'unit_code', value: 'NMNHFISHES' },
        ]),
      ).toEqual({ total: 2, urls: ['edanmdm:nmnhvz_14945304', 'edanmdm:nmnhvz_5105499'] });
    });

    it('pages every record with no filter, with the total from the last sync', async () => {
      expect(await search([], 6, 5)).toEqual({
        total: 10,
        urls: [
          'edanmdm:hac_FJP.1987.074',
          'edanmdm:nmnheducation_11054667',
          'edanmdm:siris_arc_396415',
          'edanmdm:dpo_3d_200016',
        ],
      });
    });

    it('returns docs the normalizers read exactly as the bulk lines', async () => {
      const result = await t.reader.searchFacets([{ field: 'cc0' }], 0, 10);
      if (result.kind !== 'page') throw new Error('expected a page');
      expect(result.docs.map((d) => svc.toSummary(d))).toStrictEqual(
        result.docs.map((d) => svc.toSummary(byUrl(d.url ?? ''))),
      );
    });

    it('pages on_view alone and intersected, with the facet count as its total (issue #74)', async () => {
      const onView = { urls: ['edanmdm:nasm_A19820121000'], total: 1 };
      expect(await search([{ field: 'on_view' }])).toEqual(onView);
      expect(await search([{ field: 'on_view' }, { field: 'unit_code', value: 'NASM' }])).toEqual(
        onView,
      );
      expect(await search([{ field: 'on_view' }, { field: 'cc0' }])).toEqual(onView);
      expect(
        await search([{ field: 'on_view' }, { field: 'unit_code', value: 'NMNHFISHES' }]),
      ).toEqual({ total: 0, urls: [] });
      expect(await search([{ field: 'on_view' }], 1, 10)).toEqual({ total: 1, urls: [] });
    });
  });

  describe('a shard awaiting its re-read after a schema change (issue #74)', () => {
    /** Shard aaa holds the first five fixture records, nasm_A19820121000 among them. */
    const STALE_KEY = 'metadata/edan/aaa/00.txt';
    const IN_STALE = 'edanmdm:nasm_A19820121000';
    const IN_CURRENT = 'edanmdm:hac_FJP.1987.074';

    beforeEach(async () => {
      await t.mirror.runSync({ mode: 'init' });
    });

    /** Clear one shard's ETag, as the version-2 migration clears every shard's. */
    async function staleShard(): Promise<void> {
      (await t.store.raw()).prepare('UPDATE shards SET etag = NULL WHERE key = ?').run(STALE_KEY);
    }

    it('serves every stored doc and reports no stale shard while every ETag is set', async () => {
      expect(await t.reader.hasStaleShards()).toBe(false);
      expect(await t.reader.getDoc(IN_STALE)).toStrictEqual(stored(byUrl(IN_STALE)));
    });

    it('withholds the docs of that shard only, and reports it', async () => {
      await staleShard();

      expect(await t.reader.hasStaleShards()).toBe(true);
      expect(await t.reader.getDoc(IN_STALE)).toBeUndefined();
      expect(await t.reader.getDoc('edanmdm:nmnhvz_5105499')).toBeUndefined();
      expect(await t.reader.getDoc(IN_CURRENT)).toStrictEqual(stored(byUrl(IN_CURRENT)));
      expect(await t.reader.ready()).toBe(true);
    });

    it('declines every on_view search and still pages the others, its records included', async () => {
      await staleShard();

      expect(await t.reader.searchFacets([{ field: 'on_view' }], 0, 10)).toEqual({
        kind: 'stale',
      });
      expect(
        await t.reader.searchFacets(
          [{ field: 'unit_code', value: 'NASM' }, { field: 'on_view' }],
          0,
          10,
        ),
      ).toEqual({ kind: 'stale' });
      expect(await search([{ field: 'unit_code', value: 'NASM' }])).toEqual({
        total: 1,
        urls: [IN_STALE],
      });
      expect(await search([{ field: 'online_only' }, { field: 'cc0' }])).toEqual({
        total: 3,
        urls: [IN_STALE, 'edanmdm:nmnhvz_14945304', IN_CURRENT],
      });
      expect((await search([], 0, 1)).total).toBe(10);
    });

    it('serves that shard again once a refresh re-reads it, downloading it alone', async () => {
      await staleShard();
      bucket.requests.length = 0;

      await t.mirror.runSync({ mode: 'refresh' });

      expect(bucket.downloads()).toEqual([STALE_KEY]);
      expect(await t.reader.hasStaleShards()).toBe(false);
      expect(await t.reader.getDoc(IN_STALE)).toStrictEqual(stored(byUrl(IN_STALE)));
      expect(await search([{ field: 'on_view' }])).toEqual({ total: 1, urls: [IN_STALE] });
    });
  });
});

describe('scan budget', () => {
  // 100,001 records: all under unit BIG and place P, all but the last under topic T.
  const SIZE = SCAN_BUDGET + 1;
  let bucket: FakeBucket;
  let t: TestMirror;

  beforeAll(async () => {
    bucket = new FakeBucket();
    vi.stubGlobal('fetch', bucket.fetch);
    t = openTestMirror();
    const lines = Array.from({ length: SIZE }, (_, i) =>
      JSON.stringify({
        type: 'edanmdm',
        url: `edanmdm:big_${i}`,
        unitCode: 'BIG',
        content: { indexedStructured: { place: ['P'], ...(i < SCAN_BUDGET && { topic: ['T'] }) } },
      }),
    );
    bucket.put('metadata/edan/big/00.txt', lines);
    await t.mirror.runSync({ mode: 'init' });
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  const run = (filters: FacetFilter[], start: number, rows: number) =>
    t.reader.searchFacets(filters, start, rows);
  const summarize = (r: FacetSearchResult) =>
    r.kind === 'page' ? { kind: r.kind, total: r.total, docs: r.docs.length } : r;

  it('serves one term up to the budget and declines one entry past it', async () => {
    const big: FacetFilter[] = [{ field: 'unit_code', value: 'BIG' }];
    expect(summarize(await run(big, SCAN_BUDGET - 10, 10))).toEqual({
      kind: 'page',
      total: SIZE,
      docs: 10,
    });
    expect(summarize(await run(big, SCAN_BUDGET - 9, 10))).toEqual({
      kind: 'over_budget',
      entries: SCAN_BUDGET + 1,
    });
  });

  it('walks a term only to the end of its range, however far the page reaches', async () => {
    const result = await run([{ field: 'topic', value: 'T' }], SCAN_BUDGET - 5, 1_000);
    expect(summarize(result)).toEqual({ kind: 'page', total: SCAN_BUDGET, docs: 5 });
  });

  it('charges an intersection the whole range of its rarest term', async () => {
    const both: FacetFilter[] = [
      { field: 'unit_code', value: 'BIG' },
      { field: 'topic', value: 'T' },
    ];
    expect(summarize(await run(both, 0, 20))).toEqual({
      kind: 'page',
      total: SCAN_BUDGET,
      docs: 20,
    });
    const wide: FacetFilter[] = [
      { field: 'unit_code', value: 'BIG' },
      { field: 'place', value: 'P' },
    ];
    expect(summarize(await run(wide, 0, 20))).toEqual({
      kind: 'over_budget',
      entries: SIZE,
    });
  });

  it('serves the unfiltered walk up to the budget and declines one entry past it', async () => {
    expect(summarize(await run([], SCAN_BUDGET - 5, 5))).toEqual({
      kind: 'page',
      total: SIZE,
      docs: 5,
    });
    expect(summarize(await run([], SCAN_BUDGET - 4, 5))).toEqual({
      kind: 'over_budget',
      entries: SCAN_BUDGET + 1,
    });
  });

  describe('routing a filter-only search through the service (issue #66)', () => {
    /** The live API's page for any search: 7 hits, unlike every mirror answer here. */
    const LIVE_PAGE = {
      status: 200,
      responseCode: 1,
      response: {
        rows: [
          {
            url: 'edanmdm:live_1',
            title: 'Live',
            content: { descriptiveNonRepeating: { record_ID: 'live_1' } },
          },
        ],
        rowCount: 7,
      },
    };

    const requestUrl = (input: string | URL | Request) =>
      new URL(input instanceof Request ? input.url : input);

    /** The live API at its default base URL: `/search` answers {@link LIVE_PAGE}, anything else rejects. */
    function stubEdan() {
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.hostname !== 'api.si.edu' || url.pathname !== '/openaccess/api/v1.0/search') {
          throw new Error('unmocked fetch');
        }
        return new Response(JSON.stringify(LIVE_PAGE), { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    const searchWith = (svc: SmithsonianService, filters: FacetFilter[]) =>
      svc.search(
        { query: '', rows: 20, start: 0, filters },
        createMockContext({ tenantId: 'test-tenant' }),
        startCallDeadline(),
      );

    beforeEach(() => {
      vi.stubEnv('SMITHSONIAN_API_KEY', 'test-key-12345');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('serves an intersection within the budget from the mirror, with no EDAN request', async () => {
      const edan = stubEdan();

      const page = await searchWith(new SmithsonianService(createInMemoryStorage(), t.reader), [
        { field: 'unit_code', value: 'BIG' },
        { field: 'topic', value: 'T' },
      ]);

      expect(edan).not.toHaveBeenCalled();
      expect(page.rowCount).toBe(SCAN_BUDGET);
      expect(page.rows).toHaveLength(20);
      expect(page.rows.slice(0, 2).map((r) => r.record_id)).toEqual(['big_0', 'big_1']);
      expect(page.provenance).toStrictEqual({
        source: 'oa_mirror',
        snapshot: '2026-10-26T07:25:06.000Z',
      });
    });

    it('sends one past the budget live without logging an error, and serves the repeat from the response cache', async () => {
      const errors = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const edan = stubEdan();
      const svc = new SmithsonianService(createInMemoryStorage(), t.reader);
      const wide: FacetFilter[] = [
        { field: 'unit_code', value: 'BIG' },
        { field: 'place', value: 'P' },
      ];

      const first = await searchWith(svc, wide);
      const second = await searchWith(svc, wide);

      expect(edan).toHaveBeenCalledTimes(1);
      expect(requestUrl(edan.mock.calls[0]![0]).searchParams.get('q')).toBe(
        'unit_code:"BIG" AND place:"P"',
      );
      expect(first.rowCount).toBe(7);
      expect(first.rows.map((r) => r.record_id)).toEqual(['live_1']);
      expect(first.provenance).toStrictEqual({ source: 'edan_api' });
      expect(second).toEqual(first);
      expect(errors).not.toHaveBeenCalled();
    });
  });
});

describe('query plans', () => {
  it('searches an index in every statement but the two bounded walks', async () => {
    const bucket = new FakeBucket();
    vi.stubGlobal('fetch', bucket.fetch);
    const t = openTestMirror();
    try {
      const handle = await t.store.raw();
      const prepare = handle.prepare;
      const statements = new Set<string>();
      handle.prepare = ((sql: string) => {
        statements.add(sql);
        return prepare(sql);
      }) as typeof prepare;

      // Every write path: insert; then unchanged, changed, dropped, moved, and delisted records.
      bucket.put('metadata/edan/aaa/00.txt', [bulkLine('a1'), bulkLine('a2'), bulkLine('a3')]);
      bucket.put('metadata/edan/bbb/00.txt', [bulkLine('b1')]);
      bucket.put('metadata/edan/ccc/00.txt', [bulkLine('c1')]);
      await t.mirror.runSync({ mode: 'init' });
      bucket.put('metadata/edan/aaa/00.txt', [bulkLine('a1'), bulkLine('a2', { title: 'New' })]);
      bucket.put('metadata/edan/bbb/00.txt', [bulkLine('b1'), bulkLine('c1')]);
      bucket.objects.delete('metadata/edan/ccc/00.txt');
      await t.mirror.runSync({ mode: 'refresh' });
      // Every read path, the stale-shard probe and the on_view searches it gates included.
      await t.reader.getDoc('edanmdm:a1');
      await t.reader.hasStaleShards();
      await t.reader.searchFacets([], 0, 2);
      await t.reader.searchFacets([{ field: 'unit_code', value: 'TST' }], 1, 2);
      await t.reader.searchFacets(
        [
          { field: 'unit_code', value: 'TST' },
          { field: 'topic', value: 'Testing' },
        ],
        0,
        2,
      );
      await t.reader.searchFacets([{ field: 'on_view' }], 0, 2);
      await t.reader.searchFacets(
        [{ field: 'unit_code', value: 'TST' }, { field: 'on_view' }],
        0,
        2,
      );
      handle.prepare = prepare;
      expect(await t.reader.getDoc('edanmdm:a3')).toBeUndefined();
      expect((await t.reader.getDoc('edanmdm:a2'))?.title).toBe('New');

      // Framework-owned: sync state, schema version, and the runner's record count.
      const own = [...statements].filter(
        (sql) =>
          !/mirror_sync_state|schema_version/.test(sql) &&
          sql !== 'SELECT COUNT(*) AS n FROM objects',
      );
      expect(own.length).toBeGreaterThan(15);
      const planOf = (sql: string) => {
        const params = Array.from(sql.matchAll(/\?/g), () => null);
        return handle
          .prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...params)
          .map((r) => r.detail);
      };
      const scans = own.flatMap((sql) => {
        const plan = planOf(sql);
        return plan.some((d) => /\bSCAN\b/.test(d)) ? [{ sql, plan }] : [];
      });
      // The probe answers from the shards(etag) index alone, and getDoc's join reaches the
      // shard by its primary key from the one object row.
      const probes = own.filter((sql) => /FROM shards WHERE etag IS NULL/.test(sql));
      expect(probes).toHaveLength(1);
      expect(planOf(probes[0] as string)).toEqual([
        'SEARCH shards USING COVERING INDEX shards_etag (etag=?)',
      ]);
      const joins = own.filter((sql) => /FROM objects o JOIN shards s/.test(sql));
      expect(joins).toHaveLength(1);
      expect(planOf(joins[0] as string)).toEqual([
        'SEARCH o USING INDEX sqlite_autoindex_objects_1 (url=?)',
        'SEARCH s USING INTEGER PRIMARY KEY (rowid=?)',
      ]);
      // The two walks are bounded by design: the shards table (one row per bucket shard,
      // ~13.6k) read once per sync, and the unfiltered page walk, held to SCAN_BUDGET rows.
      expect(scans).toEqual([
        { sql: 'SELECT id, key, etag FROM shards', plan: ['SCAN shards'] },
        {
          sql: 'SELECT rowid AS obj FROM objects ORDER BY rowid LIMIT ? OFFSET ?',
          plan: ['SCAN objects'],
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
      await t.close();
    }
  });
});

describe('getMirrorConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('turns the mirror off when SMITHSONIAN_MIRROR_PATH is unset or empty', () => {
    vi.stubEnv('SMITHSONIAN_MIRROR_PATH', undefined);
    expect(getMirrorConfig().mirrorPath).toBeUndefined();
    vi.stubEnv('SMITHSONIAN_MIRROR_PATH', '');
    expect(getMirrorConfig().mirrorPath).toBeUndefined();
  });

  it('reads the path without requiring the API key', () => {
    vi.stubEnv('SMITHSONIAN_API_KEY', undefined);
    vi.stubEnv('SMITHSONIAN_MIRROR_PATH', '/var/lib/smithsonian-mcp-server/oa.db');
    expect(getMirrorConfig().mirrorPath).toBe('/var/lib/smithsonian-mcp-server/oa.db');
  });

  it('refreshes daily at 12:00 when SMITHSONIAN_MIRROR_REFRESH_CRON is unset', () => {
    vi.stubEnv('SMITHSONIAN_MIRROR_REFRESH_CRON', undefined);
    expect(getMirrorConfig().refreshCron).toBe('0 12 * * *');
  });

  it('turns the in-server refresh off, and leaves the mirror on, when SMITHSONIAN_MIRROR_REFRESH_CRON is empty', () => {
    vi.stubEnv('SMITHSONIAN_MIRROR_PATH', '/var/lib/smithsonian-mcp-server/oa.db');
    vi.stubEnv('SMITHSONIAN_MIRROR_REFRESH_CRON', '');
    expect(getMirrorConfig()).toStrictEqual({
      mirrorPath: '/var/lib/smithsonian-mcp-server/oa.db',
      refreshCron: undefined,
    });
  });

  it('passes a set schedule through, and a schedule without a path leaves the mirror off', () => {
    vi.stubEnv('SMITHSONIAN_MIRROR_PATH', undefined);
    vi.stubEnv('SMITHSONIAN_MIRROR_REFRESH_CRON', '*/30 * * * *');
    const config = getMirrorConfig();
    expect(config.refreshCron).toBe('*/30 * * * *');
    expect(config.mirrorPath).toBeUndefined();
  });
});
