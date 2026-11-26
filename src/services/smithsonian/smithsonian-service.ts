/**
 * @fileoverview Smithsonian EDAN Open Access API service — search and content retrieval, answered
 * from the Open Access bulk mirror where it can and from the live API otherwise.
 * @module services/smithsonian/smithsonian-service
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  forbidden,
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import { fetchWithTimeout, isRecord, logger, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type { FacetFilter, OaMirror } from './oa-mirror.js';
import { ResponseCache } from './response-cache.js';
import { SharedLoads } from './shared-loads.js';
import type {
  FullObject,
  ImageItem,
  IndexedFilterValues,
  MediaResolution,
  ModelFile,
  ModelPackage,
  NonImageMedia,
  ObjectSummary,
  Provenance,
  RawContentResponse,
  RawEDAN,
  RawFreetextEntry,
  RawIndexedStructured,
  RawMediaItem,
  RawMediaResource,
  RawSearchResponse,
  RawTermsResponse,
  TermDescription,
} from './types.js';

// ---------------------------------------------------------------------------
// Unit code → museum name map
// ---------------------------------------------------------------------------

/**
 * Unit code → museum name, covering 44 of the 48 codes EDAN indexes under
 * `unit_code`. Names come from the Smithsonian's own published data dictionary
 * (github.com/Smithsonian/OpenAccess) and each record's self-reported
 * `descriptiveNonRepeating.data_source`, cross-checked against the owning unit's
 * si.edu site where neither covers the code.
 *
 * Four indexed codes — `FSA`, `NASMAC`, `NMAIA`, `SAAMPAIK` — are deliberately
 * absent: no primary source ties those literal strings to a named unit, and their
 * shape only suggests an archive under NASM/NMAI/SAAM. Expanding them from that
 * pattern would ship a guess as a sourced fact on a public field, so they take the
 * raw-code fallback below instead.
 *
 * One key is not an indexed code: `SERC`, which eight `OCIO_DPO3D` records give as
 * their `data_source` where the ninth gives the name. It resolves those to the name
 * for `holding_museum_name`.
 *
 * Backs the `museum_name` field on every object-returning tool and the `labels`
 * map `smithsonian_list_terms` returns for `unit_code`. The other names a unit answers
 * to in that tool's `contains` match are {@link MUSEUM_ALIASES}, which neither field
 * carries.
 *
 * Keys are matched exactly, including case (`NMAfA` carries a lowercase f upstream)
 * and separators (`OFEO-SG`, `SLA_SRO`, `OCIO_DPO3D`). Two codes that earlier
 * versions mapped are gone: bare `NMNH`, superseded by the eleven `NMNH*` discipline
 * sub-units, and `FSG`, retired when the Freer/Sackler became the National Museum of
 * Asian Art (`NMAA`) in 2019. Neither can match a live record, and `FSG` would have
 * echoed a name the institution no longer uses.
 */
export const MUSEUM_NAMES: Record<string, string> = {
  AAA: 'Archives of American Art',
  AAG: 'Archives of American Gardens',
  ACAH: 'Archives Center, National Museum of American History',
  ACM: 'Anacostia Community Museum',
  ACMA: 'Anacostia Community Museum Archives',
  CFCHFOLKLIFE: 'Ralph Rinzler Folklife Archives and Collections',
  CHNDM: 'Cooper Hewitt, Smithsonian Design Museum',
  CHSDM: 'Cooper Hewitt, Smithsonian Design Museum',
  EEPA: 'Eliot Elisofon Photographic Archives',
  FBR: 'Smithsonian Field Book Project',
  HAC: 'Smithsonian Gardens',
  HMSG: 'Hirshhorn Museum and Sculpture Garden',
  HSFA: 'Human Studies Film Archives',
  NAA: 'National Anthropological Archives',
  NASM: 'National Air and Space Museum',
  NMAA: 'National Museum of Asian Art',
  NMAAHC: 'National Museum of African American History and Culture',
  NMAH: 'National Museum of American History',
  NMAI: 'National Museum of the American Indian',
  NMAfA: 'National Museum of African Art',
  NMNHANTHRO: 'NMNH - Anthropology Dept.',
  NMNHBIRDS: 'NMNH - Vertebrate Zoology - Birds Division',
  NMNHBOTANY: 'NMNH - Botany Dept.',
  NMNHEDUCATION: 'NMNH - Education & Outreach',
  NMNHENTO: 'NMNH - Entomology Dept.',
  NMNHFISHES: 'NMNH - Vertebrate Zoology - Fishes Division',
  NMNHHERPS: 'NMNH - Vertebrate Zoology - Herpetology Division',
  NMNHINV: 'NMNH - Invertebrate Zoology Dept.',
  NMNHMAMMALS: 'NMNH - Vertebrate Zoology - Mammals Division',
  NMNHMINSCI: 'NMNH - Mineral Sciences Dept.',
  NMNHPALEO: 'NMNH - Paleobiology Dept.',
  NPG: 'National Portrait Gallery',
  NPM: 'National Postal Museum',
  NPMA: 'National Postal Museum Archives',
  NZP: "Smithsonian's National Zoo & Conservation Biology Institute",
  OCIO_DPO3D:
    'Office of the Chief Information Officer - Digitization Program Office (3D digitization)',
  'OFEO-SG': 'Smithsonian Gardens',
  SAAM: 'Smithsonian American Art Museum',
  SERC: 'Smithsonian Environmental Research Center',
  SI: 'Smithsonian Institution',
  SIA: 'Smithsonian Institution Archives',
  SIL: 'Smithsonian Libraries',
  SILAF: 'Smithsonian Libraries',
  SILNMAHTL: 'Smithsonian Libraries',
  SLA_SRO: 'Smithsonian Libraries and Archives',
};

/** The name {@link MUSEUM_NAMES} gives a unit code, from its own keys only: codes are upstream text. */
function unitName(code: string): string | undefined {
  return Object.hasOwn(MUSEUM_NAMES, code) ? MUSEUM_NAMES[code] : undefined;
}

/** Resolve a unit code to its museum name, echoing the raw code when unmapped. */
function museumName(unitCode: string | undefined): string {
  return (unitCode && unitName(unitCode)) ?? unitCode ?? 'Smithsonian Institution';
}

/** The museum every `NMNH - …` division label abbreviates and none spells out. */
const NMNH_NAME = ['National Museum of Natural History'];

/**
 * Names a unit code answers to beyond its {@link MUSEUM_NAMES} label, read only by the
 * `smithsonian_list_terms` name match, so `museum_name` and `labels` never carry them.
 * Relabeling instead would rewrite sourced upstream text and split `museum_name` from
 * `holding_museum_name`, which reads `data_source` verbatim.
 *
 * - The eleven `NMNH*` divisions: the data dictionary and their records' `data_source`
 *   name each `NMNH - <division>`, NMNH being the National Museum of Natural History. The
 *   alias leaves out "Smithsonian", so `contains: "Smithsonian"` does not pull all eleven
 *   in; the match drops a leading "Smithsonian" from the caller's text instead.
 * - `NMAA`: the Freer Gallery of Art and the Arthur M. Sackler Gallery, the two galleries
 *   that became the National Museum of Asian Art in 2019 (the retired `FSG` code).
 * - `CHNDM`, `CHSDM`: Cooper-Hewitt, National Design Museum, the museum's name until it
 *   became Cooper Hewitt, Smithsonian Design Museum in 2014 (`CHNDM` is that era's code).
 *
 * Each alias is a full, sourced name of its unit: the match runs the caller's text inside
 * each name, so an alias can claim a code wrongly only by not being a true name of it.
 * Branch buildings (Renwick, Udvar-Hazy, Heye Center), parent units absent from a code's
 * own label, and the four unattributed codes get none.
 */
const MUSEUM_ALIASES: Record<string, readonly string[]> = {
  CHNDM: ['Cooper-Hewitt, National Design Museum'],
  CHSDM: ['Cooper-Hewitt, National Design Museum'],
  NMAA: ['Freer Gallery of Art', 'Arthur M. Sackler Gallery'],
  NMNHANTHRO: NMNH_NAME,
  NMNHBIRDS: NMNH_NAME,
  NMNHBOTANY: NMNH_NAME,
  NMNHEDUCATION: NMNH_NAME,
  NMNHENTO: NMNH_NAME,
  NMNHFISHES: NMNH_NAME,
  NMNHHERPS: NMNH_NAME,
  NMNHINV: NMNH_NAME,
  NMNHMAMMALS: NMNH_NAME,
  NMNHMINSCI: NMNH_NAME,
  NMNHPALEO: NMNH_NAME,
};

/**
 * Fold a museum name, or caller text matched against one, to the form the name match
 * compares: lowercase, curly apostrophes straight, `&` as `and`, every run of hyphens and
 * whitespace one space, the ends trimmed. One linear pass per step over the text.
 */
function foldName(text: string): string {
  return text
    .toLowerCase()
    .replaceAll('‘', "'")
    .replaceAll('’', "'")
    .replaceAll('&', 'and')
    .replace(/[\s-]+/g, ' ')
    .trim();
}

/** Every name each mapped code answers to — its label, then its aliases — folded once. */
const FOLDED_NAMES = new Map(
  Object.entries(MUSEUM_NAMES).map(([code, name]) => [
    code,
    [name, ...(MUSEUM_ALIASES[code] ?? [])].map(foldName),
  ]),
);

