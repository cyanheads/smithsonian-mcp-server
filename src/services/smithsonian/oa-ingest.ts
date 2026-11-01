/**
 * @fileoverview Sync for the Open Access bulk mirror. Lists `metadata/edan/` in the public
 * `smithsonian-open-access` S3 bucket with ListObjectsV2 (never the stale `index.txt` files),
 * downloads each shard whose ETag differs from the one stored, checks its MD5 against that
 * ETag, and applies the shard's `edanmdm` records in one transaction. Shards no longer listed
 * are removed. `init` and `refresh` run this same pass, except that only `init` starts a build.
 * @module services/smithsonian/oa-ingest
 */

import { createHash } from 'node:crypto';
import { configurationError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type {
  MirrorLogger,
  MirrorStore,
  SqliteHandle,
  SqlValue,
  SyncGenerator,
} from '@cyanheads/mcp-ts-core/mirror';
import { isRecord } from '@cyanheads/mcp-ts-core/utils';
import {
  decodeDoc,
  encodeDoc,
  type FacetTerm,
  facetTerms,
  sameDoc,
  trimRecord,
} from './oa-mirror.js';

/** The bucket, addressed path-style as its own published URL lists are. */
export const OA_BUCKET_URL = 'https://smithsonian-open-access.s3-us-west-2.amazonaws.com';

const SHARD_PREFIX = 'metadata/edan/';

/** `metadata/edan/<unit>/<00–ff>.txt`; the prefix also holds `index.txt` URL lists. */
const SHARD_KEY = /^metadata\/edan\/[^/]+\/[0-9a-f]{2}\.txt$/;

const USER_AGENT = 'smithsonian-mcp-server (+https://github.com/cyanheads/smithsonian-mcp-server)';

/** A listing page is ~310 KB. */
const LIST_TIMEOUT_MS = 60_000;

/** The largest shard is ~58 MB; this allows it about 100 KB/s. */
const SHARD_TIMEOUT_MS = 600_000;

/** One shard in the bucket listing. */
interface ListedShard {
  /** Single-part ETag: the hex MD5 of the object. */
  etag: string;
  key: string;
  /** ISO 8601. */
  lastModified: string;
  sizeBytes: number;
}

/** A bulk record ready to apply: its stored doc and the facet terms it is indexed under. */
interface PreparedRecord {
  doc: Buffer;
  terms: Map<string, FacetTerm>;
  url: string;
}

/** What applying one shard did. */
interface ShardStats {
  added: number;
  changed: number;
  records: number;
  removed: number;
  unchanged: number;
}

// ---------------------------------------------------------------------------
// Bucket access
// ---------------------------------------------------------------------------

async function get(url: URL, timeoutMs: number, signal: AbortSignal): Promise<Response> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw serviceUnavailable(`GET ${url.href} returned HTTP ${response.status}.`, {
      reason: 'upstream_status',
      status: response.status,
    });
  }
  return response;
}

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
};

function decodeXml(text: string): string {
  return text.replace(/&(amp|apos|gt|lt|quot);/g, (_, name: string) => XML_ENTITIES[name] ?? '');
}

/** The text of the first `<name>` element in `xml`, entity-decoded. */
function element(xml: string, name: string): string | undefined {
  const open = `<${name}>`;
  const at = xml.indexOf(open);
  if (at === -1) return undefined;
  const end = xml.indexOf(`</${name}>`, at);
  return end === -1 ? undefined : decodeXml(xml.slice(at + open.length, end));
}

function invalidListing(message: string): Error {
  return serviceUnavailable(message, { reason: 'invalid_listing' });
}

