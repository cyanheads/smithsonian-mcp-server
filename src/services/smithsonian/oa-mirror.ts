/**
 * @fileoverview Local store of the Smithsonian Open Access bulk metadata (the `metadata/edan/`
 * JSON Lines in the public `smithsonian-open-access` S3 bucket) and the read API that object
 * reads and filter-only searches go through. Owns the schema, the stored-document codec, and the
 * facet index; `oa-ingest.ts` fills the store.
 *
 * | Table | Contents |
 * |:--|:--|
 * | `objects` (framework store) | `url` primary key; `doc` = the deflated {@link trimRecord} JSON; `shard` = the `shards.id` the record was last read from |
 * | `terms` | one row per facet value; `n` = how many records carry it |
 * | `facets` | `(term, obj)` pairs, `obj` = `objects.rowid`; its primary key is the index every facet query walks |
 * | `shards` | each applied bucket shard, with the ETag and LastModified it was applied at |
 *
 * `facets.obj` holds `objects.rowid`, which an upsert keeps and nothing here renumbers; the
 * store is never vacuumed, since a VACUUM is allowed to renumber the rowids of a table without
 * an INTEGER PRIMARY KEY.
 * @module services/smithsonian/oa-mirror
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';
import {
  type MirrorStore,
  type SqliteHandle,
  sqliteMirrorStore,
} from '@cyanheads/mcp-ts-core/mirror';
import { isRecord } from '@cyanheads/mcp-ts-core/utils';
import type { RawEDAN } from './types.js';

/**
 * Index entries a facet search may walk: `start + rows` along one term's range (or along
 * `objects` with no filter), or the whole range of the rarest term when several intersect.
 * Measured at roughly 24M range entries/s and 3.5M intersection probes/s, it holds a mirror
 * query to tens of milliseconds of synchronous work; past it the search belongs to the live API.
 */
export const SCAN_BUDGET = 100_000;

/** Facets matched by exact, case-sensitive value — the EDAN filter fields of the same names. */
export type ValueFacet =
  | 'unit_code'
  | 'object_type'
  | 'date'
  | 'culture'
  | 'place'
  | 'topic'
  | 'name'
  | 'scientific_name'
  | 'online_media_type';

/**
 * Presence facets: `online_only` marks a record with any `online_media_type` value (EDAN
 * `online_media_type:*`), `cc0` one with a media item whose `usage.access` is `CC0` (EDAN
 * `media_usage:CC0`).
 */
export type FlagFacet = 'online_only' | 'cc0';

export type FacetField = ValueFacet | FlagFacet;

/** One search constraint. Several are intersected. */
export type FacetFilter = { field: ValueFacet; value: string } | { field: FlagFacet };

/** One indexed facet value of a record. */
export interface FacetTerm {
  field: FacetField;
  value: string;
}

/**
 * A facet search answered from the mirror (`page`), or declined because it would walk more than
 * {@link SCAN_BUDGET} index entries (`over_budget`, with the count it would have walked).
 */
export type FacetSearchResult =
  | { kind: 'page'; docs: RawEDAN[]; total: number }
  | { kind: 'over_budget'; entries: number };

/** The `terms.value` a presence facet is stored under. */
const FLAG_VALUE = 'true';

/** `indexedStructured` string arrays indexed as value facets under their own names. */
const ARRAY_FACETS = [
  'object_type',
  'date',
  'culture',
  'place',
  'topic',
  'scientific_name',
  'online_media_type',
] as const satisfies readonly ValueFacet[];

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** The store's schema version. */
const SCHEMA_VERSION = 1;

/** The auxiliary tables, one statement each: `bun:sqlite`'s multi-statement `exec` drops errors. */
const AUXILIARY_TABLES = [
  'CREATE TABLE IF NOT EXISTS terms (id INTEGER PRIMARY KEY, field TEXT NOT NULL, value TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, UNIQUE (field, value))',
  'CREATE TABLE IF NOT EXISTS facets (term INTEGER NOT NULL, obj INTEGER NOT NULL, PRIMARY KEY (term, obj)) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS shards (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, etag TEXT, last_modified TEXT)',
];

/**
 * The mirror's SQLite store at `path`, created on first use. Opening it needs `bun:sqlite` on
 * Bun or the optional `better-sqlite3` peer on Node.
 */