/** Leading words an official name carries that no label repeats, as {@link foldName} leaves them. */
const NAME_PREFIXES = ["smithsonian's ", 'smithsonian '];

/**
 * The caller's `contains` text as the name match reads it: folded, without a leading
 * "Smithsonian" or "Smithsonian's" when words remain after it, so the official
 * "Smithsonian National Portrait Gallery" finds the label "National Portrait Gallery" while
 * "Smithsonian" alone still finds every name carrying the word.
 */
function nameNeedle(contains: string): string {
  const folded = foldName(contains);
  const prefix = NAME_PREFIXES.find((p) => folded.startsWith(p));
  return prefix ? folded.slice(prefix.length) : folded;
}

/**
 * Whether a name `code` answers to contains `needle`, a {@link nameNeedle} of the caller's
 * lowercased text `raw`. Text that folds to nothing, only whitespace and hyphens, matches the
 * label as written instead, so `" "` and `"-"` keep the codes they listed before folding.
 */
function matchesMuseumName(code: string, needle: string, raw: string): boolean {
  if (needle === '') return unitName(code)?.toLowerCase().includes(raw) ?? false;
  return FOLDED_NAMES.get(code)?.some((name) => name.includes(needle)) ?? false;
}

// ---------------------------------------------------------------------------
// Upstream text normalization
// ---------------------------------------------------------------------------

/**
 * A markup tag: `<`, an optional `/`, then one of the nine element names EDAN emits
 * (`a b br em i p span sub sup` — every name in a 46,352-record sample across 34
 * units), in any case, ending at whitespace, `/`, or `>`. Every other bracketed run
 * is catalog text and stays as written: MARC supplied text (`Issues for <winter
 * 1988->`), qualifiers (`Berberin <Frau>`), `<U+309A>`, `<p. 23>`, `Depth <20 m`.
 *
 * The attributes run to the first `>` outside quotes, so a quoted value may hold
 * `<` or `>` and a SICI DOI (`href="…14<238:CLOARB>2.0.CO;2"`) stays inside its
 * anchor. The scan is linear in the text: a candidate ends at the first unquoted
 * `<`, each step takes one character or one whole quoted value, and a quote moves a
 * candidate between three states in a way no two candidates can share, so at most
 * three are open at any position.
 */
const MARKUP_TAG = /<\/?(a|b|br|em|i|p|span|sub|sup)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;

/**
 * The elements that separate lines rather than sit inside one, replaced with a
 * space so the words on either side stay apart. Every other tag is dropped
 * outright, which is what turns an anchor into its link text and keeps
 * `H<sub>2</sub>O` as `H2O` rather than `H 2 O`.
 */
const LINE_BREAKING_ELEMENTS = new Set(['br', 'p']);

/** Replace one {@link MARKUP_TAG} match: a space for a line-breaking element, nothing otherwise. */
function replaceMarkupTag(_tag: string, name: string): string {
  return LINE_BREAKING_ELEMENTS.has(name.toLowerCase()) ? ' ' : '';
}

/**
 * The five predefined XML entities plus `&nbsp;`. EDAN's live output uses
 * `&amp;` and `&quot;` from this set (and the numeric `&#39;`); the rest are
 * the standard companions. A name outside the table is left exactly as written
 * — dropping it would lose text, where keeping it costs one unreadable token.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

/** A character reference: named, decimal (`&#39;`), or hexadecimal (`&#x27;`). */
const CHARACTER_REFERENCE = /&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * Resolve one character reference, returning the raw match unchanged when it
 * does not resolve: a name outside {@link NAMED_ENTITIES}, or a code point that
 * cannot be encoded — past `0x10FFFF`, or a lone surrogate, which would leave
 * the field unserializable.
 */
function decodeCharacterReference(match: string, body: string): string {
  if (!body.startsWith('#')) return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  const hex = body[1] === 'x' || body[1] === 'X';
  const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
  if (!Number.isInteger(code) || code > 0x10ffff) return match;
  if (code >= 0xd800 && code <= 0xdfff) return match;
  return String.fromCodePoint(code);
}

/**
 * Render upstream EDAN text as plain text — {@link MARKUP_TAG} markup removed,
 * character references decoded (issue #49), every other bracketed run kept.
 *
 * The consumer of these fields is a language model, so an anchor tag or an
 * undecoded `&#39;` is noise it will quote back verbatim (`Women&#39;s`).
 * Records under `SLA_SRO` carry an `<a href>` citation in nearly every
 * description, and entity-bearing titles appear across the corpus. Catalog text
 * in angle brackets is not markup: deleting it loses words from the record.
 *
 * **Strip, then decode — in that order, once.** Decoding first would turn
 * `&lt;b&gt;`, which is an object title that talks ABOUT a tag, into a tag the
 * strip pass then deletes. Stripping first leaves it as the literal `<b>` the
 * catalog wrote. For the same reason there is exactly one decode pass: `&amp;#39;`
 * resolves to `&#39;` and stops there.
 *
 * Text carrying no markup is returned byte-identical — the whitespace collapse
 * runs only where a tag was actually removed, so a legitimately bare ampersand
 * or angle bracket, and the line structure of an unmarked-up note, both survive.
 */
export function toPlainText(value: string): string {
  const stripped = value.includes('<') ? value.replace(MARKUP_TAG, replaceMarkupTag) : value;
  const text = stripped === value ? value : stripped.replace(/\s+/g, ' ').trim();
  return text.replace(CHARACTER_REFERENCE, decodeCharacterReference);
}