/** Parse one ListObjectsV2 page: its shard entries and the token for the next page, if any. */
function parseListPage(xml: string): { next: string | undefined; shards: ListedShard[] } {
  const shards: ListedShard[] = [];
  for (const block of xml.split('<Contents>').slice(1)) {
    const key = element(block, 'Key');
    if (key === undefined) throw invalidListing('A bucket listing entry has no Key.');
    if (!SHARD_KEY.test(key)) continue;
    const etag = element(block, 'ETag')?.replaceAll('"', '');
    const lastModified = element(block, 'LastModified');
    const sizeBytes = Number(element(block, 'Size'));
    if (!etag || !lastModified || !Number.isSafeInteger(sizeBytes)) {
      throw invalidListing(
        `The bucket listing entry for ${key} lacks an ETag, LastModified, or Size.`,
      );
    }
    if (!/^[0-9a-f]{32}$/.test(etag)) {
      throw invalidListing(
        `Shard ${key} has ETag ${etag}, which is not a single-part MD5, so its download cannot be verified.`,
      );
    }
    // Normalized to ISO 8601 UTC, the form the checkpoint compares as strings.
    const modifiedMs = Date.parse(lastModified);
    if (Number.isNaN(modifiedMs)) {
      throw invalidListing(
        `Shard ${key} has LastModified ${lastModified}, which is not a timestamp.`,
      );
    }
    shards.push({ key, etag, lastModified: new Date(modifiedMs).toISOString(), sizeBytes });
  }
  if (element(xml, 'IsTruncated') !== 'true') return { next: undefined, shards };
  const next = element(xml, 'NextContinuationToken');
  if (!next) throw invalidListing('A truncated bucket listing page has no NextContinuationToken.');
  return { next, shards };
}

/** Every shard under `metadata/edan/`, in listing (key) order. */
async function listShards(signal: AbortSignal): Promise<ListedShard[]> {
  const shards: ListedShard[] = [];
  let token: string | undefined;
  do {
    const url = new URL(OA_BUCKET_URL);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', SHARD_PREFIX);
    if (token) url.searchParams.set('continuation-token', token);
    const page = parseListPage(await (await get(url, LIST_TIMEOUT_MS, signal)).text());
    shards.push(...page.shards);
    token = page.next;
  } while (token);
  return shards;
}

/** Download a shard and check it against its ETag. A zero-byte shard needs no request. */
async function downloadShard(shard: ListedShard, signal: AbortSignal): Promise<Uint8Array> {
  const body =
    shard.sizeBytes === 0
      ? new Uint8Array(0)
      : new Uint8Array(
          await (
            await get(new URL(shard.key, `${OA_BUCKET_URL}/`), SHARD_TIMEOUT_MS, signal)
          ).arrayBuffer(),
        );
  const md5 = createHash('md5').update(body).digest('hex');
  if (md5 !== shard.etag) {
    throw serviceUnavailable(
      `Shard ${shard.key} failed verification: its MD5 ${md5} does not match its listed ETag ${shard.etag}.`,
      { reason: 'checksum_mismatch', key: shard.key },
    );
  }
  return body;
}

