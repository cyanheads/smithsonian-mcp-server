/**
 * @fileoverview Smithsonian EDAN Open Access API service — search and content retrieval.
 * @module services/smithsonian/smithsonian-service
 */

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
} from './types.js';

// ---------------------------------------------------------------------------
// Unit code → museum name map
// ---------------------------------------------------------------------------

const MUSEUM_NAMES: Record<string, string> = {
  NASM: 'National Air and Space Museum',
  NMNH: 'National Museum of Natural History',
  SAAM: 'Smithsonian American Art Museum',
  NMAH: 'National Museum of American History',
  NMAAHC: 'National Museum of African American History and Culture',
  NMAI: 'National Museum of the American Indian',
  NMAfA: 'National Museum of African Art',
  NPG: 'National Portrait Gallery',
  CHNDM: 'Cooper Hewitt, Smithsonian Design Museum',
  HMSG: 'Hirshhorn Museum and Sculpture Garden',
  FSG: 'Freer Gallery of Art and Arthur M. Sackler Gallery',
  NPM: 'National Postal Museum',
  ACM: 'Anacostia Community Museum',
  NZP: 'National Zoo & Conservation Biology Institute',
  SIL: 'Smithsonian Libraries and Archives',
  AAA: 'Archives of American Art',
};

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
  const thumbnailUrl = firstThumbnail(raw);
  return {
    record_id: recordId,
    title: raw.title ?? '',
    unit_code: unitCode,
    museum_name: museumName(unitCode),
    ...(objectType !== undefined && { object_type: objectType }),
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

  // Materials
  const materials = collectContent(freetext?.physicalDescription);

  // Dimensions — from physicalDescription entries containing 'dim'
  const dimensions: string[] = [];
  for (const entry of freetext?.physicalDescription ?? []) {
    const label = (entry.label ?? '').toLowerCase();
    if (label.includes('dim') || label.includes('size') || label.includes('measure')) {
      if (entry.content) dimensions.push(entry.content);
    }
  }

  // Place
  const place: Array<{ label: string; value: string }> = [];
  for (const entry of freetext?.place ?? []) {
    if (entry.content) place.push({ label: entry.label ?? 'Place', value: entry.content });
  }

  // Culture
  const culture = (indexed?.culture ?? []).filter(Boolean);

  // Topics
  const topics = [...(indexed?.topic ?? []), ...collectContent(freetext?.topic)].filter(Boolean);

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

/** Build a Lucene `field:value` term, quoting values that contain whitespace. */
export function luceneField(field: string, value: string): string {
  return value.includes(' ') ? `${field}:"${value}"` : `${field}:${value}`;
}

// ---------------------------------------------------------------------------
// SmithsonianService
// ---------------------------------------------------------------------------

export class SmithsonianService {
  constructor(_config: AppConfig, _storage: StorageService) {}

  /** Execute a GET request with retry/backoff. Handles error-in-200 responses. */
  private async get<T extends { error?: { code?: string; message?: string } }>(
    url: string,
    ctx: RequestContextLike,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    return withRetry(
      async () => {
        const signal = (ctx as { signal?: AbortSignal }).signal;
        const response = await fetchWithTimeout(url, 15_000, ctx, {
          headers: { Accept: 'application/json', ...extraHeaders },
          ...(signal && { signal }),
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
   */
  async getContent(recordId: string, ctx: RequestContextLike): Promise<RawEDAN> {
    const cfg = getServerConfig();
    const prefixed = recordId.startsWith('edanmdm:') ? recordId : `edanmdm:${recordId}`;
    const url = `${cfg.baseUrl}/content/${encodeURIComponent(prefixed)}`;

    // Pass API key as header (not query param) so it never appears in logs or errors.
    let raw: RawContentResponse;
    try {
      raw = await this.get<RawContentResponse>(url, ctx, { 'X-Api-Key': cfg.apiKey });
    } catch (err: unknown) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw notFound(`No Smithsonian object found for ID "${recordId}".`, { recordId });
      }
      throw err;
    }

    if (!raw.response) {
      throw notFound(`No Smithsonian object found for ID "${recordId}".`, { recordId });
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
   * Enumerate the valid term vocabulary for an indexed field.
   * Calls `/terms/{field}` and returns the term list sorted by count descending.
   */
  async listTerms(
    params: { field: string; start: number; rows: number },
    ctx: RequestContextLike,
  ): Promise<{ terms: Array<{ value: string; count: number }>; total: number }> {
    const cfg = getServerConfig();
    const qs = new URLSearchParams({
      q: '',
      start: String(params.start),
      rows: String(params.rows),
    });
    const url = `${cfg.baseUrl}/terms/${encodeURIComponent(params.field)}?${qs.toString()}`;

    const raw = await this.get<RawTermsResponse>(url, ctx, { 'X-Api-Key': cfg.apiKey });
    const terms = (raw.response?.terms ?? [])
      .filter((t): t is { term: string; count?: number } => Boolean(t.term))
      .map((t) => ({ value: t.term, count: t.count ?? 0 }));
    return { terms, total: raw.response?.rowCount ?? terms.length };
  }
}

// ---------------------------------------------------------------------------
// Init/accessor pattern
// ---------------------------------------------------------------------------

let _service: SmithsonianService | undefined;

export function initSmithsonianService(config: AppConfig, storage: StorageService): void {
  _service = new SmithsonianService(config, storage);
}

export function getSmithsonianService(): SmithsonianService {
  if (!_service) {
    throw new Error(
      'SmithsonianService not initialized — call initSmithsonianService() in setup()',
    );
  }
  return _service;
}
