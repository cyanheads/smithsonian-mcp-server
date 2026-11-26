/**
 * @fileoverview Tests for the Open Access mirror sync — listing, ETag diff, download and MD5
 * check, per-shard apply, deletion, and checkpoint handling — run against a real SQLite store
 * with the bucket faked at the `fetch` seam, and the upgrade of a store built under an older
 * schema: a v1 build, and the version-2 store release 0.4.1 wrote (`fixtures/oa-mirror-v2.db`).
 * @module tests/services/smithsonian/oa-ingest.test
 */

import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  defineMirror,
  type MirrorStore,
  type SqliteHandle,
  sqliteMirrorStore,
} from '@cyanheads/mcp-ts-core/mirror';
import { createInMemoryStorage, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOaSync } from '@/services/smithsonian/oa-ingest.js';
import {
  decodeDoc,
  encodeDoc,
  type FacetFilter,
  OaMirror,
  oaMirrorStore,
  trimRecord,
} from '@/services/smithsonian/oa-mirror.js';
import {
  SmithsonianService,
  startCallDeadline,
} from '@/services/smithsonian/smithsonian-service.js';
import type { RawEDAN } from '@/services/smithsonian/types.js';
import { bulkLine, FakeBucket, md5, openTestMirror, type TestMirror } from './oa-bucket-fake.js';

const T1 = '2026-10-19T07:00:00.000Z';
const T2 = '2026-10-26T07:00:00.000Z';
const A = 'metadata/edan/aaa/00.txt';
const B = 'metadata/edan/bbb/00.txt';
const A2_LINE = bulkLine('a2', {
  content: { indexedStructured: { topic: ['Testing', 'Rare'], place: ['Here'] } },
});

let bucket: FakeBucket;
let t: TestMirror;
let handle: SqliteHandle;

beforeEach(async () => {
  bucket = new FakeBucket();
  vi.stubGlobal('fetch', bucket.fetch);
  t = openTestMirror();
  handle = await t.store.raw();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await t.close();
});

const sync = (mode: 'init' | 'refresh' = 'refresh') => t.mirror.runSync({ mode });

function urls(): string[] {
  return handle
    .prepare<{ url: string }>('SELECT url FROM objects ORDER BY rowid')
    .all()
    .map((r) => r.url);
}

function storedDoc(url: string): Uint8Array | undefined {
  return handle.prepare<{ doc: Uint8Array }>('SELECT doc FROM objects WHERE url = ?').get(url)?.doc;
}

/** The facet values a stored record is indexed under, as `field=value`, sorted. */
function facetsOf(url: string): string[] {
  return handle
    .prepare<{ field: string; value: string }>(
      'SELECT t.field, t.value FROM facets f JOIN terms t ON t.id = f.term WHERE f.obj = (SELECT rowid FROM objects WHERE url = ?)',
    )
    .all(url)
    .map((r) => `${r.field}=${r.value}`)
    .sort();
}

function termN(field: string, value: string): number | undefined {
  return handle
    .prepare<{ n: number }>('SELECT n FROM terms WHERE field = ? AND value = ?')
    .get(field, value)?.n;
}

/** Every term's `n` equals its facet row count, and every facet row points at a stored object. */
function expectIndexConsistent(): void {
  const drift = handle
    .prepare<{ field: string; n: number; rows: number; value: string }>(
      'SELECT field, value, n, (SELECT COUNT(*) FROM facets f WHERE f.term = t.id) AS rows FROM terms t',
    )
    .all()
    .filter((r) => r.n !== r.rows);
  expect(drift).toEqual([]);
  const dangling = handle
    .prepare<{ n: number }>(
      'SELECT COUNT(*) AS n FROM facets f WHERE NOT EXISTS (SELECT 1 FROM objects o WHERE o.rowid = f.obj)',
    )
    .get()?.n;
  expect(dangling).toBe(0);
}

/** Record every write to `objects` from here on, on the connection the sync uses. */
function auditWrites(): () => string[] {
  handle.exec('CREATE TEMP TABLE writes (op TEXT NOT NULL, url TEXT NOT NULL)');
  handle.exec(
    "CREATE TEMP TRIGGER audit_insert AFTER INSERT ON objects BEGIN INSERT INTO writes VALUES ('insert', new.url); END",
  );
  handle.exec(
    "CREATE TEMP TRIGGER audit_update AFTER UPDATE ON objects BEGIN INSERT INTO writes VALUES ('update', new.url); END",
  );
  handle.exec(
    "CREATE TEMP TRIGGER audit_delete AFTER DELETE ON objects BEGIN INSERT INTO writes VALUES ('delete', old.url); END",
  );
  return () =>
    handle
      .prepare<{ op: string; url: string }>('SELECT op, url FROM writes ORDER BY rowid')
      .all()
      .map((w) => `${w.op} ${w.url}`);
}

async function expectSyncFailure(reason: string): Promise<McpError> {
  const err = await sync().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(McpError);
  expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  expect((err as McpError).data?.reason).toBe(reason);
  return err as McpError;
}