function invalidLine(key: string, line: number, problem: string, cause?: unknown): Error {
  return serviceUnavailable(
    `Shard ${key} line ${line} ${problem}.`,
    { reason: 'invalid_shard_line', key, line },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Parse a shard's JSON Lines into prepared `edanmdm` records; `ead_*` lines are skipped, since
 * EDAN search excludes them and no tool addresses them. A line that does not parse to an
 * object, or an `edanmdm` line without a `url`, fails the shard: applying the rest would delete
 * that record as absent.
 */
function prepareRecords(body: Uint8Array, key: string): PreparedRecord[] {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const records: PreparedRecord[] = [];
  let lineNumber = 0;
  for (let start = 0; start < body.length; ) {
    const newline = body.indexOf(0x0a, start);
    const end = newline === -1 ? body.length : newline;
    const bytes = body.subarray(start, end);
    start = end + 1;
    lineNumber++;
    let line: unknown;
    try {
      const text = decoder.decode(bytes).trim();
      if (!text) continue;
      line = JSON.parse(text);
    } catch (err) {
      throw invalidLine(key, lineNumber, 'is not valid UTF-8 JSON', err);
    }
    if (!isRecord(line)) throw invalidLine(key, lineNumber, 'is not a JSON object');
    if (line.type !== 'edanmdm') continue;
    if (typeof line.url !== 'string' || !line.url) {
      throw invalidLine(key, lineNumber, 'is an edanmdm record without a url');
    }
    const doc = trimRecord(line);
    records.push({ url: line.url, doc: encodeDoc(doc), terms: facetTerms(doc) });
  }
  return records;
}

// ---------------------------------------------------------------------------
// Store writes
// ---------------------------------------------------------------------------

type BoundValue = SqlValue | Uint8Array;

interface Statement<Row> {
  all(...params: BoundValue[]): Row[];
  get(...params: BoundValue[]): Row | undefined;
  run(...params: BoundValue[]): { changes: number; lastInsertRowid: number | bigint };
}

/**
 * Prepare a statement that may bind a BLOB. The framework handle types parameters as
 * `SqlValue`; both drivers bind a `Uint8Array` as a BLOB, which is how `objects.doc` is written.
 */
function prepare<Row = unknown>(handle: SqliteHandle, sql: string): Statement<Row> {
  return handle.prepare<Row>(sql) as unknown as Statement<Row>;
}

/** The write statements of one sync run, and the per-shard and per-record operations on them. */
function createWriter(handle: SqliteHandle) {
  const statements = {
    upsertShard: prepare<{ id: number }>(
      handle,
      'INSERT INTO shards(key) VALUES (?) ON CONFLICT(key) DO UPDATE SET key = excluded.key RETURNING id',
    ),
    markShard: prepare(handle, 'UPDATE shards SET etag = ?, last_modified = ? WHERE id = ?'),
    deleteShard: prepare(handle, 'DELETE FROM shards WHERE id = ?'),
    shardObjects: prepare<{ obj: number; url: string }>(
      handle,
      'SELECT rowid AS obj, url FROM objects WHERE shard = ?',
    ),
    byUrl: prepare<{ doc: Uint8Array; obj: number; shard: number }>(
      handle,
      'SELECT rowid AS obj, doc, shard FROM objects WHERE url = ?',
    ),
    docByRowid: prepare<{ doc: Uint8Array }>(handle, 'SELECT doc FROM objects WHERE rowid = ?'),
    insertObject: prepare(handle, 'INSERT INTO objects(url, doc, shard) VALUES (?, ?, ?)'),
    updateObject: prepare(handle, 'UPDATE objects SET doc = ?, shard = ? WHERE rowid = ?'),
    moveObject: prepare(handle, 'UPDATE objects SET shard = ? WHERE rowid = ?'),
    deleteObject: prepare(handle, 'DELETE FROM objects WHERE rowid = ?'),
    addTerm: prepare<{ id: number }>(
      handle,
      'INSERT INTO terms(field, value, n) VALUES (?, ?, 1) ON CONFLICT(field, value) DO UPDATE SET n = n + 1 RETURNING id',
    ),
    dropTerm: prepare<{ id: number }>(
      handle,
      'UPDATE terms SET n = n - 1 WHERE field = ? AND value = ? RETURNING id',
    ),
    insertFacet: prepare(handle, 'INSERT INTO facets(term, obj) VALUES (?, ?)'),
    deleteFacet: prepare(handle, 'DELETE FROM facets WHERE term = ? AND obj = ?'),
  };

  const index = (obj: number, term: FacetTerm) => {
    const row = statements.addTerm.get(term.field, term.value);
    if (!row) throw new Error(`Upserting term ${term.field}=${term.value} returned no id.`);
    statements.insertFacet.run(row.id, obj);
  };
  const unindex = (obj: number, term: FacetTerm) => {
    const row = statements.dropTerm.get(term.field, term.value);
    // Every facet of a stored doc was indexed when the doc was written, in the same transaction.
    if (!row) throw new Error(`Stored doc ${obj} is indexed under unknown term ${term.field}.`);
    statements.deleteFacet.run(row.id, obj);
  };
  const removeObject = (obj: number) => {
    const row = statements.docByRowid.get(obj);
    if (!row) throw new Error(`Object row ${obj} vanished inside its own transaction.`);
    for (const term of facetTerms(decodeDoc(row.doc)).values()) unindex(obj, term);
    statements.deleteObject.run(obj);
  };

  return {
    /**
     * Apply one shard's records in one transaction: add new records, rewrite changed ones and
     * their facets, leave byte-identical ones unwritten, delete the shard's records that are
     * now absent, then record the ETag. `terms.n` moves with every facet row.
     */
    applyShard(shard: ListedShard, records: PreparedRecord[]): ShardStats {
      return handle.transaction(() => {
        const shardRow = statements.upsertShard.get(shard.key);
        if (!shardRow) throw new Error(`Upserting shard ${shard.key} returned no id.`);
        const shardId = shardRow.id;
        const absent = new Map(statements.shardObjects.all(shardId).map((r) => [r.url, r.obj]));
        const stats: ShardStats = {
          records: records.length,
          added: 0,
          changed: 0,
          unchanged: 0,
          removed: 0,
        };
        for (const record of records) {
          absent.delete(record.url);
          const row = statements.byUrl.get(record.url);
          if (!row) {
            const obj = Number(
              statements.insertObject.run(record.url, record.doc, shardId).lastInsertRowid,
            );
            for (const term of record.terms.values()) index(obj, term);
            stats.added++;
          } else if (sameDoc(row.doc, record.doc)) {
            // A record can move between shards when upstream re-shards; its doc is untouched.
            if (row.shard !== shardId) statements.moveObject.run(shardId, row.obj);
            stats.unchanged++;
          } else {
            const previous = facetTerms(decodeDoc(row.doc));
            for (const [key, term] of previous) if (!record.terms.has(key)) unindex(row.obj, term);
            for (const [key, term] of record.terms) if (!previous.has(key)) index(row.obj, term);
            statements.updateObject.run(record.doc, shardId, row.obj);
            stats.changed++;
          }
        }
        for (const obj of absent.values()) removeObject(obj);
        stats.removed = absent.size;
        statements.markShard.run(shard.etag, shard.lastModified, shardId);
        return stats;
      });
    },

    /** Delete a no-longer-listed shard and every record last read from it. */
    dropShard(shardId: number): number {
      return handle.transaction(() => {
        const objs = statements.shardObjects.all(shardId);
        for (const { obj } of objs) removeObject(obj);
        statements.deleteShard.run(shardId);
        return objs.length;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * The mirror's sync generator over `store`, the store the mirror is defined on. Both modes run
 * one pass: list the bucket, apply every shard whose ETag changed (one page per shard, its key
 * as the cursor), remove delisted shards, then yield the final page with the checkpoint: the
 * newest listed LastModified, which is the mirror's snapshot date. A failure stops the run
 * before that page, so the stored snapshot stays at the last completed sync, and the next run
 * resumes by ETag.
 *
 * A `refresh` of a store holding no shards throws `ConfigurationError` (`mirror_not_built`)
 * before any request: the first build downloads the whole bucket, so it runs only when an
 * operator asks for it with `init`, never from a scheduled refresh of a mistyped path.
 */
export function createOaSync(store: MirrorStore, logger: MirrorLogger = {}): SyncGenerator {
  return async function* sync({ mode, signal }) {
    const handle = await store.raw();
    const stored = handle
      .prepare<{ etag: string | null; id: number; key: string }>('SELECT id, key, etag FROM shards')
      .all();
    if (mode === 'refresh' && stored.length === 0) {
      throw configurationError(
        'The mirror holds no shards, so there is nothing to refresh. Build it with `mirror:init`; a refresh only updates a mirror that init has built or started.',
        { reason: 'mirror_not_built' },
      );
    }
    const listed = await listShards(signal);
    // An empty listing would delist, and so delete, every stored record.
    if (listed.length === 0) {
      throw serviceUnavailable(`The bucket listing under ${SHARD_PREFIX} returned no shards.`, {
        reason: 'empty_listing',
      });
    }
    const writer = createWriter(handle);
    const storedEtags = new Map(stored.map((s) => [s.key, s.etag]));

    let applied = 0;
    const records = { added: 0, changed: 0, unchanged: 0, removed: 0 };
    for (const shard of listed) {
      if (storedEtags.get(shard.key) === shard.etag) continue;
      const stats = writer.applyShard(
        shard,
        prepareRecords(await downloadShard(shard, signal), shard.key),
      );
      applied++;
      records.added += stats.added;
      records.changed += stats.changed;
      records.unchanged += stats.unchanged;
      records.removed += stats.removed;
      logger.info?.('Applied shard', { key: shard.key, ...stats });
      yield { records: [], cursor: shard.key };
    }

    const listedKeys = new Set(listed.map((s) => s.key));
    let delisted = 0;
    for (const { id, key } of stored) {
      if (listedKeys.has(key)) continue;
      const removed = writer.dropShard(id);
      delisted++;
      records.removed += removed;
      logger.info?.('Removed delisted shard', { key, removed });
    }

    // ISO 8601 UTC timestamps sort chronologically as strings.
    const snapshot = listed
      .map((s) => s.lastModified)
      .sort()
      .at(-1);
    logger.info?.('Bucket pass complete', {
      shards: { listed: listed.length, unchanged: listed.length - applied, applied, delisted },
      records,
      snapshot,
    });
    yield { records: [], checkpoint: snapshot };
  };
}