/** Detect active Lucene syntax outside quoted phrases and escaped characters. */
export function hasActiveLuceneSyntax(query: string): boolean {
  let quoted = false;
  let escaped = false;
  let token = '';
  let literalToken = false;
  const isOperator = () => !literalToken && (token === 'AND' || token === 'OR' || token === 'NOT');
  for (const char of query) {
    if (escaped) {
      escaped = false;
      literalToken = true;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      literalToken = true;
      continue;
    }
    if (quoted) continue;
    if ('():[]{}+!^~'.includes(char) || char === '&' || char === '|') return true;
    if (char === '-' && token.length === 0) return true;
    if (char.trim() === '') {
      if (isOperator()) return true;
      token = '';
      literalToken = false;
    } else {
      // Only Boolean keywords matter; retain a bounded token while scanning.
      if (token.length < 4) token += char;
    }
  }
  return isOperator();
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/** Pick the first non-empty content string from a freetext label-array. */
function firstContent(entries: RawFreetextEntry[] | undefined): string | undefined {
  return entries?.find((e) => e.content)?.content;
}

/** The non-empty content strings of a freetext label-array, in catalog order. */
function collectContent(entries: RawFreetextEntry[] | undefined): string[] {
  return (entries ?? []).map((e) => e.content).filter((c): c is string => Boolean(c));
}

/**
 * Every entry of a freetext label-array that has content, in catalog order with repeated labels
 * kept, as `{ label, value }` under the entry's own label, or `fallback` when it has none.
 */
function labeledEntries(
  entries: RawFreetextEntry[] | undefined,
  fallback: string,
): Array<{ label: string; value: string }> {
  return (entries ?? []).flatMap((entry) =>
    entry.content ? [{ label: entry.label ?? fallback, value: entry.content }] : [],
  );
}

/**
 * Drop empties and exact duplicates from a string list, keeping first-seen order.
 * `Set` iteration is insertion-ordered, so the first occurrence of a repeated
 * term holds its position.
 */
function distinct(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** Return true when the object-level metadata_usage.access is CC0. */
function isObjectCC0(raw: RawEDAN): boolean {
  return raw.content?.descriptiveNonRepeating?.metadata_usage?.access === 'CC0';
}

/** The thumbnail of the first media item in online_media, by the rule get_media's images use. */
function firstThumbnail(raw: RawEDAN): string | undefined {
  const first = raw.content?.descriptiveNonRepeating?.online_media?.media?.[0];
  return first ? mediaThumbnail(first) : undefined;
}

/**
 * The unit code a record is indexed under: top-level `unitCode`, the value a
 * `unit_code:` filter and a museum browse match, falling back to the record's own
 * `descriptiveNonRepeating.unit_code` only when the indexed code is absent (issue #64).
 *
 * The two agree on every sampled record outside `OCIO_DPO3D`. Those records are
 * indexed under the 3D digitization office while their own code names the
 * contributing unit — often a code EDAN never indexes (`SAO`, `DPO`, `SERC`,
 * `NMAL`), so reporting it would hand the caller a filter that matches nothing.
 */
function indexedUnitCode(raw: RawEDAN): string {
  return raw.unitCode || raw.content?.descriptiveNonRepeating?.unit_code || '';
}

/**
 * The unit holding the object, by name, when the record's own unit code differs from
 * the indexed one; undefined otherwise. Read from `data_source` rather than resolved
 * from the record's code: `data_source` names the holder on every `OCIO_DPO3D`
 * record, while the code is often unindexed and unmapped, and `DPO` names the
 * digitization office itself rather than any holder. A `data_source` that is itself a
 * mapped unit code (`SERC`) resolves to that unit's name.
 */
function holdingMuseumName(raw: RawEDAN): string | undefined {
  const dnr = raw.content?.descriptiveNonRepeating;
  if (!raw.unitCode || !dnr?.unit_code || dnr.unit_code === raw.unitCode) return undefined;
  const source = dnr.data_source?.trim();
  if (!source) return undefined;
  return unitName(source) ?? source;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** The non-empty strings of an upstream array, in order; any other entry is dropped. */
function nonEmptyStrings(values: readonly unknown[] | undefined): string[] {
  return (values ?? []).filter(isText);
}

/**
 * `indexedStructured.onPhysicalExhibit` as a flag: true for `"Yes"`, false for `"No"`, and
 * undefined for a record that sets neither, which says nothing about display.
 */
function onView(indexed: RawIndexedStructured | undefined): boolean | undefined {
  const flags = indexed?.onPhysicalExhibit ?? [];
  if (flags.includes('Yes')) return true;
  return flags.includes('No') ? false : undefined;
}

/**
 * Where the object is on display now: one entry per `indexedStructured.exhibition` item, with
 * its building code, room, and `exhibitionTitle` where set. An item naming none is dropped.
 */
function currentExhibitions(
  indexed: RawIndexedStructured | undefined,
): FullObject['current_exhibitions'] {
  return (indexed?.exhibition ?? []).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const { building, room, exhibitionTitle: title } = entry;
    const exhibition = {
      ...(isText(building) && { building }),
      ...(isText(room) && { room }),
      ...(isText(title) && { title }),
    };
    return Object.keys(exhibition).length > 0 ? [exhibition] : [];
  });
}

/**
 * The values a record is indexed under for the `name`, `place`, `object_type`, `date`, and
 * `topic` search filters, each usable as that filter's value verbatim. A `name` entry wrapped
 * as `{ type, content }` (bibliographic and authority records) contributes its `content`.
 */
function indexedFilterValues(indexed: RawIndexedStructured | undefined): IndexedFilterValues {
  return {
    name: nonEmptyStrings(indexed?.name?.map((entry) => (isRecord(entry) ? entry.content : entry))),
    place: nonEmptyStrings(indexed?.place),
    object_type: nonEmptyStrings(indexed?.object_type),
    date: nonEmptyStrings(indexed?.date),
    topic: nonEmptyStrings(indexed?.topic),
  };
}

/** Normalize a raw EDAN record into an ObjectSummary. */
function normalizeToSummary(raw: RawEDAN): ObjectSummary {
  const dnr = raw.content?.descriptiveNonRepeating;
  const indexed = raw.content?.indexedStructured;
  const recordId = dnr?.record_ID ?? raw.url?.replace(/^edanmdm:/, '') ?? raw.id ?? '';
  const unitCode = indexedUnitCode(raw);
  const holdingName = holdingMuseumName(raw);
  const mediaCount = dnr?.online_media?.mediaCount ?? dnr?.online_media?.media?.length ?? 0;
  const objectType = indexed?.object_type?.[0];
  const date = indexed?.date?.[0];
  const thumbnailUrl = firstThumbnail(raw);
  return {
    record_id: recordId,
    title: toPlainText(raw.title ?? ''),
    unit_code: unitCode,
    museum_name: museumName(unitCode),
    ...(holdingName !== undefined && { holding_museum_name: holdingName }),
    ...(objectType !== undefined && { object_type: objectType }),
    ...(date !== undefined && { date }),
    ...(thumbnailUrl !== undefined && { thumbnail_url: thumbnailUrl }),
    is_cc0: isObjectCC0(raw),
    has_media: mediaCount > 0,
  };
}

/** Normalize a raw EDAN record into a FullObject. */
function normalizeToFull(raw: RawEDAN): FullObject {
  const dnr = raw.content?.descriptiveNonRepeating;
  const freetext = raw.content?.freetext;
  const indexed = raw.content?.indexedStructured;
  const unitCode = indexedUnitCode(raw);
  const holdingName = holdingMuseumName(raw);
  const recordId = dnr?.record_ID ?? raw.url?.replace(/^edanmdm:/, '') ?? raw.id ?? '';

  const taxonomy: NonNullable<FullObject['taxonomy']> = {};
  for (const rank of ['kingdom', 'phylum', 'class', 'order', 'family'] as const) {
    const values = indexed?.[`tax_${rank}`];
    if (values) taxonomy[rank] = values;
  }
  const coordinates: FullObject['coordinates'] = [];
  for (const location of indexed?.geoLocation ?? []) {
    const point = location.points?.point;
    const lat = point?.latitude;
    const lon = point?.longitude;
    if (lat?.type !== 'decimal' || lon?.type !== 'decimal') continue;
    if (!lat.content?.trim() || !lon.content?.trim()) continue;
    if (
      !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(lat.content.trim()) ||
      !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(lon.content.trim())
    )
      continue;
    const latitude = Number(lat.content);
    const longitude = Number(lon.content);
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    )
      continue;
    const locality = location.Other?.type === 'Locality' ? location.Other.content : undefined;
    coordinates.push({ latitude, longitude, ...(locality && { locality }) });
  }

  // Description — prefer Summary/Physical/Brief notes
  const notePriority = ['Summary', 'Physical Description', 'Brief Description'];
  let description: string | undefined;
  for (const label of notePriority) {
    const match = freetext?.notes?.find((n) => n.label?.includes(label) && n.content);
    if (match?.content) {
      description = match.content;
      break;
    }
  }
  if (!description) {
    for (const label of ['Description', 'Description (Brief)', 'Citation']) {
      const match = freetext?.notes?.find((n) => n.label === label && n.content);
      if (match?.content) {
        description = match.content;
        break;
      }
    }
  }
  const notes = (freetext?.notes ?? []).flatMap((entry) =>
    entry.content
      ? [{ label: toPlainText(entry.label ?? 'Note'), content: toPlainText(entry.content) }]
      : [],
  );

  // Makers
  const makers: Array<{ role: string; name: string }> = [];
  for (const entry of freetext?.name ?? []) {
    if (entry.content) makers.push({ role: entry.label ?? 'Name', name: entry.content });
  }

  // Culture
  const culture = (indexed?.culture ?? []).filter(Boolean);

  // Topics — the indexed facet is usually the trailing segment of the freetext
  // LCSH string and identical values appear in both blocks, so the merge is
  // deduped. Exact-match only: the subdivided form ("Quilts--History") is a
  // distinct string from the bare facet ("Quilts") and both survive.
  const topics = distinct([...(indexed?.topic ?? []), ...collectContent(freetext?.topic)]);

  // Exhibitions
  const exhibitions: Array<{ name: string; building?: string }> = [];
  for (const entry of freetext?.exhibitionHistory ?? []) {
    if (entry.content) {
      exhibitions.push(
        entry.label ? { name: entry.content, building: entry.label } : { name: entry.content },
      );
    }
  }

  const on_view = onView(indexed);

  // Credit — no sampled record carries a second creditLine entry.
  const credit_line = firstContent(freetext?.creditLine);

  // Rights — Smithsonian Institution Archives records file theirs under the singular
  // `objectRight` alone; no sampled record carries both keys, and reading both drops nothing
  // if one ever does.
  const rights = [
    ...collectContent(freetext?.objectRights),
    ...collectContent(freetext?.objectRight),
  ];

  // Media summary — cc0_image_count runs the SAME image pipeline as
  // smithsonian_get_media (extractImageItems → CC0 filter), so the two counts
  // reconcile by construction. `count` is the raw total across all media types
  // (images, 3D models, scanned books, …), which is why it can exceed
  // cc0_image_count; non_image_media lists the items its images mode never delivers.
  const media = dnr?.online_media?.media ?? [];
  const cc0ImageCount = extractImageItems(media).filter((img) => img.is_cc0).length;
  const mediaCount = dnr?.online_media?.mediaCount ?? media.length;

  const thumbnailUrl = firstThumbnail(raw);
  return {
    record_id: recordId,
    title: toPlainText(raw.title ?? ''),
    unit_code: unitCode,
    museum_name: museumName(unitCode),
    ...(holdingName !== undefined && { holding_museum_name: holdingName }),
    dates: labeledEntries(freetext?.date, 'Date'),
    scientific_names: indexed?.scientific_name ?? [],
    ...(Object.keys(taxonomy).length > 0 && { taxonomy }),
    coordinates,
    ...(description !== undefined && { description: toPlainText(description) }),
    notes,
    makers,
    // Every entry under its own label, unsorted: a label can't tell a material from a
    // measurement, a specimen attribute, or a storage location (issue #79).
    physical_description: labeledEntries(freetext?.physicalDescription, 'Physical description'),
    place: labeledEntries(freetext?.place, 'Place'),
    culture,
    topics,
    indexed: indexedFilterValues(indexed),
    exhibitions,
    ...(on_view !== undefined && { on_view }),
    current_exhibitions: currentExhibitions(indexed),
    sets: labeledEntries(freetext?.setName, 'Set'),
    ...(credit_line !== undefined && { credit_line }),
    identifiers: labeledEntries(freetext?.identifier, 'Identifier'),
    ...(rights.length > 0 && { object_rights: rights.join('; ') }),
    is_cc0: isObjectCC0(raw),
    ...(dnr?.record_link !== undefined && { record_link: dnr.record_link }),
    media_summary: {
      count: mediaCount,
      cc0_image_count: cc0ImageCount,
      has_cc0_images: cc0ImageCount > 0,
      ...(thumbnailUrl !== undefined && { thumbnail_url: thumbnailUrl }),
      non_image_media: extractNonImageMedia(media),
    },
  };
}

