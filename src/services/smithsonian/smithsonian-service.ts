/**
 * @fileoverview Smithsonian EDAN Open Access API service — search and content retrieval.
 * @module services/smithsonian/smithsonian-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { RequestContextLike } from '@cyanheads/mcp-ts-core/utils';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  FullObject,
  ImageItem,
  MediaResolution,
  ObjectSummary,
  RawContentResponse,
  RawEDAN,
  RawFreetextEntry,
  RawMediaItem,
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
 * Backs the `museum_name` field on every object-returning tool and the `labels`
 * map `smithsonian_list_terms` returns for `unit_code`.
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
  SI: 'Smithsonian Institution',
  SIA: 'Smithsonian Institution Archives',
  SIL: 'Smithsonian Libraries',
  SILAF: 'Smithsonian Libraries',
  SILNMAHTL: 'Smithsonian Libraries',
  SLA_SRO: 'Smithsonian Libraries and Archives',
};

/** Resolve a unit code to its museum name, echoing the raw code when unmapped. */
function museumName(unitCode: string | undefined): string {
  return (unitCode && MUSEUM_NAMES[unitCode]) ?? unitCode ?? 'Smithsonian Institution';
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/** Pick the first non-empty content string from a freetext label-array. */
function firstContent(entries: RawFreetextEntry[] | undefined): string | undefined {
  return entries?.find((e) => e.content)?.content;
}

/** Collect content strings from a freetext label-array, optionally filtered by label. */
function collectContent(entries: RawFreetextEntry[] | undefined, labelFilter?: string[]): string[] {
  if (!entries) return [];
  return entries
    .filter((e) => !labelFilter || labelFilter.some((l) => e.label?.includes(l)))
    .map((e) => e.content)
    .filter((c): c is string => Boolean(c));
}

/**
 * Drop empties and exact duplicates from a string list, keeping first-seen order.
 * `Set` iteration is insertion-ordered, so the first occurrence of a repeated
 * term holds its position.
 */
function distinct(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * True when a physicalDescription label marks a measurement rather than material
 * prose. `Dimensions` and `Measurements` are the only dimension labels the live
 * vocabulary uses; both match here. Used to route an entry into `dimensions` and
 * to exclude it from `materials` so a measurement never renders under both headings.
 */
function isDimensionLabel(label: string | undefined): boolean {
  const l = (label ?? '').toLowerCase();
  return l.includes('dim') || l.includes('size') || l.includes('measure');
}

/** Return true when the object-level metadata_usage.access is CC0. */
function isObjectCC0(raw: RawEDAN): boolean {
  return raw.content?.descriptiveNonRepeating?.metadata_usage?.access === 'CC0';
}

/** Extract thumbnail URL from the first media item in online_media. */
function firstThumbnail(raw: RawEDAN): string | undefined {
  return raw.content?.descriptiveNonRepeating?.online_media?.media?.[0]?.thumbnail;
}

/** Normalize a raw EDAN record into an ObjectSummary. */
function normalizeToSummary(raw: RawEDAN): ObjectSummary {
  const dnr = raw.content?.descriptiveNonRepeating;
  const indexed = raw.content?.indexedStructured;
  const recordId = dnr?.record_ID ?? raw.url?.replace(/^edanmdm:/, '') ?? raw.id ?? '';
  const unitCode = dnr?.unit_code ?? raw.unitCode ?? '';
  const mediaCount = dnr?.online_media?.mediaCount ?? dnr?.online_media?.media?.length ?? 0;
  const objectType = indexed?.object_type?.[0];
  const date = indexed?.date?.[0];
  const thumbnailUrl = firstThumbnail(raw);
  return {
    record_id: recordId,
    title: raw.title ?? '',
    unit_code: unitCode,
    museum_name: museumName(unitCode),
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
  const unitCode = dnr?.unit_code ?? raw.unitCode ?? '';
  const recordId = dnr?.record_ID ?? raw.url?.replace(/^edanmdm:/, '') ?? raw.id ?? '';

  // Dates — gather both structured and freetext
  const dates: Array<{ label: string; value: string }> = [];
  for (const entry of freetext?.date ?? []) {
    if (entry.content) dates.push({ label: entry.label ?? 'Date', value: entry.content });
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
  if (!description) description = firstContent(freetext?.notes);

  // Makers
  const makers: Array<{ role: string; name: string }> = [];
  for (const entry of freetext?.name ?? []) {
    if (entry.content) makers.push({ role: entry.label ?? 'Name', name: entry.content });
  }

  // Materials — physicalDescription entries that are NOT dimension-labeled, so a
  // measurement string (claimed by `dimensions` below) never also renders as a
  // material. A generic "Physical Description" label carries no signal to separate
  // material prose from measurement prose, so those entries fall through here as-is
  // — an inherent limit of label-based routing, not resolvable without content parsing.
  const materials = collectContent(
    freetext?.physicalDescription?.filter((entry) => !isDimensionLabel(entry.label)),
  );

  // Dimensions — physicalDescription entries whose label marks a measurement.
  const dimensions: string[] = [];
  for (const entry of freetext?.physicalDescription ?? []) {
    if (isDimensionLabel(entry.label) && entry.content) dimensions.push(entry.content);
  }

  // Place
  const place: Array<{ label: string; value: string }> = [];
  for (const entry of freetext?.place ?? []) {
    if (entry.content) place.push({ label: entry.label ?? 'Place', value: entry.content });
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

  // Credit
  const credit_line = firstContent(freetext?.creditLine);

  // Identifiers
  const identifiers: Array<{ label: string; value: string }> = [];
  for (const entry of freetext?.identifier ?? []) {
    if (entry.content)
      identifiers.push({ label: entry.label ?? 'Identifier', value: entry.content });
  }

  // Rights
  const object_rights = firstContent(freetext?.objectRights);

  // Media summary — cc0_image_count runs the SAME image pipeline as
  // smithsonian_get_media (extractImageItems → CC0 filter), so the two counts
  // reconcile by construction. `count` is the raw total across all media types
  // (images, 3D models, video, …), which is why it can exceed cc0_image_count.
  const media = dnr?.online_media?.media ?? [];
  const cc0ImageCount = extractImageItems(media).filter((img) => img.is_cc0).length;
  const mediaCount = dnr?.online_media?.mediaCount ?? media.length;

  const thumbnailUrl = firstThumbnail(raw);
  return {
    record_id: recordId,
    title: raw.title ?? '',
    unit_code: unitCode,
    museum_name: museumName(unitCode),
    dates,
    ...(description !== undefined && { description }),
    makers,
    materials,
    dimensions,
    place,
    culture,
    topics,
    exhibitions,
    ...(credit_line !== undefined && { credit_line }),
    identifiers,
    ...(object_rights !== undefined && { object_rights }),
    is_cc0: isObjectCC0(raw),
    ...(dnr?.record_link !== undefined && { record_link: dnr.record_link }),
    media_summary: {
      count: mediaCount,
      cc0_image_count: cc0ImageCount,
      has_cc0_images: cc0ImageCount > 0,
      ...(thumbnailUrl !== undefined && { thumbnail_url: thumbnailUrl }),
    },
  };
}

/** Build a MediaResolution without undefined optional fields. */
function buildResolution(
  url: string,
  width: number | undefined,
  height: number | undefined,
): MediaResolution {
  return width !== undefined && height !== undefined ? { url, width, height } : { url };
}

/** Normalize a raw media item into an ImageItem. */
function normalizeToImage(m: RawMediaItem): ImageItem | null {
  const mediaId = m.idsId ?? m.id ?? '';
  if (!mediaId) return null;

  // Parse resource list for high-res, screen, thumb
  let high_res_jpeg: MediaResolution | undefined;
  let high_res_tiff: MediaResolution | undefined;
  let screen_url: string | undefined;
  let thumbnail_url = m.thumbnail;

  for (const r of m.resources ?? []) {
    const label = (r.label ?? '').toLowerCase();
    if (!r.url) continue;
    if (label.includes('tiff') || label.includes('tif')) {
      high_res_tiff = buildResolution(r.url, r.width, r.height);
    } else if (label.includes('jpeg') || label.includes('jpg') || label.includes('high-res')) {
      high_res_jpeg = buildResolution(r.url, r.width, r.height);
    } else if (label.includes('screen')) {
      screen_url = r.url;
    } else if (label.includes('thumb')) {
      thumbnail_url = r.url;
    }
  }

  // Fallbacks using the content URL (IDS delivery service)
  if (!screen_url && m.content) screen_url = m.content;

  return {
    media_id: mediaId,
    is_cc0: m.usage?.access === 'CC0',
    ...(m.altTextAccessibility !== undefined && { alt_text: m.altTextAccessibility }),
    ...(m.extDescrAccessibility !== undefined && { description: m.extDescrAccessibility }),
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
 * get_media actually returns. Non-image media (3D models, video) is excluded.
 */
function extractImageItems(media: RawMediaItem[]): ImageItem[] {
  return media
    .filter((m): m is RawMediaItem => m.type === 'Images' || !m.type)
    .map(normalizeToImage)
    .filter((m): m is ImageItem => m !== null);
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
 * `contains` substrings to try for a term, widest first: the value itself, the
 * segment before its first structural separator, then its leading token.
 *
 * The whole value is first because it is the substring a caller would write, and
 * on the short vocabularies (`culture`, `place`) it already lists neighbors —
 * "Guiana" is inside "Guiana, French". Where it fails is the long, fully-qualified
 * end of `topic`, whose terms carry LCSH subdivisions ("Quilts--History") and
 * qualifiers ('Bell UH-1H Iroquois "Huey" Smokey III'); cutting at `--`, `(`, or
 * `,` recovers the shared head, and the leading token is the last resort when the
 * value carries no separator at all. Each is only a candidate — {@link
 * SmithsonianService.describeTerm} tests it against the vocabulary before any hint
 * names it.
 */
function containsCandidates(value: string): string[] {
  const cut = value.search(/--|[(,]/);
  const candidates = [value, cut > 0 ? value.slice(0, cut) : '', value.split(/\s+/)[0] ?? ''];
  return [...new Set(candidates.map((c) => c.trim()).filter(Boolean))];
}

// ---------------------------------------------------------------------------
// SmithsonianService
// ---------------------------------------------------------------------------

export class SmithsonianService {
  constructor(private readonly storage: StorageService) {}

  /** Execute a GET request with retry/backoff. Handles error-in-200 responses. */
  private get<T extends { error?: { code?: string; message?: string } }>(
    url: string,
    ctx: RequestContextLike,
    extraHeaders?: Record<string, string>,
    /**
     * Non-2xx statuses that are an expected outcome for this call, logged at
     * `debug` instead of `error` (the status-mapped throw is unchanged). Only
     * getContent passes this — a missing object is a real 404 from EDAN, and a
     * bad object ID is a routine client mistake, not a server-side fault worth
     * an error-level line in the digest. search/listTerms omit it: a 404 there
     * would be genuinely unexpected.
     */
    expectedStatuses?: number[],
  ): Promise<T> {
    return withRetry(
      async () => {
        const signal = (ctx as { signal?: AbortSignal }).signal;
        const response = await fetchWithTimeout(url, 15_000, ctx, {
          headers: { Accept: 'application/json', ...extraHeaders },
          ...(signal && { signal }),
          ...(expectedStatuses && { expectedStatuses }),
        });
        const raw = (await response.json()) as T;

        // The API returns HTTP 200 with an error body for key/rate issues.
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

        return raw;
      },
      { operation: 'SmithsonianService.get', context: ctx, baseDelayMs: 2000, maxRetries: 3 },
    );
  }

  /**
   * Search across Smithsonian objects.
   * Returns normalized summaries and the total row count.
   *
   * Field constraints are embedded in `q` as ANDed Lucene `field:value` terms
   * (EDAN has no `fq` parameter), so each filter is a hard constraint rather
   * than a scoring-only hint.
   */
  async search(
    params: {
      query: string;
      rows: number;
      start: number;
      /** Lucene field:value terms, ANDed into the query as hard constraints (e.g. "unit_code:NASM"). */
      filters?: string[];
    },
    ctx: RequestContextLike,
  ): Promise<{ rows: ObjectSummary[]; rowCount: number }> {
    const activeFilters = params.filters ?? [];
    const cfg = getServerConfig();
    const base = `${cfg.baseUrl}/search`;

    // Embed field constraints into q as ANDed Lucene terms so each filter is a
    // HARD constraint (EDAN has no fq param). The base query is parenthesized
    // because an explicit AND otherwise binds only to the adjacent word.
    // Space-joining instead would make filters soft (scoring-only), letting
    // non-matching units outrank filtered results — so the AND is required.
    let q = params.query;
    if (activeFilters.length > 0) {
      const baseQ = q && q !== '*' ? `(${q})` : '';
      const terms = activeFilters.join(' AND ');
      q = baseQ ? `${baseQ} AND ${terms}` : terms;
    }

    const qs = new URLSearchParams({
      q,
      rows: String(params.rows),
      start: String(params.start),
    });
    const url = `${base}?${qs.toString()}`;

    // Pass API key as header (not query param) so it never appears in logs or errors.
    const raw = await this.get<RawSearchResponse>(url, ctx, { 'X-Api-Key': cfg.apiKey });
    const rows = (raw.response?.rows ?? []).map(normalizeToSummary);
    return { rows, rowCount: raw.response?.rowCount ?? rows.length };
  }

  /**
   * Fetch a single object by record_id.
   * The content endpoint returns the object directly at `response` (not `response.rows[0]`).
   *
   * Takes the full `Context` rather than the `RequestContextLike` projection the other
   * methods use, because both not-found throw sites resolve the calling tool's declared
   * `not_found` recovery hint via `ctx.recoveryFor` — a member only `Context` carries.
   * `Context` is still assignable to `RequestContextLike`, so the internal `this.get`
   * call is unaffected. Every caller (`smithsonian_get_object`, `smithsonian_get_media`,
   * `smithsonian_find_related`) declares a `not_found` entry, so the resolver returns
   * that tool's own hint; a caller without one gets `{}` and the pre-existing shape.
   */
  async getContent(recordId: string, ctx: Context): Promise<RawEDAN> {
    const cfg = getServerConfig();
    const prefixed = recordId.startsWith('edanmdm:') ? recordId : `edanmdm:${recordId}`;
    const url = `${cfg.baseUrl}/content/${encodeURIComponent(prefixed)}`;

    // Pass API key as header (not query param) so it never appears in logs or errors.
    let raw: RawContentResponse;
    try {
      // EDAN returns a real HTTP 404 for a missing object; expect it so a bad ID
      // logs at debug, not as a server error. The NotFound throw still fires and
      // is rewrapped below with the caller's recovery hint.
      raw = await this.get<RawContentResponse>(url, ctx, { 'X-Api-Key': cfg.apiKey }, [404]);
    } catch (err: unknown) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw notFound(`No Smithsonian object found for ID "${recordId}".`, {
          recordId,
          reason: 'not_found',
          ...ctx.recoveryFor('not_found'),
        });
      }
      throw err;
    }

    if (!raw.response) {
      throw notFound(`No Smithsonian object found for ID "${recordId}".`, {
        recordId,
        reason: 'not_found',
        ...ctx.recoveryFor('not_found'),
      });
    }
    return raw.response;
  }

  /** Normalize a raw EDAN record to a full object. */
  toFullObject(raw: RawEDAN): FullObject {
    return normalizeToFull(raw);
  }

  /** Extract and normalize image items from a raw EDAN record. */
  toImageItems(raw: RawEDAN): ImageItem[] {
    return extractImageItems(raw.content?.descriptiveNonRepeating?.online_media?.media ?? []);
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
   * call costs today. `SMITHSONIAN_TERMS_CACHE_TTL_SECONDS=0` disables it.
   *
   * The framework's storage key validator only accepts `^[a-zA-Z0-9_.\-/]+$`, so
   * the key separator is `/` — a `terms:${field}` key throws at runtime.
   */
  private async vocabulary(field: string, ctx: RequestContextLike): Promise<string[]> {
    const cfg = getServerConfig();
    const key = `terms/${field}`;
    const ttl = cfg.termsCacheTtlSeconds;

    if (ttl > 0) {
      const cached = await this.storage.get<string[]>(key, ctx);
      if (cached) return cached;
    }

    const url = `${cfg.baseUrl}/terms/${encodeURIComponent(field)}`;
    const raw = await this.get<RawTermsResponse>(url, ctx, { 'X-Api-Key': cfg.apiKey });
    const terms = raw.response?.terms ?? [];

    if (ttl > 0) await this.storage.set(key, terms, ctx, { ttl });
    return terms;
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
   * museum name, so a caller who knows only the name ("National Air and Space")
   * resolves it to a code in one call; `labels` returns the name for every code
   * on the page that has one, and codes outside {@link MUSEUM_NAMES} come back
   * bare, as they do on every other tool.
   */
  async listTerms(
    params: { field: string; start: number; rows: number; contains?: string },
    ctx: RequestContextLike,
  ): Promise<{ terms: string[]; total: number; labels?: Record<string, string> }> {
    const all = await this.vocabulary(params.field, ctx);
    const labelled = params.field === 'unit_code';

    const needle = params.contains?.toLowerCase();
    const matched = needle
      ? all.filter(
          (term) =>
            term.toLowerCase().includes(needle) ||
            (labelled && MUSEUM_NAMES[term]?.toLowerCase().includes(needle) === true),
        )
      : all;
    const page = matched.slice(params.start, params.start + params.rows);
    if (!labelled) return { terms: page, total: matched.length };

    const labels: Record<string, string> = {};
    for (const term of page) {
      const name = MUSEUM_NAMES[term];
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
   * term at all. Each candidate from {@link containsCandidates} is tested against
   * the vocabulary already in hand, and only one that resolves to a term OTHER
   * than the value is returned — so a hint naming it is naming a call with
   * something to show. When none does, the caller has no term route to offer and
   * says so instead of sending the caller back into the same value (issue #46).
   */
  async describeTerm(
    field: string,
    value: string,
    ctx: RequestContextLike,
  ): Promise<TermDescription> {
    const vocabulary = await this.vocabulary(field, ctx);
    if (!vocabulary.includes(value)) return { indexed: false };

    for (const contains of containsCandidates(value)) {
      const needle = contains.toLowerCase();
      const count = vocabulary.filter(
        (term) => term !== value && term.toLowerCase().includes(needle),
      ).length;
      if (count > 0) return { indexed: true, neighbors: { contains, count } };
    }
    return { indexed: true };
  }
}

// ---------------------------------------------------------------------------
// Init/accessor pattern
// ---------------------------------------------------------------------------

let _service: SmithsonianService | undefined;

export function initSmithsonianService(_config: AppConfig, storage: StorageService): void {
  _service = new SmithsonianService(storage);
}

export function getSmithsonianService(): SmithsonianService {
  if (!_service) {
    throw new Error(
      'SmithsonianService not initialized — call initSmithsonianService() in setup()',
    );
  }
  return _service;
}
