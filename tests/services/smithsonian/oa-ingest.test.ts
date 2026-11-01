/**
 * @fileoverview Tests for the Open Access mirror sync — listing, ETag diff, download and MD5
 * check, per-shard apply, deletion, and checkpoint handling — run against a real SQLite store
 * with the bucket faked at the `fetch` seam.
 * @module tests/services/smithsonian/oa-ingest.test
 */

import { deflateRawSync } from 'node:zlib';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { SqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeDoc, trimRecord } from '@/services/smithsonian/oa-mirror.js';
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