export function oaMirrorStore(path: string): MirrorStore {
  return sqliteMirrorStore({
    path,
    table: 'objects',
    primaryKey: 'url',
    columns: { url: 'TEXT', doc: 'BLOB NOT NULL', shard: 'INTEGER NOT NULL' },
    indexes: [{ columns: ['shard'] }],
    version: SCHEMA_VERSION,
    migrations: [
      {
        version: 1,
        up(handle: SqliteHandle) {
          for (const sql of AUXILIARY_TABLES) handle.exec(sql);
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Stored document
// ---------------------------------------------------------------------------

type Fields = Record<string, unknown>;

const RECORD_KEYS = ['url', 'title', 'unitCode'];
const DESCRIPTIVE_KEYS = ['unit_code', 'record_ID', 'record_link', 'data_source'];
const MEDIA_KEYS = [
  'type',
  'id',
  'idsId',
  'thumbnail',
  'content',
  'altTextAccessibility',
  'extDescrAccessibility',
];
const RESOURCE_KEYS = ['label', 'url', 'width', 'height'];
const FREETEXT_FIELDS = [
  'date',
  'notes',
  'name',
  'physicalDescription',
  'place',
  'topic',
  'exhibitionHistory',
  'creditLine',
  'identifier',
  'objectRights',
];
const INDEXED_KEYS = [
  ...ARRAY_FACETS,
  'tax_kingdom',
  'tax_phylum',
  'tax_class',
  'tax_order',
  'tax_family',
];

/** Copy the named keys that are set. Values pass through exactly as upstream wrote them. */
function pick(source: Fields, keys: readonly string[]): Fields {
  const out: Fields = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

function isEmpty(fields: Fields): boolean {
  return Object.keys(fields).length === 0;
}

function trimMedia(item: Fields): Fields {
  const out = pick(item, MEDIA_KEYS);
  if (isRecord(item.usage) && item.usage.access !== undefined) {
    out.usage = { access: item.usage.access };
  }
  if (Array.isArray(item.resources)) {
    out.resources = item.resources.filter(isRecord).map((r) => pick(r, RESOURCE_KEYS));
  }
  return out;
}

function trimDescriptive(descriptive: Fields): Fields {
  const out = pick(descriptive, DESCRIPTIVE_KEYS);
  const usage = descriptive.metadata_usage;
  if (isRecord(usage) && usage.access !== undefined) out.metadata_usage = { access: usage.access };
  const online = descriptive.online_media;
  if (isRecord(online)) {
    const media = pick(online, ['mediaCount']);
    if (Array.isArray(online.media)) media.media = online.media.filter(isRecord).map(trimMedia);
    out.online_media = media;
  }
  return out;
}

/** Freetext entries without content are dropped: every reader skips an entry lacking it. */
function trimFreetext(freetext: Fields): Fields {
  const out: Fields = {};
  for (const field of FREETEXT_FIELDS) {
    const entries = freetext[field];
    if (!Array.isArray(entries)) continue;
    const kept = entries
      .filter((entry): entry is Fields => isRecord(entry) && Boolean(entry.content))
      .map((entry) => pick(entry, ['label', 'content']));
    if (kept.length > 0) out[field] = kept;
  }
  return out;
}

function trimLocation(location: Fields): Fields {
  const out: Fields = {};
  const points = location.points;
  if (isRecord(points) && isRecord(points.point)) {
    out.points = { point: pick(points.point, ['latitude', 'longitude']) };
  }
  if (isRecord(location.Other)) out.Other = pick(location.Other, ['type', 'content']);
  return out;
}

function trimIndexed(indexed: Fields): Fields {
  const out = pick(indexed, INDEXED_KEYS);
  if (Array.isArray(indexed.name)) {
    const names = indexed.name.flatMap((entry): unknown[] =>
      typeof entry === 'string'
        ? [entry]
        : isRecord(entry) && entry.content !== undefined
          ? [{ content: entry.content }]
          : [],
    );
    if (names.length > 0) out.name = names;
  }
  if (Array.isArray(indexed.geoLocation)) {
    const locations = indexed.geoLocation
      .filter(isRecord)
      .map(trimLocation)
      .filter((l) => !isEmpty(l));
    if (locations.length > 0) out.geoLocation = locations;
  }
  return out;
}

/**
 * The subset of a bulk `edanmdm` line the mirror stores: every field `toFullObject`,
 * `toSummary`, `toImageItems`, smithsonian_get_media, and smithsonian_find_related read, plus
 * every facet source, under upstream key names so the normalizers run on it unchanged.
 *
 * Containers are checked as they are walked; leaf values are copied exactly as upstream wrote
 * them, the same trust the live `/content` path gives a response.
 *
 * Changing what this keeps (or what {@link facetTerms} derives) changes stored docs: ship it
 * with a migration that clears `shards.etag`, so the next sync re-reads every shard.
 */
export function trimRecord(line: Fields): RawEDAN {
  const content = isRecord(line.content) ? line.content : {};
  const trimmed: Fields = {};
  if (isRecord(content.descriptiveNonRepeating)) {
    trimmed.descriptiveNonRepeating = trimDescriptive(content.descriptiveNonRepeating);
  }
  if (isRecord(content.freetext)) {
    const freetext = trimFreetext(content.freetext);
    if (!isEmpty(freetext)) trimmed.freetext = freetext;
  }
  if (isRecord(content.indexedStructured)) {
    const indexed = trimIndexed(content.indexedStructured);
    if (!isEmpty(indexed)) trimmed.indexedStructured = indexed;
  }
  return { ...pick(line, RECORD_KEYS), content: trimmed } as RawEDAN;
}

/** The stored form of a trimmed doc: its JSON, raw-deflated. */
export function encodeDoc(doc: RawEDAN): Buffer {
  return deflateRawSync(JSON.stringify(doc));
}

/** Read a stored doc back into the record shape the normalizers take. */
export function decodeDoc(blob: Uint8Array): RawEDAN {
  // The mirror's own encodeDoc output, not upstream input.
  return JSON.parse(inflateRawSync(blob).toString('utf8')) as RawEDAN;
}

/**
 * Whether two stored docs hold the same JSON. Equal bytes settle it; otherwise both are
 * inflated, because Bun and Node deflate the same text to different bytes, and a store built
 * under one runtime is refreshed under either.
 */
export function sameDoc(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.compare(a, b) === 0 || inflateRawSync(a).equals(inflateRawSync(b));
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The facet values a doc is indexed under, keyed `field\u0000value`: top-level `unitCode` as
 * `unit_code`; the `indexedStructured` arrays of the same names; `indexedStructured.name`
 * entries (a string, or an object's `content`) as `name`; and the presence flags `online_only`
 * and `cc0`. Values match exactly; empty strings are not indexed.
 */
export function facetTerms(doc: RawEDAN): Map<string, FacetTerm> {
  const terms = new Map<string, FacetTerm>();
  const add = (field: FacetField, value: unknown) => {
    if (typeof value === 'string' && value) terms.set(`${field}\u0000${value}`, { field, value });
  };
  add('unit_code', doc.unitCode);
  const indexed = doc.content?.indexedStructured;
  for (const field of ARRAY_FACETS) {
    for (const value of arrayOf(indexed?.[field])) add(field, value);
  }
  for (const entry of arrayOf(indexed?.name)) {
    add('name', isRecord(entry) ? entry.content : entry);
  }
  if (arrayOf(indexed?.online_media_type).some((v) => typeof v === 'string' && v)) {
    add('online_only', FLAG_VALUE);
  }
  const media = arrayOf(doc.content?.descriptiveNonRepeating?.online_media?.media);
  if (media.some((m) => isRecord(m) && isRecord(m.usage) && m.usage.access === 'CC0')) {
    add('cc0', FLAG_VALUE);
  }
  return terms;
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

/**
 * `FROM` and `WHERE` of an intersection of `count` terms: the first (rarest) term's range is
 * walked, and each other term is probed by primary key for the same object.
 */
function intersection(count: number): string {
  let sql = 'FROM facets f0 WHERE f0.term = ?';
  for (let i = 1; i < count; i++) {
    sql += ` AND EXISTS (SELECT 1 FROM facets f${i} WHERE f${i}.term = ? AND f${i}.obj = f0.obj)`;
  }
  return sql;
}

/** Read access to a mirror store. Every method opens the store on first use. */
export class OaMirror {
  constructor(private readonly store: MirrorStore) {}

  /**
   * True once a sync has ever completed. A refresh in progress, or one that failed, leaves the
   * last completed dataset in place, so the mirror stays ready through both.
   */
  async ready(): Promise<boolean> {
    return (await this.store.readState()).completedAt !== undefined;
  }

  /**
   * When the bucket content the mirror last completed a sync against was published: the newest
   * shard LastModified in that listing, ISO 8601. Undefined until a sync completes.
   */
  async snapshot(): Promise<string | undefined> {
    const state = await this.store.readState();
    return state.completedAt === undefined ? undefined : state.checkpoint;
  }

  /** The stored doc for a record `url` (`edanmdm:<record_ID>`), or undefined when not mirrored. */
  async getDoc(url: string): Promise<RawEDAN | undefined> {
    const handle = await this.store.raw();
    const row = handle
      .prepare<{ doc: Uint8Array }>('SELECT doc FROM objects WHERE url = ?')
      .get(url);
    return row ? decodeDoc(row.doc) : undefined;
  }

  /**
   * The records matching every filter, ordered by `objects.rowid` (ingest order), from `start`,
   * at most `rows` of them, with the total match count. No filters matches every record, with
   * the total counted at the last completed sync; one filter takes its total from `terms.n`;
   * several are counted by intersecting them. A search that would walk more than
   * {@link SCAN_BUDGET} index entries returns `over_budget` without walking them.
   *
   * Reads run in one transaction, so the page and its total come from one snapshot even while
   * a sync is committing shards. Call only once {@link ready} is true.
   */
  async searchFacets(
    filters: readonly FacetFilter[],
    start: number,
    rows: number,
  ): Promise<FacetSearchResult> {
    const handle = await this.store.raw();
    const wanted = new Map<string, FacetTerm>();
    for (const filter of filters) {
      const value = 'value' in filter ? filter.value : FLAG_VALUE;
      wanted.set(`${filter.field}\u0000${value}`, { field: filter.field, value });
    }
    const syncTotal = wanted.size === 0 ? (await this.store.readState()).total : undefined;

    return handle.transaction((): FacetSearchResult => {
      if (wanted.size === 0) {
        if (syncTotal === undefined) {
          throw new Error('The mirror has not completed a sync; check ready() before searching.');
        }
        const entries = Math.min(start + rows, syncTotal);
        if (entries > SCAN_BUDGET) return { kind: 'over_budget', entries };
        const objs = handle
          .prepare<{ obj: number }>(
            'SELECT rowid AS obj FROM objects ORDER BY rowid LIMIT ? OFFSET ?',
          )
          .all(rows, start);
        return { kind: 'page', docs: this.docs(handle, objs), total: syncTotal };
      }

      const lookup = handle.prepare<{ id: number; n: number }>(
        'SELECT id, n FROM terms WHERE field = ? AND value = ?',
      );
      const terms: Array<{ id: number; n: number }> = [];
      for (const { field, value } of wanted.values()) {
        const term = lookup.get(field, value);
        if (!term || term.n === 0) return { kind: 'page', docs: [], total: 0 };
        terms.push(term);
      }
      terms.sort((a, b) => a.n - b.n);
      const ids = terms.map((t) => t.id);
      const rarest = Math.min(...terms.map((t) => t.n));
      // One term walks only to the end of the page; an intersection walks the rarest range whole.
      const entries = ids.length === 1 ? Math.min(start + rows, rarest) : rarest;
      if (entries > SCAN_BUDGET) return { kind: 'over_budget', entries };

      const from = intersection(ids.length);
      const total =
        ids.length === 1
          ? rarest
          : (handle.prepare<{ n: number }>(`SELECT COUNT(*) AS n ${from}`).get(...ids)?.n ?? 0);
      const objs = handle
        .prepare<{ obj: number }>(`SELECT f0.obj AS obj ${from} ORDER BY f0.obj LIMIT ? OFFSET ?`)
        .all(...ids, rows, start);
      return { kind: 'page', docs: this.docs(handle, objs), total };
    });
  }

  /** Close the store. */
  close(): Promise<void> {
    return this.store.close();
  }

  private docs(handle: SqliteHandle, objs: Array<{ obj: number }>): RawEDAN[] {
    const byRowid = handle.prepare<{ doc: Uint8Array }>('SELECT doc FROM objects WHERE rowid = ?');
    return objs.map(({ obj }) => {
      const row = byRowid.get(obj);
      // Facets and objects are written in the same transaction, and this read runs in one.
      if (!row) throw new Error(`Mirror facet index references missing object row ${obj}.`);
      return decodeDoc(row.doc);
    });
  }
}