describe('first sync', () => {
  beforeEach(() => {
    bucket.objects.set('metadata/edan/index.txt', {
      body: 'https://smithsonian-open-access.s3-us-west-2.amazonaws.com/metadata/edan/aaa/00.txt\n',
      lastModified: '2021-04-19T00:00:00.000Z',
    });
    // Newer than every shard: the snapshot must still come from shards alone.
    bucket.objects.set('metadata/edan/aaa/index.txt', {
      body: 'x\n',
      lastModified: '2026-10-31T00:00:00.000Z',
    });
    bucket.put(
      A,
      [
        bulkLine('a1'),
        JSON.stringify({ url: 'ead_component:sova-a-ref1', type: 'ead_component', title: 'Box 1' }),
        bulkLine('a2'),
        JSON.stringify({ url: 'ead_collection:sova-a', type: 'ead_collection', title: 'Papers' }),
      ],
      T1,
    );
    bucket.put('metadata/edan/aaa/01.txt', [], T1);
    bucket.put(B, [bulkLine('b1')], T2);
  });

  it('lists every page, downloads each non-empty shard, and stores only edanmdm records', async () => {
    const result = await sync('init');

    // 5 keys at 3 per page: the second page needs the continuation token, `+/` and all.
    expect(bucket.listings()).toBe(2);
    expect(bucket.downloads()).toEqual([A, B]);
    expect(result.pagesFetched).toBe(4); // three shards, then the checkpoint page
    expect(urls()).toEqual(['edanmdm:a1', 'edanmdm:a2', 'edanmdm:b1']);
    expect(storedDoc('ead_component:sova-a-ref1')).toBeUndefined();
    expect(await t.reader.getDoc('ead_collection:sova-a')).toBeUndefined();
    expect(
      handle
        .prepare<{ key: string; etag: string; last_modified: string }>(
          'SELECT key, etag, last_modified FROM shards ORDER BY key',
        )
        .all(),
    ).toEqual([
      { key: A, etag: md5(bucket.objects.get(A)?.body ?? ''), last_modified: T1 },
      { key: 'metadata/edan/aaa/01.txt', etag: md5(''), last_modified: T1 },
      { key: B, etag: md5(bucket.objects.get(B)?.body ?? ''), last_modified: T2 },
    ]);
    expectIndexConsistent();
  });

  it('sets the snapshot to the newest listed LastModified, ignoring index.txt', async () => {
    expect(await t.reader.ready()).toBe(false);
    expect(await t.reader.snapshot()).toBeUndefined();
    await sync('init');
    expect(await t.reader.ready()).toBe(true);
    expect(await t.reader.snapshot()).toBe(T2);
    expect((await t.mirror.status()).total).toBe(3);
  });

  it('names this repository in the User-Agent of every request', async () => {
    await sync('init');
    expect(bucket.requests.length).toBeGreaterThan(0);
    expect(new Set(bucket.requests.map((r) => r.userAgent))).toEqual(
      new Set(['smithsonian-mcp-server (+https://github.com/cyanheads/smithsonian-mcp-server)']),
    );
  });

  it('refuses a refresh of a store no init has started, before any bucket request', async () => {
    const err = await sync('refresh').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect((err as McpError).data?.reason).toBe('mirror_not_built');
    expect((err as McpError).message).toContain('mirror:init');
    expect(bucket.requests).toEqual([]);
    expect(urls()).toEqual([]);
    expect(await t.reader.ready()).toBe(false);
  });

  it('downloads nothing on the next run when every ETag matches', async () => {
    await sync('init');
    const writes = auditWrites();
    bucket.requests.length = 0;

    await sync('refresh');

    expect(bucket.downloads()).toEqual([]);
    expect(bucket.listings()).toBe(2);
    expect(writes()).toEqual([]);
    expect(await t.reader.snapshot()).toBe(T2);
  });
});