/** Return true when one media item's own `usage.access` is CC0 — images and non-image items alike. */
function isMediaCC0(m: RawMediaItem): boolean {
  return m.usage?.access === 'CC0';
}

/**
 * The one media type test: an item is non-image when its `type` is set and is not
 * `Images`. smithsonian_get_media's images mode treats everything else — `Images` and
 * untyped items — as an image, so {@link extractImageItems} and {@link extractNonImageMedia}
 * select complementary sets and no item can land in both or neither.
 */
function isNonImageMedia(m: RawMediaItem): m is RawMediaItem & { type: string } {
  return Boolean(m.type) && m.type !== 'Images';
}

/** Build a MediaResolution without undefined optional fields. */
function buildResolution(
  url: string,
  width: number | undefined,
  height: number | undefined,
): MediaResolution {
  return width !== undefined && height !== undefined ? { url, width, height } : { url };
}

/** What a media resource is, from the first rendition its label names. */
function resourceRole(label: string | undefined): 'tiff' | 'jpeg' | 'screen' | 'thumb' | undefined {
  const l = (label ?? '').toLowerCase();
  if (l.includes('tif')) return 'tiff';
  if (l.includes('jpeg') || l.includes('jpg') || l.includes('high-res')) return 'jpeg';
  if (l.includes('screen')) return 'screen';
  return l.includes('thumb') ? 'thumb' : undefined;
}

/**
 * A media item's thumbnail: the last resource labelled one, else the item's `thumbnail`. On
 * IDS items `thumbnail` repeats the full-size `content` URL, and the "Thumbnail Image"
 * resource is the small rendition.
 */
function mediaThumbnail(m: RawMediaItem): string | undefined {
  let thumbnail = m.thumbnail;
  for (const r of m.resources ?? []) {
    if (r.url && resourceRole(r.label) === 'thumb') thumbnail = r.url;
  }
  return thumbnail;
}

/**
 * Normalize a raw media item into an ImageItem. `content` is the IDS delivery URL for
 * the full-size file, so it stands in for a missing Screen Image and, without its
 * dimensions, for a missing high-resolution JPEG (issue #71): the item-level
 * `width`/`height` describe the master, not what `content` serves. Empty accessibility
 * text is left out, as absent text is.
 */
function normalizeToImage(m: RawMediaItem): ImageItem | null {
  const mediaId = m.idsId ?? m.id ?? '';
  if (!mediaId) return null;

  let high_res_jpeg: MediaResolution | undefined;
  let high_res_tiff: MediaResolution | undefined;
  let screen_url: string | undefined;
  const thumbnail_url = mediaThumbnail(m);

  for (const r of m.resources ?? []) {
    if (!r.url) continue;
    switch (resourceRole(r.label)) {
      case 'tiff':
        high_res_tiff = buildResolution(r.url, r.width, r.height);
        break;
      case 'jpeg':
        high_res_jpeg = buildResolution(r.url, r.width, r.height);
        break;
      case 'screen':
        screen_url = r.url;
        break;
    }
  }

  if (m.content) {
    screen_url ??= m.content;
    high_res_jpeg ??= { url: m.content };
  }

  return {
    media_id: mediaId,
    is_cc0: isMediaCC0(m),
    ...(m.altTextAccessibility && { alt_text: m.altTextAccessibility }),
    ...(m.extDescrAccessibility && { description: m.extDescrAccessibility }),
    ...(thumbnail_url !== undefined && { thumbnail_url }),
    ...(screen_url !== undefined && { screen_url }),
    ...(high_res_jpeg !== undefined && { high_res_jpeg }),
    ...(high_res_tiff !== undefined && { high_res_tiff }),
  };
}

/**
 * Select and normalize the image-type items from an online_media `media[]` array.
 * Mirrors smithsonian_get_media's selection (type 'Images' or untyped, with a
 * resolvable media id) so callers that count CC0 images agree with what
 * get_media actually returns. Non-image media goes to {@link extractNonImageMedia}.
 */
function extractImageItems(media: RawMediaItem[]): ImageItem[] {
  return media
    .filter((m) => !isNonImageMedia(m))
    .map(normalizeToImage)
    .filter((m): m is ImageItem => m !== null);
}

/**
 * The media items smithsonian_get_media's images mode leaves out, each with its `content`
 * link (issue #62). That link is the item's entry point — a 3D package's viewer, a
 * scanned book's DOI or BHL page, a field book's viewer or PDF — so a package's
 * per-file `resources[]` stay out; {@link extractModelPackages} carries them.
 */
function extractNonImageMedia(media: RawMediaItem[]): NonImageMedia[] {
  return media.filter(isNonImageMedia).map((m) => ({
    type: m.type,
    ...(m.content && { url: m.content }),
    is_cc0: isMediaCC0(m),
  }));
}

/** The media type of a Voyager 3D package, the catalog's one 3D type. */
const MODEL_PACKAGE_TYPE = '3d_voyager';

function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A 3D file's attribute values, read from every `attributes[]` entry wherever it sits (issue
 * #83): records keep them in one object, split `FILE_SIZE` into an entry of its own, or give
 * each key its own entry. No key repeats with a different value, so the first entry carrying a
 * key settles it. Strings pass through as written; an empty string, a `DRACO_COMPRESSED` that
 * is not a boolean, and a `FILE_SIZE` that is not a whole number of bytes are left out.
 */
function modelFileAttributes(
  attributes: unknown,
): Pick<ModelFile, 'file_type' | 'model_file_type' | 'units' | 'draco_compressed' | 'size_bytes'> {
  let file_type: string | undefined;
  let model_file_type: string | undefined;
  let units: string | undefined;
  let draco_compressed: boolean | undefined;
  let size_bytes: number | undefined;
  for (const entry of Array.isArray(attributes) ? attributes : []) {
    if (!isRecord(entry)) continue;
    if (file_type === undefined && isText(entry.FILE_TYPE)) file_type = entry.FILE_TYPE;
    if (model_file_type === undefined && isText(entry.MODEL_FILE_TYPE)) {
      model_file_type = entry.MODEL_FILE_TYPE;
    }
    if (units === undefined && isText(entry.UNITS)) units = entry.UNITS;
    if (draco_compressed === undefined && typeof entry.DRACO_COMPRESSED === 'boolean') {
      draco_compressed = entry.DRACO_COMPRESSED;
    }
    if (size_bytes === undefined && isByteCount(entry.FILE_SIZE)) size_bytes = entry.FILE_SIZE;
  }
  return {
    ...(file_type !== undefined && { file_type }),
    ...(model_file_type !== undefined && { model_file_type }),
    ...(units !== undefined && { units }),
    ...(draco_compressed !== undefined && { draco_compressed }),
    ...(size_bytes !== undefined && { size_bytes }),
  };
}

/** One file a 3D package lists, or null for a resource with no download URL. */
function normalizeToModelFile(r: RawMediaResource): ModelFile | null {
  if (!isText(r.url)) return null;
  return {
    url: r.url,
    ...(isText(r.filename) && { filename: r.filename }),
    ...(isText(r.category) && { category: r.category }),
    ...modelFileAttributes(r.attributes),
  };
}

/**
 * Normalize a `3d_voyager` item into a ModelPackage, or null when it has no `id`, as an image
 * with no media id is dropped. `content` is the Voyager viewer page; a package whose
 * `resources` key is absent lists no files.
 */
function normalizeToModelPackage(m: RawMediaItem): ModelPackage | null {
  if (!isText(m.id)) return null;
  return {
    media_id: m.id,
    is_cc0: isMediaCC0(m),
    ...(isText(m.content) && { viewer_url: m.content }),
    ...(isText(m.thumbnail) && { thumbnail_url: m.thumbnail }),
    files: (m.resources ?? []).map(normalizeToModelFile).filter((f): f is ModelFile => f !== null),
  };
}

/**
 * The 3D model packages of an online_media `media[]` array, in catalog order: the
 * `3d_voyager` items with an id, CC0 or not, each with its per-file `resources[]` (issue #83).
 * Every one is also a {@link extractNonImageMedia} entry. smithsonian_get_media's 3D mode pages
 * the CC0 ones.
 */
function extractModelPackages(media: RawMediaItem[]): ModelPackage[] {
  return media
    .filter((m) => m.type === MODEL_PACKAGE_TYPE)
    .map(normalizeToModelPackage)
    .filter((p): p is ModelPackage => p !== null);
}

// ---------------------------------------------------------------------------
// Query construction
// ---------------------------------------------------------------------------

/**
 * Build a Lucene `field:value` term as an always-quoted, escaped phrase.
 *
 * Both halves are load-bearing against the exact, pass-through-ready values
 * `smithsonian_list_terms` hands the caller:
 *
 * - **Escaping `\` and `"`.** A term carrying a quote (`Early Iron Age, "Tomb Age"`)
 *   otherwise closes the phrase at the inner quote and matches nothing, and a term
 *   carrying a backslash (`Argentina \ Chile`) is read as an escape sequence.
 * - **Always quoting.** An unquoted single-token value is parsed for Lucene syntax,
 *   so the literal `place` term `*` becomes a wildcard matching every record with
 *   any place — reporting 12.4M hits for a term that has 124.
 *
 * Quoting is inert for ordinary values: `unit_code:"NASM"`, `object_type:"Paintings"`,
 * `date:"1960s"`, and `place:"//Karas"` all return the counts their unquoted forms did.
 */
export function luceneField(field: string, value: string): string {
  return `${field}:"${value.replace(/[\\"]/g, '\\$&')}"`;
}

