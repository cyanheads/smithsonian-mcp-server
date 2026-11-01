/**
 * @fileoverview Domain types for the Smithsonian Open Access API service.
 * @module services/smithsonian/types
 */

// ---------------------------------------------------------------------------
// Raw API response shapes (upstream sparsity-aware — all fields optional except core IDs)
// ---------------------------------------------------------------------------

export interface RawMediaResource {
  dimensions?: string;
  height?: number;
  label?: string;
  url?: string;
  width?: number;
}

export interface RawMediaItem {
  altTextAccessibility?: string;
  content?: string;
  extDescrAccessibility?: string;
  id?: string;
  idsId?: string;
  resources?: RawMediaResource[];
  thumbnail?: string;
  type?: string;
  usage?: { access?: string };
}

export interface RawOnlineMedia {
  media?: RawMediaItem[];
  mediaCount?: number;
}

export interface RawMetadataUsage {
  access?: string;
}

export interface RawDescriptiveNonRepeating {
  data_source?: string;
  metadata_usage?: RawMetadataUsage;
  online_media?: RawOnlineMedia;
  record_ID?: string;
  record_link?: string;
  unit_code?: string;
}

export interface RawFreetextEntry {
  content?: string;
  label?: string;
}

export interface RawFreetext {
  creditLine?: RawFreetextEntry[];
  dataSource?: RawFreetextEntry[];
  date?: RawFreetextEntry[];
  exhibitionHistory?: RawFreetextEntry[];
  identifier?: RawFreetextEntry[];
  name?: RawFreetextEntry[];
  notes?: RawFreetextEntry[];
  objectRights?: RawFreetextEntry[];
  physicalDescription?: RawFreetextEntry[];
  place?: RawFreetextEntry[];
  topic?: RawFreetextEntry[];
}

/**
 * An `indexedStructured.name` entry. Usually the indexed value as a bare string,
 * but bibliographic and authority records (Smithsonian Research Online, Libraries,
 * archives) wrap it in an object that carries the same value under `content`
 * alongside provenance — `{ type: "author" }`, `{ VIAF: "…" }`. Other indexed
 * text fields are string arrays; `geoLocation` carries structured points.
 */
export type RawIndexedName = string | { content?: string };

export interface RawIndexedStructured {
  culture?: string[];
  date?: string[];
  geoLocation?: Array<{
    Other?: { type?: string; content?: string };
    points?: {
      point?: {
        latitude?: { type?: string; content?: string };
        longitude?: { type?: string; content?: string };
      };
    };
  }>;
  name?: RawIndexedName[];
  object_type?: string[];
  online_media_type?: string[];
  place?: string[];
  scientific_name?: string[];
  tax_class?: string[];
  tax_family?: string[];
  tax_kingdom?: string[];
  tax_order?: string[];
  tax_phylum?: string[];
  topic?: string[];
}

export interface RawContent {
  descriptiveNonRepeating?: RawDescriptiveNonRepeating;
  freetext?: RawFreetext;
  indexedStructured?: RawIndexedStructured;
}

export interface RawEDAN {
  content?: RawContent;
  id?: string;
  title?: string;
  type?: string;
  unitCode?: string;
  url?: string;
}

/** Search endpoint: response.rows[] */
export interface RawSearchResponse {
  error?: { code?: string; message?: string };
  response?: {
    rows?: RawEDAN[];
    rowCount?: number;
    facets?: unknown[];
    message?: string;
  };
  responseCode?: number;
  status?: number;
}

/** Content endpoint: response is the object directly */
export interface RawContentResponse {
  error?: { code?: string; message?: string };
  response?: RawEDAN;
  responseCode?: number;
  status?: number;
}

/**
 * Terms endpoint: `response.terms` is a bare `string[]` — no per-term counts,
 * and `response` carries only `message` + `terms` (no `rowCount`). Upstream
 * ignores `rows`/`start` and returns the full vocabulary on every call, so
 * pagination is done client-side by slicing this array.
 */
