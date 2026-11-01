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
import { SmithsonianService } from '@/services/smithsonian/smithsonian-service.js';
import type { RawEDAN } from '@/services/smithsonian/types.js';
import { bulkLine, FakeBucket, openTestMirror, type TestMirror } from './oa-bucket-fake.js';

type Line = Record<string, unknown> & RawEDAN;

/** Real `metadata/edan/` lines (2026-10-26 publish), byte for byte, plus one `ead_component`. */
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
    expect(LINES.some((l) => l.type !== 'edanmdm')).toBe(true);
  });

  it.each(RECORDS.map((r) => [r.url, r] as const))(
    'normalizes %s identically from the stored doc',
    (_, line) => {
      expect(readings(stored(line))).toStrictEqual(readings(line));
    },
  );

  it('keeps the indexed unit of an OCIO_DPO3D record whose own unit code differs', () => {
    const line = byUrl('edanmdm:dpo_3d_200122');
    expect(line.content?.descriptiveNonRepeating?.unit_code).toBe('SAO');
    const summary = svc.toSummary(stored(line));
    expect(summary.unit_code).toBe('OCIO_DPO3D');
    expect(summary).toStrictEqual(svc.toSummary(line));
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
      resource: ['height', 'label', 'url', 'width'],
    };
    const keysAt = (docs: RawEDAN[]) => {
      const dnrs = docs.flatMap((d) => d.content?.descriptiveNonRepeating ?? []);
      const media = dnrs.flatMap((d) => d.online_media?.media ?? []);
      return {
        record: new Set(docs.flatMap(Object.keys)),
        descriptive: new Set(dnrs.flatMap(Object.keys)),
        media: new Set(media.flatMap(Object.keys)),
        resource: new Set(media.flatMap((m) => (m.resources ?? []).flatMap(Object.keys))),
      };
    };
    const raw = keysAt(RECORDS);
    const trimmed = keysAt(RECORDS.map(stored));
    for (const level of ['record', 'descriptive', 'media', 'resource'] as const) {
      // The fixture carries fields to drop at every level (hash, guid, maxsize, filename, …).
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
        total: 2,
        urls: ['edanmdm:dpo_3d_200122', 'edanmdm:dpo_3d_200085'],
      });
      expect(await search([{ field: 'online_only' }], 1, 2)).toEqual({
        total: 4,
        urls: ['edanmdm:nmnhvz_14945304', 'edanmdm:hac_FJP.1987.074'],
      });
      expect(await search([{ field: 'online_only' }], 4, 2)).toEqual({ total: 4, urls: [] });
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
        total: 8,
        urls: ['edanmdm:hac_FJP.1987.074', 'edanmdm:nmnheducation_11054667'],
      });
    });

    it('returns docs the normalizers read exactly as the bulk lines', async () => {
      const result = await t.reader.searchFacets([{ field: 'cc0' }], 0, 10);
      if (result.kind !== 'page') throw new Error('expected a page');
      expect(result.docs.map((d) => svc.toSummary(d))).toStrictEqual(
        result.docs.map((d) => svc.toSummary(byUrl(d.url ?? ''))),
      );
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
      // Every read path.
      await t.reader.getDoc('edanmdm:a1');
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
      const scans = own.flatMap((sql) => {
        const params = Array.from(sql.matchAll(/\?/g), () => null);
        const plan = handle
          .prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...params)
          .map((r) => r.detail);
        return plan.some((d) => /\bSCAN\b/.test(d)) ? [{ sql, plan }] : [];
      });
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