/**
 * The Lucene term the live API matches a facet filter with: an exact value as a
 * {@link luceneField} phrase, `online_only` as any indexed `online_media_type`,
 * `cc0` as `media_usage:CC0` (records carrying CC0 media), and `on_view` as
 * `onPhysicalExhibit:"Yes"`, which matches exactly the records flagged Yes. Upstream has no
 * exact off-view term: `onPhysicalExhibit:"No"` returns records flagged Yes.
 */
export function luceneFilter(filter: FacetFilter): string {
  switch (filter.field) {
    case 'online_only':
      return 'online_media_type:*';
    case 'cc0':
      return 'media_usage:CC0';
    case 'on_view':
      return 'onPhysicalExhibit:"Yes"';
    default:
      return luceneField(filter.field, filter.value);
  }
}

/**
 * Upper bound on vocabulary scans one neighbor search may run. Every scan walks
 * the whole cached array — 133,113 terms for `topic` — so the search is bounded
 * explicitly rather than by the shape of whatever value failed. Ordinary terms
 * stay under it: ten words or fewer covers 99.9% of the `topic` vocabulary and
 * runs a median of 6 scans. The cap exists for the tail, where a 101-word term
 * would otherwise run ~150 scans on an error path.
 */
const MAX_NEIGHBOR_PROBES = 48;

/**
 * Upper bound on how many other terms a named `contains` may list. Past it the
 * search reports no neighbors, and the caller takes the branch that offers no term
 * route at all — a substring that returns a large fraction of the field is not a
 * route, it is browsing the field with extra steps. `Mzab` has no cut that lists
 * anything, so the search bottoms out at `M`, which names 2,936 other terms out of
 * an 8,683-term culture vocabulary (issue #48).
 *
 * The bound is a fixed count rather than a fraction of the vocabulary, which the
 * live distributions decide. A fraction cannot bound the large vocabularies: the
 * tightest cut of the place term `Gièvres` is `Gi`, which lists 5,512 other place
 * terms and is still only 4.8% of the field — under any fraction loose enough to
 * admit `Mzab`'s 33.8%. It also collapses on the small ones, where 2% of the
 * 201-term `date` vocabulary is 4 terms, while a tenth of `date` values — which
 * smithsonian_search_objects routes through this same branch — name 13 or more. A
 * fixed count holds across both, and isolates the same tail in vocabularies that
 * differ 15-fold in size: at 800 the clause is dropped for 0.36% of `culture`,
 * 0.38% of `place` and 0.65% of `topic`, and for nothing in `date` or `unit_code`.
 *
 * 800 terms come back from one smithsonian_list_terms call (rows: 800), and the
 * count sits between the two live cases that fix the range. `place: "Nigeria"`
 * lists 575 Nigerian place terms — wide, but every one of them is the thing the
 * caller asked about, so a ceiling that cuts it is the wrong ceiling.
 * `culture: "Rickarie"` bottoms out at `Ric`, whose 1,195 terms are mostly the
 * `ric` inside `African`, and which opens on `!Kung (African people)`.
 */
const MAX_NEIGHBOR_TERMS = 800;

/**
 * Word boundaries are whitespace; a candidate substring starts and ends on a
 * letter or digit, so surrounding punctuation is never carried into one.
 */
const ALPHANUMERIC = /[\p{L}\p{N}]/u;
const WHITESPACE = /\s/;

/**
 * Offsets where a whitespace-delimited word begins, each advanced past that word's
 * leading punctuation. The advance is what reaches `Yank` inside `"Yank"` — a
 * handful of `topic` terms carry quotes and nothing else in the vocabulary does,
 * so a candidate that keeps them can only ever match the value it came from.
 */
function wordStarts(value: string): number[] {
  const starts: number[] = [];
  let atBoundary = true;
  for (let index = 0; index < value.length; index++) {
    const char = value[index] as string;
    if (WHITESPACE.test(char)) {
      atBoundary = true;
    } else if (atBoundary && ALPHANUMERIC.test(char)) {
      starts.push(index);
      atBoundary = false;
    }
  }
  return starts;
}

/**
 * Ascending exclusive end offsets for candidates anchored at `start`, restricted
 * to those longer than `minLength` and ending either on an alphanumeric or at a
 * word boundary — the end of the value, or the offset before whitespace.
 *
 * Ending mid-word is deliberate and load-bearing: `Bell UH-1` cuts inside `UH-1H`
 * and `Guian` inside `Guiana`, and neither is reachable from word boundaries
 * alone. The word-boundary clause keeps the punctuation a word OWNS attached to
 * it. Alphanumeric alone cannot end a candidate on the trailing period of
 * `New York. (N.Y.)`, the `(?)` of `Woodland (?)`, or the combining macron of a
 * decomposed `Osiā`, and the widest cut it can reach instead is the overshoot
 * this search exists to remove — `New York` lists 907 other place terms where the
 * value's own trailing period lists 1. What the clause still excludes is a cut
 * that strands an opener mid-word: `Yombe (` is never a candidate, because that
 * `(` is followed by a letter rather than whitespace or the end of the value.
 *
 * The rule is also what keeps a candidate off a surrogate boundary: an end after
 * a lone high surrogate qualifies only if the next code unit is whitespace or
 * absent, neither of which is the low half of a pair.
 */
function candidateEnds(value: string, start: number, minLength: number): number[] {
  const ends: number[] = [];
  for (let end = start + minLength + 1; end <= value.length; end++) {
    if (
      end === value.length ||
      WHITESPACE.test(value[end] as string) ||
      ALPHANUMERIC.test(value[end - 1] as string)
    ) {
      ends.push(end);
    }
  }
  return ends;
}

/**
 * The tightest `contains` substring of `value` that still lists a term other than
 * `value`, or undefined when no candidate does — or when the tightest that does is
 * looser than {@link MAX_NEIGHBOR_TERMS} allows.
 *
 * Tightest means longest. For a fixed start, a longer substring matches a subset
 * of what a shorter one matches, so length is the axis that narrows the result
 * set: `Bell UH-1` lists 2 other `topic` terms, both of them the sibling
 * helicopters the caller wanted, where `Bell` lists 234 — 82 of which match
 * mid-word only (`Cerebellum`, `Abronia umbellata`). Candidates begin at every
 * word boundary and may end mid-word, which is what covers both shapes these
 * vocabularies need: a cut inside a word, and an internal window (`of North
 * American` inside `Check-list of North American Birds (Monograph)`) that no
 * leading-prefix walk reaches.
 *
 * Two properties keep the cost bounded. Within one start, "lists another term" is
 * monotone in length — true for a substring implies true for each of its prefixes
 * — so the longest working end is found by binary search over the end offsets, in
 * log-many scans rather than one per character. Across starts, only candidates
 * longer than the incumbent are generated, so a start whose shortest remaining
 * candidate fails costs a single scan. {@link MAX_NEIGHBOR_PROBES} caps the total.
 *
 * A longer candidate replaces the incumbent only when it is no looser. Length
 * alone would trade `Yombe` (6 other `culture` terms) for `African people` (908):
 * both work, but the longer one is a shared qualifier rather than a narrowing cut,
 * and handing back 908 terms repeats the overshoot the search exists to remove.
 */
function tightestNeighbors(
  value: string,
  vocabulary: string[],
): { contains: string; count: number } | undefined {
  /**
   * Every scan asks the same question of the same array, so the value is dropped
   * and the case folded once here rather than per candidate — the fold alone costs
   * more than two scans on `topic`.
   */
  const others = vocabulary.filter((term) => term !== value).map((term) => term.toLowerCase());

  let probes = 0;
  const lists = (needle: string): boolean => {
    probes++;
    const search = needle.toLowerCase();
    return others.some((term) => term.includes(search));
  };
  const countOf = (needle: string): number => {
    probes++;
    const search = needle.toLowerCase();
    return others.filter((term) => term.includes(search)).length;
  };

  let best: { contains: string; count: number } | undefined;
  for (const start of wordStarts(value)) {
    if (probes >= MAX_NEIGHBOR_PROBES) break;
    const ends = candidateEnds(value, start, best?.contains.length ?? 0);
    if (ends.length === 0 || !lists(value.slice(start, ends[0] as number))) continue;

    let low = 0;
    let high = ends.length - 1;
    while (low < high && probes < MAX_NEIGHBOR_PROBES) {
      const mid = Math.ceil((low + high) / 2);
      if (lists(value.slice(start, ends[mid] as number))) low = mid;
      else high = mid - 1;
    }

    const contains = value.slice(start, ends[low] as number);
    const count = countOf(contains);
    if (!best || count <= best.count) best = { contains, count };
  }

  // `best` holds the lowest count of every candidate the search evaluated, so one
  // over the ceiling means all of them were — there is no narrower substring left
  // to fall back to, and the caller gets no term route at all.
  return best && best.count <= MAX_NEIGHBOR_TERMS ? best : undefined;
}

// ---------------------------------------------------------------------------
// SmithsonianService
// ---------------------------------------------------------------------------

