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

export interface RawIndexedStructured {
  culture?: string[];
  date?: string[];
  name?: string[];
  object_type?: string[];
  online_media_type?: string[];
  place?: string[];
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

/** Terms endpoint: response.terms[] */
export interface RawTermsResponse {
  error?: { code?: string; message?: string };
  response?: {
    terms?: Array<{ term?: string; count?: number }>;
    rowCount?: number;
  };
  responseCode?: number;
  status?: number;
}

// ---------------------------------------------------------------------------
// Normalized domain types
// ---------------------------------------------------------------------------

export interface ObjectSummary {
  has_media: boolean;
  is_cc0: boolean;
  museum_name: string;
  object_type?: string;
  record_id: string;
  thumbnail_url?: string;
  title: string;
  unit_code: string;
}

export interface FullObject {
  credit_line?: string;
  culture: string[];
  dates: Array<{ label: string; value: string }>;
  description?: string;
  dimensions: string[];
  exhibitions: Array<{ name: string; building?: string }>;
  identifiers: Array<{ label: string; value: string }>;
  is_cc0: boolean;
  makers: Array<{ role: string; name: string }>;
  materials: string[];
  media_summary: {
    count: number;
    cc0_image_count: number;
    has_cc0_images: boolean;
    thumbnail_url?: string;
  };
  museum_name: string;
  object_rights?: string;
  place: Array<{ label: string; value: string }>;
  record_id: string;
  record_link?: string;
  title: string;
  topics: string[];
  unit_code: string;
}

export interface MediaResolution {
  height?: number;
  url: string;
  width?: number;
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