describe('refresh', () => {
  beforeEach(async () => {
    bucket.put(A, [bulkLine('a1'), A2_LINE, bulkLine('a3')], T1);
    bucket.put(B, [bulkLine('b1')], T1);
    await sync('init');
    bucket.requests.length = 0;
  });

  it('stops on an MD5 mismatch without advancing the snapshot, then resumes by ETag', async () => {
    bucket.put(A, [bulkLine('a1'), bulkLine('a2'), bulkLine('a3'), bulkLine('a4')], T2);
    bucket.put(B, [bulkLine('b1', { title: 'Renamed' })], T2);
    const b = bucket.objects.get(B);
    if (b) b.etag = md5('not the body');
    const before = storedDoc('edanmdm:b1');

    const err = await expectSyncFailure('checksum_mismatch');
    expect(err.message).toContain(B);

    expect(await t.reader.snapshot()).toBe(T1);
    expect(await t.reader.ready()).toBe(true);
    expect((await t.mirror.status()).status).toBe('error');
    // A preceded B in the listing and was applied; B was not.
    expect(urls()).toContain('edanmdm:a4');
    expect(storedDoc('edanmdm:b1')).toEqual(before);

    if (b) delete b.etag;
    bucket.requests.length = 0;
    await sync();
    expect(bucket.downloads()).toEqual([B]);
    expect(await t.reader.snapshot()).toBe(T2);
    expect((await t.reader.getDoc('edanmdm:b1'))?.title).toBe('Renamed');
    expectIndexConsistent();
  });

  it('stops on a non-200 shard response without advancing the snapshot', async () => {
    bucket.put(B, [bulkLine('b1', { title: 'Renamed' })], T2);
    const b = bucket.objects.get(B);
    if (b) b.status = 503;

    const err = await expectSyncFailure('upstream_status');
    expect(err.data?.status).toBe(503);
    expect(await t.reader.snapshot()).toBe(T1);
    expect((await t.reader.getDoc('edanmdm:b1'))?.title).toBe('Object b1');
  });

  it('deletes records dropped from a re-read shard and decrements their terms', async () => {
    expect(termN('topic', 'Rare')).toBe(1);
    expect(termN('topic', 'Testing')).toBe(4);
    const writes = auditWrites();

    bucket.put(A, [bulkLine('a1'), bulkLine('a3')], T2);
    await sync();

    expect(urls()).toEqual(['edanmdm:a1', 'edanmdm:a3', 'edanmdm:b1']);
    expect(await t.reader.getDoc('edanmdm:a2')).toBeUndefined();
    expect(termN('topic', 'Rare')).toBe(0);
    expect(termN('place', 'Here')).toBe(0);
    expect(termN('topic', 'Testing')).toBe(3);
    expect(writes()).toEqual(['delete edanmdm:a2']);
    expectIndexConsistent();
  });

  it('rewrites a changed record and its facets, leaving byte-identical records unwritten', async () => {
    const writes = auditWrites();
    bucket.put(
      A,
      [
        // Fields outside the stored subset changed: the stored doc is the same.
        bulkLine('a1', { hash: md5('new'), lastTimeUpdated: 1_762_000_000, docSignature: 'x' }),
        bulkLine('a2', {
          title: 'Retitled',
          content: { indexedStructured: { topic: ['Testing', 'Fresh'], place: ['Here'] } },
        }),
        bulkLine('a3'),
      ],
      T2,
    );

    await sync();

    expect(writes()).toEqual(['update edanmdm:a2']);
    expect(facetsOf('edanmdm:a2')).toEqual([
      'place=Here',
      'topic=Fresh',
      'topic=Testing',
      'unit_code=TST',
    ]);
    expect(termN('topic', 'Rare')).toBe(0);
    expect(termN('topic', 'Fresh')).toBe(1);
    expect((await t.reader.getDoc('edanmdm:a2'))?.title).toBe('Retitled');
    expect(await t.reader.snapshot()).toBe(T2);
    expectIndexConsistent();
  });

  it('treats a doc another runtime deflated to different bytes as unchanged', async () => {
    // Bun and Node deflate the same JSON to different bytes; simulate the other runtime's copy.
    const json = JSON.stringify(trimRecord(JSON.parse(bulkLine('a1'))));
    const foreign = deflateRawSync(json, { level: 1, memLevel: 1 });
    expect(Buffer.compare(foreign, encodeDoc(JSON.parse(json)))).not.toBe(0);
    // The handle's parameter type omits BLOBs; both drivers bind a Buffer as one.
    handle
      .prepare('UPDATE objects SET doc = ? WHERE url = ?')
      .run(foreign as unknown as string, 'edanmdm:a1');
    const writes = auditWrites();

    bucket.put(A, [bulkLine('a1'), bulkLine('a2', { title: 'Retitled' }), bulkLine('a3')], T2);
    await sync();

    expect(writes()).toEqual(['update edanmdm:a2']);
    expect(Buffer.compare(storedDoc('edanmdm:a1') ?? new Uint8Array(), foreign)).toBe(0);
  });

  it('deletes the records of a delisted shard, but not one that moved to a listed shard', async () => {
    const shardIds = () =>
      handle.prepare<{ id: number; key: string }>('SELECT id, key FROM shards ORDER BY key').all();
    const bId = shardIds().find((s) => s.key === B)?.id;
    const movedDoc = storedDoc('edanmdm:a2');

    bucket.objects.delete(A);
    bucket.put(B, [bulkLine('b1'), A2_LINE], T2);
    await sync();

    expect(urls()).toEqual(['edanmdm:a2', 'edanmdm:b1']);
    expect(shardIds().map((s) => s.key)).toEqual([B]);
    expect(
      handle.prepare<{ shard: number }>('SELECT shard FROM objects WHERE url = ?').get('edanmdm:a2')
        ?.shard,
    ).toBe(bId);
    expect(storedDoc('edanmdm:a2')).toEqual(movedDoc);
    expect(termN('topic', 'Rare')).toBe(1);
    expect(termN('topic', 'Testing')).toBe(2);
    expectIndexConsistent();
  });

  it('refuses an empty listing rather than delisting every record', async () => {
    bucket.objects.clear();
    bucket.objects.set('metadata/edan/index.txt', { body: 'x\n', lastModified: T2 });

    await expectSyncFailure('empty_listing');
    expect(urls()).toEqual(['edanmdm:a1', 'edanmdm:a2', 'edanmdm:a3', 'edanmdm:b1']);
    expect(await t.reader.snapshot()).toBe(T1);
  });

  it.each([
    ['a line that is not JSON', '{"type":"edanmdm",', 2],
    ['a line that is not an object', '[1, 2]', 2],
    ['an edanmdm line without a url', JSON.stringify({ type: 'edanmdm', title: 'No url' }), 2],
  ])('fails a shard holding %s, keeping its stored records', async (_, bad, lineNumber) => {
    bucket.put(A, [bulkLine('a1'), bad, bulkLine('a3')], T2);

    const err = await expectSyncFailure('invalid_shard_line');
    expect(err.data).toMatchObject({ key: A, line: lineNumber });
    expect(urls()).toEqual(['edanmdm:a1', 'edanmdm:a2', 'edanmdm:a3', 'edanmdm:b1']);
    expect(await t.reader.snapshot()).toBe(T1);
  });

  it('rejects a listing whose ETag is not a single-part MD5', async () => {
    bucket.put(A, [bulkLine('a1')], T2);
    const a = bucket.objects.get(A);
    if (a) a.etag = `${md5('x')}-2`;

    const err = await expectSyncFailure('invalid_listing');
    expect(err.message).toContain(A);
    expect(bucket.downloads()).toEqual([]);
  });

  it('rejects a listing whose LastModified is not a timestamp, keeping the snapshot', async () => {
    bucket.put(A, [bulkLine('a1')], 'not-a-date');

    const err = await expectSyncFailure('invalid_listing');
    expect(err.message).toContain(A);
    expect(bucket.downloads()).toEqual([]);
    expect(await t.reader.snapshot()).toBe(T1);
  });

  it('records the snapshot as an ISO 8601 UTC timestamp whatever offset the listing uses', async () => {
    bucket.put(A, [bulkLine('a1')], '2026-11-02T01:00:00+02:00');

    await sync('refresh');

    expect(await t.reader.snapshot()).toBe('2026-11-01T23:00:00.000Z');
  });

  it('stops when the caller aborts mid-run, and the next run resumes after the last shard', async () => {
    bucket.put(A, [bulkLine('a1'), bulkLine('a2'), bulkLine('a3'), bulkLine('a4')], T2);
    bucket.put(B, [bulkLine('b1'), bulkLine('b2')], T2);
    const controller = new AbortController();

    await expect(
      t.mirror.runSync({
        mode: 'refresh',
        signal: controller.signal,
        onProgress: () => controller.abort(new Error('stop')),
      }),
    ).rejects.toThrow();

    expect(bucket.downloads()).toEqual([A]);
    expect(urls()).toContain('edanmdm:a4');
    expect(urls()).not.toContain('edanmdm:b2');
    expect(await t.reader.snapshot()).toBe(T1);

    bucket.requests.length = 0;
    await sync();
    expect(bucket.downloads()).toEqual([B]);
    expect(urls()).toContain('edanmdm:b2');
    expect(await t.reader.snapshot()).toBe(T2);
  });
});