/** Per-request options for {@link SmithsonianService.get}, whose answer is a `T` that holds a `U`. */
interface GetOptions<T, U extends T> {
  /**
   * Marks a path whose resource is a collection that exists for as long as the
   * service does — `/search` and `/terms/{field}`. A 404 on one of those is
   * never a statement about the requested resource: the api.data.gov edge
   * fronting EDAN answers every path with the Cloud Foundry router's
   * `unknown_route` 404 once a route mapping is dropped, so the request never
   * reached the application and no change to the caller's input can succeed.
   *
   * Set here, that 404 is rewrapped as `ServiceUnavailable` INSIDE the retry
   * closure, which is what makes the fix a fix (issue #51): the caller gets an
   * upstream-outage code instead of a caller-fault `NotFound`, and the call
   * lands back in `withRetry`'s transient set so it retries with backoff.
   * Rewrapping after `search()` / `vocabulary()` return would correct the code
   * and silently drop the retry.
   *
   * `/content/{id}` omits it — a 404 there is a genuine missing record.
   */
  collectionEndpoint?: boolean;
  /**
   * Epoch milliseconds by which the read must finish: the calling tool's
   * {@link CallDeadline}, or a shared cache load's own ceiling. Every attempt,
   * backoff, and body read runs inside it, and a read that starts past it sends
   * nothing.
   */
  deadline: number;
  /**
   * Non-2xx statuses that are an expected outcome for this call, logged at
   * `debug` instead of `error` (the status-mapped throw is unchanged). Only
   * getContent passes this — a missing object is a real 404 from EDAN, and a
   * bad object ID is a routine client mistake, not a server-side fault worth
   * an error-level line in the digest. search/listTerms omit it: a 404 there
   * is an outage, handled by {@link GetOptions.collectionEndpoint}.
   */
  expectedStatuses?: number[];
  /** Request headers merged over `Accept` — every call site passes the API key here. */
  headers?: Record<string, string>;
  /**
   * The payload a 200 must carry to be an answer. EDAN never answers a working read
   * with a 200 that lacks it — a missing record is an HTTP 404 and an unknown terms
   * field an HTTP 400 — so a reply without it is an upstream fault, and read as an
   * empty page, an empty vocabulary, or a blank record it would be cached for its TTL
   * and served to every caller (issue #72).
   *
   * Checked INSIDE the retry closure, after the error-in-200 branch (so an error body
   * keeps its own classification), and only on a 200 (so a 403 key rejection never
   * reaches it). A reply that fails it throws a retryable `ServiceUnavailable`
   * (`reason: 'upstream_unavailable'`): a one-off is retried within the read's
   * deadline, and no cache ever receives it.
   */
  payload: {
    /** What the reply must carry, as the error names it. */
    description: string;
    holds: (raw: T) => raw is U;
  };
  /**
   * The signal the request runs on, when it is not the caller's own. A cached
   * read passes the response cache's signal, so one caller cancelling never
   * cancels a request another caller is waiting on (issue #65).
   */
  signal?: AbortSignal | undefined;
}

/**
 * Byte budget of the response cache, counted as the UTF-8 length of each stored
 * entry's JSON. Measured against live responses: a normalized 1,000-row search
 * page is 238–320 KB, a 20-row page 3.4–7.7 KB, and a `/content` record a median
 * 4.1 KB (p99 25 KB, max 106 KB), so 64 MiB holds more than an hour of the key's
 * 1,000 requests at typical sizes.
 */