export interface RawTermsResponse {
  error?: { code?: string; message?: string };
  response?: {
    message?: string;
    terms?: string[];
  };
  responseCode?: number;
  status?: number;
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * The stores a read can be answered from: `oa_mirror`, the local copy of the Open Access bulk
 * metadata, and `edan_api`, the live EDAN API.
 */
export const DATA_SOURCES = ['oa_mirror', 'edan_api'] as const;

export type DataSource = (typeof DATA_SOURCES)[number];

/**
 * Where one read was answered. A service without a mirror reports none: its reads carry
 * `undefined`, so their responses stay what they were before the mirror existed.
 */
export type Provenance =
  | { source: 'edan_api' }
  | {
      source: 'oa_mirror';
      /**
       * The mirror's snapshot: when the bucket content its last completed sync applied was
       * published, ISO 8601. Absent only while a full rebuild over a completed mirror runs.
       */
      snapshot?: string;
    };

// ---------------------------------------------------------------------------
// Normalized domain types
// ---------------------------------------------------------------------------

export interface ObjectSummary {
  date?: string;
  has_media: boolean;
  /**
   * The record's own `descriptiveNonRepeating.data_source`, present only when the
   * record's unit code differs from the one it is indexed under (`unit_code`).
   */
  holding_museum_name?: string;
  is_cc0: boolean;
  museum_name: string;
  object_type?: string;
  record_id: string;
  thumbnail_url?: string;
  title: string;
  unit_code: string;
}

export interface FullObject {
  coordinates: Array<{ latitude: number; longitude: number; locality?: string }>;
  credit_line?: string;
  culture: string[];
  dates: Array<{ label: string; value: string }>;
  description?: string;
  dimensions: string[];
  exhibitions: Array<{ name: string; building?: string }>;
  /** Same rule as {@link ObjectSummary.holding_museum_name}. */
  holding_museum_name?: string;
  identifiers: Array<{ label: string; value: string }>;
  is_cc0: boolean;
  makers: Array<{ role: string; name: string }>;
  materials: string[];
  media_summary: {
    count: number;
    cc0_image_count: number;
    has_cc0_images: boolean;
    thumbnail_url?: string;
    non_image_media: NonImageMedia[];
  };
  museum_name: string;
  notes: Array<{ label: string; content: string }>;
  object_rights?: string;
  place: Array<{ label: string; value: string }>;
  record_id: string;
  record_link?: string;
  scientific_names: string[];
  taxonomy?: Partial<Record<'kingdom' | 'phylum' | 'class' | 'order' | 'family', string[]>>;
  title: string;
  topics: string[];
  unit_code: string;
}

export interface MediaResolution {
  height?: number;
  url: string;
  width?: number;
}

/**
 * A media item smithsonian_get_media does not deliver: one whose `type` is set and
 * is not `Images` (3D packages, scanned books, document viewers, PDFs). Exactly the
 * items the image selection leaves out, so the two partition `online_media.media[]`.
 */
export interface NonImageMedia {
  is_cc0: boolean;
  type: string;
  /** The item's `content` link; absent when upstream gives none. */
  url?: string;
}

export interface ImageItem {
  alt_text?: string;
  description?: string;
  high_res_jpeg?: MediaResolution;
  high_res_tiff?: MediaResolution;
  is_cc0: boolean;
  media_id: string;
  screen_url?: string;
  thumbnail_url?: string;
}

/**
 * Where a filter value stands in its field's term vocabulary, and — when the
 * vocabulary holds it — a `contains` substring proven to list something else.
 *
 * Recovery hints on a zero-match search or browse read both halves: `indexed`
 * separates a value that can be resolved through smithsonian_list_terms from one
 * the index already enumerates, and `neighbors` is the only substring the hint
 * may name, because it was tested against the vocabulary rather than assumed.
 */
export interface TermDescription {
  /** True when the value is an exact, case-sensitive member of the vocabulary. */
  indexed: boolean;
  /**
   * The tightest substring a `contains` query resolves to at least one term other
   * than the value itself, and to few enough of them to be worth browsing. Absent
   * when no tested substring does either, in which case a hint has no working term
   * route to offer and must not name one.
   */
  neighbors?: {
    /** The substring to pass as smithsonian_list_terms `contains`. */
    contains: string;
    /** How many vocabulary terms other than the value contain it. */
    count: number;
  };
}