// ---------------------------------------------------------------------------
// Upgrading a store built under an older schema: v1 (issue #74), v2 (issues #81, #82, #83)
// ---------------------------------------------------------------------------

/** The auxiliary tables of the v1 store, as v1 created them. */
const V1_AUXILIARY_TABLES = [
  'CREATE TABLE IF NOT EXISTS terms (id INTEGER PRIMARY KEY, field TEXT NOT NULL, value TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, UNIQUE (field, value))',
  'CREATE TABLE IF NOT EXISTS facets (term INTEGER NOT NULL, obj INTEGER NOT NULL, PRIMARY KEY (term, obj)) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS shards (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, etag TEXT, last_modified TEXT)',
];

/**
 * The store spec v1 shipped: the same declared table, at version 1 with its one migration. A
 * store at a later version opens through it unmigrated, as written.
 */
function v1Store(path: string): MirrorStore {
  return sqliteMirrorStore({
    path,
    table: 'objects',
    primaryKey: 'url',
    columns: { url: 'TEXT', doc: 'BLOB NOT NULL', shard: 'INTEGER NOT NULL' },
    indexes: [{ columns: ['shard'] }],
    version: 1,
    migrations: [
      {
        version: 1,
        up(h: SqliteHandle) {
          for (const sql of V1_AUXILIARY_TABLES) h.exec(sql);
        },
      },
    ],
  });
}