const RESPONSE_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * One deadline across every read a tool call makes — each attempt, backoff, and body
 * read of each request, and every request the call chains (anchor, fan-out, deeper
 * chunks; search, vocabulary lookup, harvest). MCP SDK clients give up on a request
 * after 60 s by default; four 15 s attempts with 2/4/8 s backoff would run 74 s for
 * one read alone, and a deadline per read multiplies by the reads chained. One 50 s
 * deadline leaves the work after the last read about 10 s inside the client's limit,
 * so a hung upstream fails here first (issue #68).
 *
 * It also caps a shared load — a response-cache read or a cold vocabulary read — which
 * runs on its own deadline rather than the starting caller's.
 */
export const CALL_DEADLINE_MS = 50_000;

/**
 * The instant, in epoch milliseconds, by which every read of one tool call must finish.
 * Each tool handler creates one with {@link startCallDeadline} at entry and passes it to
 * every read it makes, so each read gets the time the call has left.
 */
export type CallDeadline = number & { readonly __brand: 'CallDeadline' };

/** A tool call's deadline, {@link CALL_DEADLINE_MS} from now. */
export function startCallDeadline(): CallDeadline {
  return (Date.now() + CALL_DEADLINE_MS) as CallDeadline;
}

/**
 * The next step for a call the api.data.gov edge refused for the server's key. Every call fails
 * the same way until the key is replaced, and only the operator can replace it.
 */
const API_KEY_RECOVERY =
  "The server's SMITHSONIAN_API_KEY was refused, so every call fails until it is replaced and retrying will not help. The operator sets it to a valid key from https://api.data.gov/signup and restarts the server.";

/**
 * The `errors[]` entry for a refused key, which `get()` raises on any tool's read. Every tool
 * declares it: `Forbidden` is not a baseline code, so an undeclared reason would reach callers
 * that no contract advertises.
 */
export const API_KEY_REJECTED_ERROR = {
  reason: 'api_key_rejected',
  code: JsonRpcErrorCode.Forbidden,
  when: "The Smithsonian API refused this server's SMITHSONIAN_API_KEY (an api.data.gov API_KEY_* error).",
  recovery: API_KEY_RECOVERY,
  thrownBy: 'service',
} as const;

/**
 * The `API_KEY_*` code (`API_KEY_INVALID`, `API_KEY_MISSING`, …) an api.data.gov HTTP 403 names
 * in its JSON body, `{ "error": { "code" } }`; undefined for any other failure. The body is read
 * from the copy `fetchWithTimeout` keeps on the server: no client envelope carries it, so this
 * code is all of it the caller sees.
 */
function rejectedKeyCode(err: McpError): string | undefined {
  if (err.data?.status !== 403) return undefined;
  const body = err.data.body;
  if (typeof body !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // A 403 that is not JSON (a proxy's page) is not the edge's key rejection.
    return undefined;
  }
  const code = isRecord(parsed) && isRecord(parsed.error) ? parsed.error.code : undefined;
  return typeof code === 'string' && /^API_KEY_[A-Z_]+$/.test(code) ? code : undefined;
}

/**
 * The caller's cancellation signal. `RequestContext` does not declare it; the
 * handler `Context` every call arrives as does.
 */
function callerSignal(ctx: RequestContext): AbortSignal | undefined {
  return (ctx as { signal?: AbortSignal }).signal;
}

/** One page of search results, with where it was answered (undefined without a mirror). */
export interface SearchPage {
  provenance?: Provenance;
  rowCount: number;
  rows: ObjectSummary[];
}

/** One object record, with where it was answered (undefined without a mirror). */
export interface ContentRead {
  provenance?: Provenance;
  record: RawEDAN;
}

export class SmithsonianService {
  /**
   * `/search` pages and `/content` records, keyed by request URL. Instance state,
   * so every service starts empty. Not `storage`: its default in-memory provider
   * has an entry cap and no byte bound, throws on `set` once full, and rejects
   * URL characters in keys.
   */
  private readonly responses = new ResponseCache(RESPONSE_CACHE_BYTES, CALL_DEADLINE_MS);

  /**
   * Cold `/terms/{field}` reads in progress, keyed by tenant and field. The vocabulary itself
   * lives in `storage`, so the loads keep nothing once they settle.
   */
  private readonly vocabularyLoads = new SharedLoads(CALL_DEADLINE_MS);

  /**
   * @param mirror The Open Access bulk mirror, when one is configured. Object reads and
   *   filter-only searches try it before the live API; every read then reports its provenance.
   */
  constructor(
    private readonly storage: StorageService,
    private readonly mirror?: OaMirror,
  ) {}

  /** The provenance of a live answer: none without a mirror, so those responses stay unchanged. */
  private live(): Provenance | undefined {
    return this.mirror ? { source: 'edan_api' } : undefined;
  }

  /**
   * Answer a read from the mirror, or undefined to send it live: no mirror is configured, none
   * of its syncs has completed, `read` declines (a record it does not hold, a search past the
   * scan budget), or the store fails. A store failure is logged here and never reaches the
   * caller, who gets the live answer instead.
   */
  private async fromMirror<T>(
    read: (mirror: OaMirror) => Promise<T | undefined>,
    ctx: RequestContext,
  ): Promise<{ provenance: Provenance; value: T } | undefined> {
    const mirror = this.mirror;
    if (!mirror) return undefined;
    try {
      if (!(await mirror.ready())) return undefined;
      const value = await read(mirror);
      if (value === undefined) return undefined;
      const snapshot = await mirror.snapshot();
      return { value, provenance: { source: 'oa_mirror', ...(snapshot && { snapshot }) } };
    } catch (err: unknown) {
      logger.error(
        'Open Access mirror read failed; answering from the live API.',
        err instanceof Error ? err : new Error(String(err)),
        ctx,
      );
      return undefined;
    }
  }

  /**
   * Execute a GET request with retry/backoff. Names a key the edge refuses (HTTP 403,
   * `reason: 'api_key_rejected'`), handles error-in-200 responses, and refuses a 200
   * without the read's {@link GetOptions.payload}. Every attempt and backoff runs on
   * the request's signal, so cancelling it ends a backoff at once, and inside the time
   * left before {@link GetOptions.deadline}, so expiry mid-attempt, mid-backoff, or
   * mid-body surfaces as `withRetry`'s `Timeout` (`reason: 'retry_deadline_exceeded'`).
   * The deadline stays out of `withRetry`'s `signal`, whose aborts pass through raw as
   * caller cancellations.
   *
   * @throws McpError `Timeout` (`reason: 'retry_deadline_exceeded'`), sending nothing,
   *   when the deadline has already passed.
   */
  private async get<T extends { error?: { code?: string; message?: string } }, U extends T>(
    url: string,
    ctx: RequestContext,
    options: GetOptions<T, U>,
  ): Promise<U> {
    const remainingMs = options.deadline - Date.now();
    if (remainingMs <= 0) {
      throw timeout(
        `The request was not sent: the tool call's ${CALL_DEADLINE_MS / 1000} s deadline had already passed.`,
        { reason: 'retry_deadline_exceeded' },
      );
    }
    const signal = options.signal ?? callerSignal(ctx);
    return await withRetry(
      async (attempt) => {
        let response: Response;
        try {
          response = await fetchWithTimeout(url, 15_000, ctx, {
            headers: { Accept: 'application/json', ...options.headers },
            signal: attempt.signal,
            ...(options.expectedStatuses && { expectedStatuses: options.expectedStatuses }),
          });
        } catch (err: unknown) {
          if (!(err instanceof McpError)) throw err;
          if (options.collectionEndpoint && err.code === JsonRpcErrorCode.NotFound) {
            throw serviceUnavailable(
              'The Smithsonian API is not routing requests — a collection endpoint that exists whenever the service is up returned HTTP 404. This is an upstream outage, not a missing record.',
              { ...err.data, reason: 'upstream_unavailable' },
              { cause: err },
            );
          }
          const keyCode = rejectedKeyCode(err);
          if (keyCode !== undefined) {
            throw forbidden(
              `The Smithsonian API refused this server's API key (${keyCode}).`,
              {
                ...err.data,
                reason: 'api_key_rejected',
                errorCode: keyCode,
                recovery: { hint: API_KEY_RECOVERY },
              },
              { cause: err },
            );
          }
          throw err;
        }
        const raw = (await response.json()) as T;

        // An error body on an HTTP 200. The edge itself answers a refused key with 403
        // (above) and a rate limit with 429 (status-mapped to RateLimited).
        if (raw.error) {
          const code = raw.error.code ?? '';
          if (code === 'API_KEY_MISSING') {
            // ConfigurationError — non-retryable, surfaces as a startup failure.
            throw new McpError(
              JsonRpcErrorCode.InternalError,
              `Smithsonian API key missing or invalid. Ensure SMITHSONIAN_API_KEY is set. API message: ${raw.error.message ?? code}`,
              { errorCode: code },
            );
          }
          if (code === 'OVER_RATE_LIMIT') {
            // Map to 429-like — withRetry will retry with backoff.
            throw serviceUnavailable(
              `Smithsonian API rate limit exceeded: ${raw.error.message ?? code}`,
              { errorCode: code },
            );
          }
          throw serviceUnavailable(`Smithsonian API error: ${raw.error.message ?? code}`, {
            errorCode: code,
          });
        }

        if (!options.payload.holds(raw)) {
          throw serviceUnavailable(
            `The Smithsonian API answered HTTP 200 without ${options.payload.description}. This is an upstream fault, not an empty result.`,
            { reason: 'upstream_unavailable' },
          );
        }
        return raw;
      },
      {
        operation: 'SmithsonianService.get',
        context: ctx,
        baseDelayMs: 2000,
        maxRetries: 3,
        deadlineMs: remainingMs,
        ...(signal && { signal }),
      },
    );
  }

  /**
   * Search across Smithsonian objects. Returns normalized summaries and the total row count.
   *
   * A search with no query (`''` or `*`) is answered by facet filters alone, so the mirror
   * serves it when it can do so within its scan budget: rows then come in mirror order, and
   * the total is the facet count. Free text, an over-budget search, an `on_view` search while
   * a mirror shard awaits its post-upgrade re-read, and every search on a server without a
   * ready mirror go to the live API, from the response cache when the same
   * request URL succeeded within the search TTL.
   *
   * On the live path each filter becomes a {@link luceneFilter} term ANDed into `q` (EDAN has
   * no `fq` parameter), so each is a hard constraint rather than a scoring-only hint. The
   * live read, cached or not, ends by `deadline`.
   */
  async search(
    params: {
      query: string;
      rows: number;
      start: number;
      /** Exact facet constraints, all of which a result matches. */
      filters?: readonly FacetFilter[];
    },
    ctx: RequestContext,
    deadline: CallDeadline,
  ): Promise<SearchPage> {
    const activeFilters = params.filters ?? [];
    if (params.query === '' || params.query === '*') {
      const mirrored = await this.fromMirror(async (mirror) => {
        const result = await mirror.searchFacets(activeFilters, params.start, params.rows);
        return result.kind === 'page' ? result : undefined;
      }, ctx);
      if (mirrored) {
        return {
          rows: mirrored.value.docs.map(normalizeToSummary),
          rowCount: mirrored.value.total,
          provenance: mirrored.provenance,
        };
      }
    }

    const cfg = getServerConfig();
    const base = `${cfg.baseUrl}/search`;

    // Embed field constraints into q as ANDed Lucene terms so each filter is a
    // hard constraint (EDAN has no fq param). Group active syntax to preserve
    // Boolean precedence, but keep implicit terms ungrouped: EDAN changes their
    // matching semantics inside parentheses. Phrases and escapes stay literal.
    let q = params.query;
    if (activeFilters.length > 0) {
      const baseQ = q && q !== '*' ? (hasActiveLuceneSyntax(q) ? `(${q})` : q) : '';
      const terms = activeFilters.map(luceneFilter).join(' AND ');
      q = baseQ ? `${baseQ} AND ${terms}` : terms;
    }

    const qs = new URLSearchParams({
      q,
      rows: String(params.rows),
      start: String(params.start),
    });
    const url = `${base}?${qs.toString()}`;

    // Pass API key as header (not query param) so it never appears in logs, errors,
    // or the cache key.
    const ttlMs = cfg.searchCacheTtlSeconds * 1000;
    const caller = { signal: callerSignal(ctx), deadline };
    const page = await this.responses.fetch(url, ttlMs, caller, async (signal, readDeadline) => {
      const raw = await this.get(url, ctx, {
        headers: { 'X-Api-Key': cfg.apiKey },
        collectionEndpoint: true,
        payload: {
          description: 'a page of results (a response.rows array and a numeric response.rowCount)',
          holds: (
            r: RawSearchResponse,
          ): r is RawSearchResponse & { response: { rows: RawEDAN[]; rowCount: number } } =>
            Array.isArray(r.response?.rows) && typeof r.response?.rowCount === 'number',
        },
        signal,
        deadline: readDeadline,
      });
      return { rows: raw.response.rows.map(normalizeToSummary), rowCount: raw.response.rowCount };
    });
    const provenance = this.live();
    return provenance ? { ...page, provenance } : page;
  }

  /**
   * Fetch a single object by record_id. Once the mirror is ready it answers any record it
   * holds; a record it lacks, or a store failure, goes to the live API — from the response
   * cache when the same request URL succeeded within the content TTL, so the bare and
   * `edanmdm:` forms of an ID share an entry.
   * The content endpoint returns the object directly at `response` (not `response.rows[0]`).
   *
   * EDAN answers a missing object with HTTP 404, which leaves here with `reason: 'not_found'`
   * and no recovery: every caller (`smithsonian_get_object`, `smithsonian_get_media`,
   * `smithsonian_find_related`) declares a `not_found` entry, and the framework fills that
   * tool's own hint on the wire. The throw sits outside the cached read, so each caller
   * sharing a request is named by the ID it passed. A 200 without a record is an upstream
   * fault, not a missing object (issue #72): it fails `ServiceUnavailable` inside the read.
   * The live read, cached or not, ends by `deadline`.
   */
  async getContent(
    recordId: string,
    ctx: RequestContext,
    deadline: CallDeadline,
  ): Promise<ContentRead> {
    const prefixed = recordId.startsWith('edanmdm:') ? recordId : `edanmdm:${recordId}`;
    const mirrored = await this.fromMirror((mirror) => mirror.getDoc(prefixed), ctx);
    if (mirrored) return { record: mirrored.value, provenance: mirrored.provenance };

    const cfg = getServerConfig();
    const url = `${cfg.baseUrl}/content/${encodeURIComponent(prefixed)}`;

    // Pass API key as header (not query param) so it never appears in logs, errors,
    // or the cache key.
    const ttlMs = cfg.contentCacheTtlSeconds * 1000;
    const caller = { signal: callerSignal(ctx), deadline };
    let record: RawEDAN;
    try {
      record = await this.responses.fetch(url, ttlMs, caller, async (signal, readDeadline) => {
        // EDAN returns a real HTTP 404 for a missing object; expect it so a bad ID
        // logs at debug, not as a server error. The NotFound throw still fires and
        // is rewrapped below with the declared reason.
        const raw = await this.get(url, ctx, {
          headers: { 'X-Api-Key': cfg.apiKey },
          expectedStatuses: [404],
          payload: {
            description: 'an object record (a response carrying a string url)',
            holds: (
              r: RawContentResponse,
            ): r is RawContentResponse & { response: RawEDAN & { url: string } } =>
              typeof r.response?.url === 'string',
          },
          signal,
          deadline: readDeadline,
        });
        return raw.response;
      });
    } catch (err: unknown) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw notFound(`No Smithsonian object found for ID "${recordId}".`, {
          recordId,
          reason: 'not_found',
        });
      }
      throw err;
    }

    const provenance = this.live();
    return provenance ? { record, provenance } : { record };
  }

  /** Normalize a raw EDAN record to a full object. */
  toFullObject(raw: RawEDAN): FullObject {
    return normalizeToFull(raw);
  }

  /** Extract and normalize image items from a raw EDAN record. */
  toImageItems(raw: RawEDAN): ImageItem[] {
    return extractImageItems(raw.content?.descriptiveNonRepeating?.online_media?.media ?? []);
  }

  /** Extract and normalize the `3d_voyager` model packages, CC0 or not, from a raw EDAN record. */
  toModelPackages(raw: RawEDAN): ModelPackage[] {
    return extractModelPackages(raw.content?.descriptiveNonRepeating?.online_media?.media ?? []);
  }

  /** Check whether an object is CC0. */
  isCC0(raw: RawEDAN): boolean {
    return isObjectCC0(raw);
  }

  /** Normalize raw EDAN to ObjectSummary (exposed for tools that already have raw). */
  toSummary(raw: RawEDAN): ObjectSummary {
    return normalizeToSummary(raw);
  }

  /**
   * The full term vocabulary for an indexed field, read from the injected
   * `StorageService` when warm and fetched from `/terms/{field}` on a miss.
   *
   * The upstream endpoint returns `response.terms` as a bare `string[]` (no
   * per-term counts) and ignores `rows`/`start`, always returning the full
   * vocabulary — `topic` alone is ~133k terms (~3.6 MB, seconds of latency
   * against a 15 s fetch budget), with `place` close behind at ~115k. Caching it
   * turns every page of a walk, and
   * every vocabulary check on a recovery path, into an in-memory scan; the data
   * is a controlled vocabulary with no freshness requirement on the scale of a
   * session, so a TTL of hours is safe and a cold miss costs what an uncached
   * call costs today. `SMITHSONIAN_TERMS_CACHE_TTL_SECONDS=0` disables the cache and the
   * sharing of concurrent cold reads.
   *
   * The framework's storage key validator only accepts `^[a-zA-Z0-9_.\-/]+$`, so
   * the key separator is `/` — a `terms:${field}` key throws at runtime.
   *
   * Only an array is stored: a 200 without `response.terms` fails inside `get()`
   * (issue #72), where it would otherwise be stored as an empty vocabulary that
   * every caller of the instance reads as "no such term" for the whole TTL. An empty
   * array is a real answer and is stored like any other.
   *
   * Concurrent cold readers of one field in one tenant share one `/terms` request
   * (issue #77) through {@link SmithsonianService.vocabularyLoads}, the way the response
   * cache shares a search or content load: on its own signal and its own
   * {@link CALL_DEADLINE_MS} ceiling, each caller waiting on its own signal and the time its
   * call has left, the request aborted once every caller has left. The load writes storage
   * before any caller resumes, and a failed load stores nothing. A TTL of 0 turns the sharing
   * off with the cache: each read then runs on its caller's own signal and deadline.
   *
   * A warm vocabulary answers whatever time the call has left; a cold one is read by
   * `deadline`, and past it is not read at all.
   */
  private async vocabulary(
    field: string,
    ctx: RequestContext,
    deadline: CallDeadline,
  ): Promise<string[]> {
    const cfg = getServerConfig();
    const ttl = cfg.termsCacheTtlSeconds;
    const url = `${cfg.baseUrl}/terms/${encodeURIComponent(field)}`;
    const read = async (signal: AbortSignal | undefined, readDeadline: number) => {
      const raw = await this.get(url, ctx, {
        headers: { 'X-Api-Key': cfg.apiKey },
        collectionEndpoint: true,
        payload: {
          description: 'a term vocabulary (a response.terms array)',
          holds: (r: RawTermsResponse): r is RawTermsResponse & { response: { terms: string[] } } =>
            Array.isArray(r.response?.terms),
        },
        signal,
        deadline: readDeadline,
      });
      return raw.response.terms;
    };
    if (ttl === 0) return await read(callerSignal(ctx), deadline);

    const key = `terms/${field}`;
    // Keyed as storage is, per tenant, so one load writes the one entry its callers read.
    const loadKey = `${ctx.tenantId}/${key}`;
    // A load in progress means storage was cold when it started. Joining it skips a read that
    // a slow store could answer with the miss from before the load's write.
    if (!this.vocabularyLoads.has(loadKey)) {
      const cached = await this.storage.get<string[]>(key, ctx);
      if (cached) return cached;
    }
    const caller = { signal: callerSignal(ctx), deadline };
    return await this.vocabularyLoads.run(loadKey, caller, async (signal, loadDeadline) => {
      const terms = await read(signal, loadDeadline);
      await this.storage.set(key, terms, ctx, { ttl });
      return terms;
    });
  }

  /**
   * Enumerate the valid term vocabulary for an indexed field, optionally narrowed
   * by a case-insensitive substring.
   *
   * Pagination is client-side: the upstream vocabulary arrives whole, so the page
   * is a slice of it. Only the requested page is returned, so a full vocabulary
   * never reaches the tool output.
   *
   * `contains` filters that vocabulary in memory, before pagination, so both
   * `total` and the page reflect the match set and an empty result confirms no
   * such term exists. For `unit_code` the substring also matches each code's
   * museum name and its {@link MUSEUM_ALIASES}, so a caller who knows only the name
   * ("National Air and Space", "Freer", "Smithsonian National Museum of Natural
   * History") resolves it to its codes in one call. Name matching ignores a leading
   * "Smithsonian", `&` versus `and`, apostrophe style, and hyphens versus spaces
   * ({@link nameNeedle}); the code itself still matches the raw case-insensitive
   * substring, so `OFEO-SG` finds `OFEO-SG`. `labels` returns the label alone for every
   * code on the page that has one, and codes outside {@link MUSEUM_NAMES} come back
   * bare, as they do on every other tool.
   */
  async listTerms(
    params: { field: string; start: number; rows: number; contains?: string },
    ctx: RequestContext,
    deadline: CallDeadline,
  ): Promise<{ terms: string[]; total: number; labels?: Record<string, string> }> {
    const all = await this.vocabulary(params.field, ctx, deadline);
    const labelled = params.field === 'unit_code';

    const needle = params.contains?.toLowerCase();
    const names = labelled && params.contains ? nameNeedle(params.contains) : undefined;
    const matched = needle
      ? all.filter(
          (term) =>
            term.toLowerCase().includes(needle) ||
            (names !== undefined && matchesMuseumName(term, names, needle)),
        )
      : all;
    const page = matched.slice(params.start, params.start + params.rows);
    if (!labelled) return { terms: page, total: matched.length };

    const labels: Record<string, string> = {};
    for (const term of page) {
      const name = unitName(term);
      if (name) labels[term] = name;
    }
    return { terms: page, total: matched.length, labels };
  }

  /**
   * Place `value` in the field's term vocabulary, and — when it is a member —
   * find a `contains` substring that lists other terms.
   *
   * Membership is exact and case-sensitive, matching how EDAN itself resolves a
   * term: `NMAfA` is real and `NMAFA` matches nothing. The `contains` filter on
   * {@link listTerms} cannot stand in — it is a case-insensitive substring match,
   * so it reports a hit for a wrong-case value and for a fragment that is not
   * itself a term.
   *
   * Membership separates the two zero-match failures the recovery hints otherwise
   * conflate: a value outside the vocabulary (resolvable through
   * smithsonian_list_terms) from one the index enumerates but that matches no
   * retrievable object, where resolving it again returns the caller to the same
   * failing call.
   *
   * `neighbors` then decides whether the indexed branch can offer a substitute
   * term at all. {@link tightestNeighbors} searches the vocabulary already in hand
   * for the tightest substring that resolves to a term OTHER than the value, so a
   * hint naming it is naming a call with something to show, and a narrow one
   * (issue #47) — narrow being a bounded claim, since a substring listing more
   * than {@link MAX_NEIGHBOR_TERMS} of the field is discarded as no better than
   * browsing it (issue #48). When nothing survives that, the caller has no term
   * route to offer and says so instead of sending the caller back into the same
   * value (issue #46).
   */
  async describeTerm(
    field: string,
    value: string,
    ctx: RequestContext,
    deadline: CallDeadline,
  ): Promise<TermDescription> {
    const vocabulary = await this.vocabulary(field, ctx, deadline);
    if (!vocabulary.includes(value)) return { indexed: false };

    const neighbors = tightestNeighbors(value, vocabulary);
    return neighbors ? { indexed: true, neighbors } : { indexed: true };
  }
}

// ---------------------------------------------------------------------------
// Init/accessor pattern
// ---------------------------------------------------------------------------

let _service: SmithsonianService | undefined;

/**
 * Create the service the accessor returns, its response cache empty, reading through `mirror`
 * when the server has one.
 */
export function initSmithsonianService(
  _config: AppConfig,
  storage: StorageService,
  mirror?: OaMirror,
): void {
  _service = new SmithsonianService(storage, mirror);
}

export function getSmithsonianService(): SmithsonianService {
  if (!_service) {
    throw new Error(
      'SmithsonianService not initialized — call initSmithsonianService() in setup()',
    );
  }
  return _service;
}