/** Real `metadata/edan/` lines; nasm_A19820121000 is flagged on view at HAZY. */
const FIXTURE_LINES = readFileSync(
  new URL('./fixtures/oa-bulk-lines.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter(Boolean);
const FIXTURE_RECORDS = FIXTURE_LINES.map((l) => JSON.parse(l) as RawEDAN).filter(
  (r) => r.type === 'edanmdm',
);

/**
 * The fixture records whose stored doc schema version 3 rewrites, in ingest order: each carries
 * `freetext.setName`, `freetext.objectRight`, or 3D files, whose `category`, `filename`, and
 * `attributes` earlier versions dropped.
 */
const V3_REWRITTEN = [
  'edanmdm:nasm_A19820121000',
  'edanmdm:dpo_3d_200122',
  'edanmdm:nmnhvz_14945304',
  'edanmdm:nmnhvz_5105499',
  'edanmdm:hac_FJP.1987.074',
  'edanmdm:nmnheducation_11054667',
  'edanmdm:siris_arc_396415',
  'edanmdm:dpo_3d_200016',
];

/** A copy of a bulk line or stored doc without the keys schema version 3 added to the stored subset. */
function withoutV3Keys<T>(doc: T): T {
  const copy = structuredClone(doc) as {
    content?: {
      descriptiveNonRepeating?: {
        online_media?: { media?: Array<{ resources?: Array<Record<string, unknown>> }> };
      };
      freetext?: Record<string, unknown>;
    };
  };
  const freetext = copy.content?.freetext;
  if (copy.content && freetext) {
    delete freetext.setName;
    delete freetext.objectRight;
    if (Object.keys(freetext).length === 0) delete copy.content.freetext;
  }
  for (const item of copy.content?.descriptiveNonRepeating?.online_media?.media ?? []) {
    for (const resource of item.resources ?? []) {
      delete resource.category;
      delete resource.filename;
      delete resource.attributes;
    }
  }
  return copy as T;
}

/** The stored doc of `url`, which must be stored. */
function docOf(url: string): RawEDAN {
  const blob = storedDoc(url);
  if (!blob) throw new Error(`${url} is not stored`);
  return decodeDoc(blob);
}

describe('opening a store built under an older schema', () => {
  const ON_VIEW = 'nasm_A19820121000';
  const ON_VIEW_FILTER: FacetFilter[] = [{ field: 'on_view' }];
  const NASM_FILTER: FacetFilter[] = [{ field: 'unit_code', value: 'NASM' }];

  let dir: string;
  let path: string;
  let upgraded: MirrorStore | undefined;
  /** The live API's requests, by path and `q`. */
  let live: string[];

  // The bucket for the shards, and the live API at its default base URL for everything else.
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oa-upgrade-test-'));
    path = join(dir, 'oa.db');
    live = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.hostname !== 'api.si.edu') return bucket.fetch(input, init);
        if (url.pathname.endsWith('/search')) {
          live.push(`search ${url.searchParams.get('q')}`);
          return Response.json({
            status: 200,
            response: { rows: FIXTURE_RECORDS.slice(0, 1), rowCount: 7 },
          });
        }
        live.push('content');
        const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
        const record = FIXTURE_RECORDS.find((r) => r.url === id);
        if (!record) throw new Error(`unmocked fetch: ${url.href}`);
        return Response.json({ status: 200, response: record });
      }),
    );
    vi.stubEnv('SMITHSONIAN_API_KEY', 'test-key-12345');
  });

  afterEach(async () => {
    await upgraded?.close();
    upgraded = undefined;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Open the store under the current schema, the connection the helpers above read through. */
  async function openUpgraded(): Promise<OaMirror> {
    upgraded = oaMirrorStore(path);
    handle = await upgraded.raw();
    return new OaMirror(upgraded);
  }

  /** Run a refresh of the store {@link openUpgraded} opened. */
  function refresh() {
    const store = upgraded as MirrorStore;
    return defineMirror({
      name: 'oa-upgraded',
      store,
      logger: {},
      sync: createOaSync(store),
    }).runSync({ mode: 'refresh' });
  }

  function dump(h: SqliteHandle) {
    return {
      objects: h
        .prepare('SELECT rowid, url, hex(doc) AS doc, shard FROM objects ORDER BY rowid')
        .all(),
      terms: h.prepare('SELECT id, field, value, n FROM terms ORDER BY id').all(),
      facets: h.prepare('SELECT term, obj FROM facets ORDER BY term, obj').all(),
    };
  }

  const search = (svc: SmithsonianService, filters: FacetFilter[]) =>
    svc.search(
      { query: '', rows: 10, start: 0, filters },
      createMockContext(),
      startCallDeadline(),
    );

  describe('a v1 store (issue #74)', () => {
    const SHARDS = new Map([
      [A, FIXTURE_LINES.slice(0, 5)],
      [B, FIXTURE_LINES.slice(5)],
    ]);

    /**
     * A bulk line as the v1 store saw it: without the keys only versions 2 (`onPhysicalExhibit`,
     * `exhibition`) and 3 ({@link withoutV3Keys}) store.
     */
    function v1Line(line: string): string {
      const parsed = JSON.parse(line) as {
        content?: { indexedStructured?: Record<string, unknown> };
      };
      delete parsed.content?.indexedStructured?.onPhysicalExhibit;
      delete parsed.content?.indexedStructured?.exhibition;
      return JSON.stringify(withoutV3Keys(parsed));
    }

    /**
     * Build a store with the v1 schema. v1 stored none of those keys, so its docs and facets are
     * those of the stripped lines (byte-identical to a v1 build of the full lines); its shards
     * carry the ETags of the bodies it read, which the bucket still serves unchanged.
     */
    beforeEach(async () => {
      for (const [key, lines] of SHARDS) bucket.put(key, lines.map(v1Line));
      const v1 = v1Store(path);
      await defineMirror({ name: 'oa-v1', store: v1, logger: {}, sync: createOaSync(v1) }).runSync({
        mode: 'init',
      });
      const v1Handle = await v1.raw();
      for (const [key, lines] of SHARDS) {
        bucket.put(key, lines);
        v1Handle
          .prepare('UPDATE shards SET etag = ? WHERE key = ?')
          .run(md5(bucket.objects.get(key)?.body ?? ''), key);
      }
      await v1.close();
      bucket.requests.length = 0;
    });

    /** The facet rows and terms of the two presence flags v1 already indexed. */
    function presenceRows(h: SqliteHandle) {
      return h
        .prepare(
          "SELECT t.id, t.field, t.value, t.n, f.obj FROM terms t JOIN facets f ON f.term = t.id WHERE t.field IN ('cc0', 'online_only') ORDER BY t.id, f.obj",
        )
        .all();
    }

    it('is a store the bucket has not changed under: a v1 refresh downloads nothing', async () => {
      const v1 = v1Store(path);
      try {
        await defineMirror({
          name: 'oa-v1',
          store: v1,
          logger: {},
          sync: createOaSync(v1),
        }).runSync({ mode: 'refresh' });
        expect(bucket.downloads()).toEqual([]);
      } finally {
        await v1.close();
      }
    });

    it('stamps version 3 on open, clears every shard ETag, indexes shards(etag), and leaves every record and facet in place', async () => {
      const v1 = v1Store(path);
      const before = dump(await v1.raw());
      const shardsBefore = (await v1.raw())
        .prepare<{ key: string; last_modified: string }>(
          'SELECT key, last_modified FROM shards ORDER BY id',
        )
        .all();
      await v1.close();

      const reader = await openUpgraded();

      expect(
        handle.prepare<{ v: number }>('SELECT MAX(version) AS v FROM schema_version').get()?.v,
      ).toBe(3);
      expect(
        handle
          .prepare<{ key: string; etag: string | null; last_modified: string }>(
            'SELECT key, etag, last_modified FROM shards ORDER BY id',
          )
          .all(),
      ).toEqual(shardsBefore.map((s) => ({ ...s, etag: null })));
      expect(
        handle
          .prepare<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'shards' AND sql LIKE '%(etag)%'",
          )
          .all(),
      ).toHaveLength(1);
      expect(dump(handle)).toEqual(before);
      expect(await reader.ready()).toBe(true);
      expect(bucket.requests).toEqual([]);
    });

    it('until a refresh, sends object reads and on_view searches live and keeps other filter-only searches on the mirror', async () => {
      const reader = await openUpgraded();
      const svc = new SmithsonianService(createInMemoryStorage(), reader);

      const read = await svc.getContent(ON_VIEW, createMockContext(), startCallDeadline());
      const onView = await search(svc, ON_VIEW_FILTER);
      const nasm = await search(svc, NASM_FILTER);

      expect(live).toEqual(['content', 'search onPhysicalExhibit:"Yes"']);
      expect(read.provenance).toStrictEqual({ source: 'edan_api' });
      expect(svc.toFullObject(read.record)).toMatchObject({
        on_view: true,
        current_exhibitions: [{ building: 'HAZY' }],
      });
      expect(onView.provenance).toStrictEqual({ source: 'edan_api' });
      expect(onView.rowCount).toBe(7);
      expect(nasm.provenance).toMatchObject({ source: 'oa_mirror' });
      expect(nasm.rows.map((r) => r.record_id)).toEqual([ON_VIEW]);
      expect(await reader.ready()).toBe(true);
    });

    it('refreshes every shard, rewriting only the records whose docs changed and leaving the presence rows alone; then serves all three from the mirror', async () => {
      const reader = await openUpgraded();
      const presence = presenceRows(handle);
      expect(presence.length).toBeGreaterThan(0);
      expect(termN('on_view', 'true')).toBeUndefined();
      const writes = auditWrites();

      await refresh();

      expect(bucket.downloads()).toEqual([A, B]);
      // nasm_A19820121000 gains its on-view keys; it and the others gain version 3's keys.
      expect(writes()).toEqual(V3_REWRITTEN.map((url) => `update ${url}`));
      expect(presenceRows(handle)).toEqual(presence);
      expect(facetsOf(`edanmdm:${ON_VIEW}`)).toContain('on_view=true');
      expect(termN('on_view', 'true')).toBe(1);
      expect(
        handle.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM shards WHERE etag IS NULL').get()
          ?.n,
      ).toBe(0);
      expectIndexConsistent();

      const svc = new SmithsonianService(createInMemoryStorage(), reader);
      const read = await svc.getContent(ON_VIEW, createMockContext(), startCallDeadline());
      const onView = await search(svc, ON_VIEW_FILTER);
      const nasm = await search(svc, NASM_FILTER);

      expect(live).toEqual([]);
      expect(read.provenance).toMatchObject({ source: 'oa_mirror' });
      expect(svc.toFullObject(read.record)).toMatchObject({
        on_view: true,
        current_exhibitions: [{ building: 'HAZY' }],
      });
      expect(onView.provenance).toMatchObject({ source: 'oa_mirror' });
      expect(onView.rows.map((r) => r.record_id)).toEqual([ON_VIEW]);
      expect(onView.rowCount).toBe(termN('on_view', 'true'));
      expect(nasm.provenance).toMatchObject({ source: 'oa_mirror' });
    });
  });

  describe('a version-2 store written by release 0.4.1 (issues #81, #82, #83)', () => {
    /**
     * `fixtures/oa-mirror-v2.db` is the SQLite file release 0.4.1's own sync code wrote on
     * `mirror:init` over the first eleven fixture lines, served as shard aaa (lines 0–4) and shard
     * bbb (lines 5–10) at the fake bucket's default LastModified. The bucket here serves those
     * same bodies, so only the schema change makes a refresh re-read them.
     */
    const V2_SHARDS = new Map([
      [A, FIXTURE_LINES.slice(0, 5)],
      [B, FIXTURE_LINES.slice(5, 11)],
    ]);
    /** The records whose version-2 doc is already their version-3 doc. */
    const UNCHANGED = ['edanmdm:dpo_3d_200085', 'edanmdm:slasro_79883'];
    const SIA_RIGHTS = [
      { label: 'Restrictions & Rights', content: 'No access restrictions' },
      { label: 'Restrictions & Rights', content: 'No Copyright – United States' },
    ];

    beforeEach(() => {
      copyFileSync(new URL('./fixtures/oa-mirror-v2.db', import.meta.url), path);
      for (const [key, lines] of V2_SHARDS) bucket.put(key, lines);
    });

    /** The fixture store as 0.4.1 wrote it, read through a spec that runs no migration on it. */
    async function asWritten() {
      const store = v1Store(path);
      try {
        const h = await store.raw();
        return {
          version: h.prepare<{ v: number }>('SELECT MAX(version) AS v FROM schema_version').get()
            ?.v,
          shards: h
            .prepare<{ etag: string | null; key: string; last_modified: string }>(
              'SELECT key, etag, last_modified FROM shards ORDER BY id',
            )
            .all(),
          docs: new Map(
            h
              .prepare<{ doc: Uint8Array; url: string }>(
                'SELECT url, doc FROM objects ORDER BY rowid',
              )
              .all()
              .map((r) => [r.url, Buffer.from(r.doc)]),
          ),
          rows: dump(h),
        };
      } finally {
        await store.close();
      }
    }

    it('is a version-2 store of the ten fixture records, each shard at the ETag of the body served, no doc holding a version-3 key', async () => {
      const written = await asWritten();

      expect(written.version).toBe(2);
      expect(written.shards.map(({ key, etag }) => ({ key, etag }))).toEqual(
        [...V2_SHARDS.keys()].map((key) => ({
          key,
          etag: md5(bucket.objects.get(key)?.body ?? ''),
        })),
      );
      expect([...written.docs.keys()]).toEqual([
        'edanmdm:nasm_A19820121000',
        'edanmdm:dpo_3d_200122',
        'edanmdm:dpo_3d_200085',
        'edanmdm:nmnhvz_14945304',
        'edanmdm:nmnhvz_5105499',
        'edanmdm:slasro_79883',
        'edanmdm:hac_FJP.1987.074',
        'edanmdm:nmnheducation_11054667',
        'edanmdm:siris_arc_396415',
        'edanmdm:dpo_3d_200016',
      ]);
      // Each still reads, normalizing as its bulk line does without the keys version 3 adds.
      const svc = new SmithsonianService(createInMemoryStorage());
      for (const [url, blob] of written.docs) {
        const doc = decodeDoc(blob);
        const line = FIXTURE_RECORDS.find((r) => r.url === url) as RawEDAN;
        expect(withoutV3Keys(doc)).toStrictEqual(doc);
        expect(svc.toFullObject(doc)).toStrictEqual(svc.toFullObject(withoutV3Keys(line)));
      }
    });

    it('stamps version 3 on open, clears every shard ETag, and leaves every record, term, and facet row in place', async () => {
      const written = await asWritten();

      const reader = await openUpgraded();

      expect(
        handle.prepare<{ v: number }>('SELECT MAX(version) AS v FROM schema_version').get()?.v,
      ).toBe(3);
      expect(
        handle
          .prepare<{ etag: string | null; key: string; last_modified: string }>(
            'SELECT key, etag, last_modified FROM shards ORDER BY id',
          )
          .all(),
      ).toEqual(written.shards.map((s) => ({ ...s, etag: null })));
      expect(dump(handle)).toEqual(written.rows);
      expect(await reader.ready()).toBe(true);
      expect(await reader.hasStaleShards()).toBe(true);
      expect(bucket.requests).toEqual([]);
    });

    it('until a refresh, sends object reads and on_view searches live and keeps unit_code-only searches on the mirror', async () => {
      const reader = await openUpgraded();
      const svc = new SmithsonianService(createInMemoryStorage(), reader);

      const read = await svc.getContent(
        'siris_arc_396415',
        createMockContext(),
        startCallDeadline(),
      );
      const onView = await search(svc, ON_VIEW_FILTER);
      const sia = await search(svc, [{ field: 'unit_code', value: 'SIA' }]);

      expect(live).toEqual(['content', 'search onPhysicalExhibit:"Yes"']);
      expect(read.provenance).toStrictEqual({ source: 'edan_api' });
      expect(read.record.content?.freetext?.objectRight).toStrictEqual(SIA_RIGHTS);
      expect(onView.provenance).toStrictEqual({ source: 'edan_api' });
      expect(sia.provenance).toMatchObject({ source: 'oa_mirror' });
      expect(sia.rows.map((r) => r.record_id)).toEqual(['siris_arc_396415']);
    });

    it('refreshes every shard, rewriting each doc that gains a version-3 key and no other, and leaving every term and facet row alone', async () => {
      const written = await asWritten();
      await openUpgraded();
      const writes = auditWrites();

      await refresh();

      expect(bucket.downloads()).toEqual([A, B]);
      expect(writes()).toEqual(V3_REWRITTEN.map((url) => `update ${url}`));
      const { terms, facets } = dump(handle);
      expect({ terms, facets }).toEqual({ terms: written.rows.terms, facets: written.rows.facets });
      expect(
        handle.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM shards WHERE etag IS NULL').get()
          ?.n,
      ).toBe(0);
      expectIndexConsistent();

      // Each doc differs from the one 0.4.1 stored by version 3's keys alone, key order included.
      for (const [url, blob] of written.docs) {
        expect(JSON.stringify(withoutV3Keys(docOf(url)))).toBe(JSON.stringify(decodeDoc(blob)));
      }
      for (const url of UNCHANGED) {
        expect(Buffer.from(storedDoc(url) ?? []).toString('hex')).toBe(
          written.docs.get(url)?.toString('hex'),
        );
      }
      expect(docOf('edanmdm:siris_arc_396415').content?.freetext?.objectRight).toStrictEqual(
        SIA_RIGHTS,
      );
      expect(docOf('edanmdm:nasm_A19820121000').content?.freetext?.setName).toStrictEqual([
        { label: 'See more items in', content: 'National Air and Space Museum Collection' },
        { label: 'Location', content: 'Steven F. Udvar-Hazy Center in Chantilly, VA' },
        { label: 'Exhibit Station', content: 'Rockets & Missiles' },
      ]);
      const model =
        docOf('edanmdm:dpo_3d_200016').content?.descriptiveNonRepeating?.online_media?.media?.[0];
      expect(model?.resources?.[3]).toStrictEqual({
        url: 'https://3d-api.si.edu/content/document/3d_package:64ff5dbe-cf46-486e-8b3a-cb8e1fd7895c/resources/mpc_684-100k-web.glb',
        category: 'Low resolution',
        filename: 'mpc_684-100k-web.glb',
        attributes: [
          { UNITS: 'mm' },
          { MODEL_FILE_TYPE: 'glb' },
          { FILE_TYPE: 'glb' },
          { FILE_SIZE: 24283376 },
        ],
      });
    });

    it('then serves every record and on_view search from the mirror, each record normalizing as its bulk line does', async () => {
      const reader = await openUpgraded();
      await refresh();
      const svc = new SmithsonianService(createInMemoryStorage(), reader);

      for (const line of FIXTURE_RECORDS.slice(0, 10)) {
        const read = await svc.getContent(line.url ?? '', createMockContext(), startCallDeadline());
        expect(read.provenance).toMatchObject({ source: 'oa_mirror' });
        expect(svc.toFullObject(read.record)).toStrictEqual(svc.toFullObject(line));
      }
      const onView = await search(svc, ON_VIEW_FILTER);

      expect(live).toEqual([]);
      expect(onView.provenance).toMatchObject({ source: 'oa_mirror' });
      expect(onView.rows.map((r) => r.record_id)).toEqual([ON_VIEW]);
    });
  });
});
