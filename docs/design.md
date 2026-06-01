# smithsonian-mcp-server — Design

## ⚠️ API Key Required

> **`SMITHSONIAN_API_KEY` is REQUIRED.** The Smithsonian Open Access API does NOT allow keyless access — a probe against `api.si.edu/openaccess/api/v1.0/search` without a key returns `{"error": {"code": "API_KEY_MISSING", ...}}` immediately.
>
> The key is **free**: sign up at [https://api.data.gov/signup](https://api.data.gov/signup). It's issued instantly with no review process. Until Casey provisions a key and sets `SMITHSONIAN_API_KEY`, **live field-testing is blocked**.
>
> DEMO_KEY works at low rate limits (~5 req/min) and was used for all live API probing in this design.

---

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations | Errors |
|:-----|:------------|:-----------|:------------|:-------|
| `smithsonian_search` | Full-text search across 19.4M objects. Shortcut `query` for plain text; structured filters for narrowing. Returns curated summaries, thumbnails, and facet counts. | `query`, `filters` (unit_code, object_type, date_decade, culture, place, media_type, online_only), `rows`, `start` | `readOnlyHint: true`, `openWorldHint: true` | `no_results` (NotFound), `invalid_filter` (InvalidParams) |
| `smithsonian_get_object` | Full record by ID: title, description, dates, materials, dimensions, provenance, exhibition, credit, media URLs. Returns all media items with per-image CC0 status. | `id` | `readOnlyHint: true`, `openWorldHint: true` | `not_found` (NotFound), `invalid_id` (InvalidParams) |
| `smithsonian_explore` | Guided browse by category. Mode: `museum` \| `culture` \| `period` \| `medium`. Searches a constrained query internally and returns category overview with sample objects and counts — the "what does the Smithsonian have about X?" entry point. | `mode`, `value`, `rows` | `readOnlyHint: true`, `openWorldHint: true` | `no_results` (NotFound) |
| `smithsonian_find_related` | Given an object ID, finds related items across collections. Fetches the anchor object's metadata (culture, period, object_type, maker topics), then fan-searches the API to surface cross-collection connections. Returns up to 20 related objects with similarity rationale. | `id`, `limit` | `readOnlyHint: true`, `openWorldHint: true` | `not_found` (NotFound), `invalid_id` (InvalidParams) |
| `smithsonian_get_media` | Returns image URLs at multiple resolutions for an object. CC0 objects only — states access status explicitly when an object is not open access. Includes alt text and accessibility descriptions from the catalog. | `id` | `readOnlyHint: true`, `openWorldHint: true` | `not_found` (NotFound), `no_media` (NotFound), `not_cc0` (NotFound), `invalid_id` (InvalidParams) |

### Resources

None. The Smithsonian catalog is too dynamic and the IDs too opaque to benefit from stable URI injection. All access flows through tools.

### Prompts

None. This is a pure data-access server.

---

## Overview

Smithsonian Open Access MCP server wrapping the Smithsonian Institution's EDAN (Enterprise Digital Asset Network) Open Access API. Exposes 19.4 million objects across 20+ museums and research centers — art, natural history specimens, aerospace artifacts, American history, African American culture, Indigenous collections, scientific instruments, photography, and library materials.

The server earns standalone status: single-source, but with massive cross-collection coverage, deep provenance metadata, high-resolution CC0 imagery, and a query surface that rewards LLM-driven discovery.

## Requirements

- `SMITHSONIAN_API_KEY` is **required** — free from [https://api.data.gov/signup](https://api.data.gov/signup). Server startup fails with a clear `ConfigurationError` when absent.
- Rate limit: `api_key` from api.data.gov has standard limits (~1,000 req/hr for free tier). DEMO_KEY is ~5 req/min — not suitable for production.
- API endpoint: `https://api.si.edu/openaccess/api/v1.0/`
- Object IDs are prefixed: `edanmdm:{record_ID}` — e.g. `edanmdm:nasm_A19670093000`. The `record_ID` field in `content.descriptiveNonRepeating` is the stable identifier.
- CC0 gating: check `content.descriptiveNonRepeating.metadata_usage.access === 'CC0'` for the object; per-image `media[].usage.access === 'CC0'` for each image.
- Images are served by the Smithsonian IDS (Image Delivery Service) at `ids.si.edu`. **No IIIF manifests** — the IDS uses direct download URLs with `_screen`, `_thumb`, and high-res TIFF/JPEG variants.
- Read-only throughout.

## Domain Mapping

| Noun | Operations |
|:-----|:-----------|
| Object | search (by text + filters), get (by ID), explore (by category), find-related (by metadata similarity) |
| Media | get-images (by object ID, CC0 only) |

The `smithsonian_explore` tool is a workflow over the `search` operation: it constructs a category-constrained search and returns an enriched overview rather than exposing a separate browse API endpoint (which doesn't exist in the open API).

`smithsonian_find_related` is a multi-step workflow: fetch anchor object → extract metadata signals → fan-out searches → deduplicate and rank.

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `SmithsonianService` | Smithsonian EDAN Open Access API | All tools |

Single service — one API, one base URL, one auth pattern. Two primary methods internally: `search(params)` and `getContent(id)`. The service handles `api_key` injection, retry/backoff, and response normalization.

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `SMITHSONIAN_API_KEY` | **Yes** | API key from https://api.data.gov/signup. Server fails to start without it. |
| `SMITHSONIAN_BASE_URL` | No | Override the API base URL (default: `https://api.si.edu/openaccess/api/v1.0`). |
| `SMITHSONIAN_MAX_ROWS` | No | Default page size for search results (default: 20, max: 100 per API spec). |

## Implementation Order

1. Config (`src/config/server-config.ts`) — `SMITHSONIAN_API_KEY`, base URL, max rows. Hard-fail on missing key.
2. `SmithsonianService` — `search()` + `getContent()` with retry/backoff, URL construction, API key injection, response normalization helpers (flatten `freetext[]` label-content arrays, extract media, check CC0).
3. `smithsonian_search` — search returning up to `rows` (≤100) curated summaries with offset pagination.
4. `smithsonian_get_object` — single content fetch with full field normalization.
5. `smithsonian_get_media` — extract and gate images from a fetched object.
6. `smithsonian_explore` — mode-dispatch to constrained searches.
7. `smithsonian_find_related` — multi-search fan-out.

Each step is independently testable.

---

## Tool Detail

### `smithsonian_search`

**Description:** Search across 19.4 million Smithsonian objects by text query and optional filters. Filters narrow by museum unit, object type, decade, culture, geographic place, media type, and online-only availability. Returns curated summaries (title, date, museum, one-line description, thumbnail URL, CC0 flag) with the total match count. The `record_id` in each result is the identifier for `smithsonian_get_object` and `smithsonian_find_related`.

**Input:**
- `query: string` — Free-text search. Required. Use specific terms for precision (`"Tlingit totem pole"`) or broad terms for browsing (`"quilt"`).
- `filters?: object` — Optional structured filters:
  - `unit_code?: string` — museum unit code (e.g. `"NASM"`, `"NMNH"`, `"SAAM"`). See unit code table in API Reference.
  - `object_type?: string` — object type term from `indexedStructured.object_type` (e.g. `"Aircraft"`, `"Painting"`, `"Fossil"`).
  - `date_decade?: string` — decade string from `indexedStructured.date` (e.g. `"1920s"`, `"1960s"`).
  - `culture?: string` — culture term from `indexedStructured.culture` (e.g. `"Plains Indian"`).
  - `place?: string` — geographic place from `indexedStructured.place` (e.g. `"United States of America"`).
  - `online_media_type?: "Images" | "Videos" | "Audio" | "3D Images"` — restrict to objects with specific media types.
  - `online_only?: boolean` — when true, adds `fq=online_media_type:*` to restrict to objects with any online media.
  - `cc0_only?: boolean` — when true, adds `fq=media_usage:CC0` to restrict to CC0 objects. Useful before calling `smithsonian_get_media`.
- `rows?: number` — page size (default 20, max 100).
- `start?: number` — offset for pagination (default 0).

**Output:**
- `objects[]` — curated summaries: `{ record_id, title, date, unit_code, museum_name, object_type, thumbnail_url, is_cc0, has_media }`.
- `total_count` — total matching objects before pagination.

**Errors:**
- `no_results` (NotFound) — no objects matched the query and filters. Recovery: broaden the query, remove filters, or check spelling.
- `invalid_filter` (InvalidParams) — an unknown filter key was provided. Recovery: use only documented filter fields.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `smithsonian_get_object`

**Description:** Fetch the full catalog record for a Smithsonian object by its `record_id` (from `smithsonian_search` results). Returns all available metadata: title, dates, materials, dimensions, provenance, exhibition history, credit line, accession identifiers, and a curated media summary (count, CC0 status, thumbnail). The `record_id` uses the format returned by search — do not manually construct IDs.

**Input:**
- `id: string` — Object `record_id` as returned by `smithsonian_search` (e.g. `"nasm_A19670093000"`). The service prepends `edanmdm:` automatically.

**Output:**
- `record_id`, `title`, `unit_code`, `museum_name`
- `dates[]` — all labeled date fields (Date, Accession Date, etc.)
- `description` — best available prose from `freetext.notes` (Summary, Physical Description, Brief Description)
- `makers[]` — `{ role, name }` — all named parties (Pilot, Manufacturer, Artist, Author, etc.)
- `materials[]` — physical description strings
- `dimensions[]` — dimension strings
- `place[]` — labeled place fields
- `culture[]` — culture associations
- `topics[]` — subject/topic terms
- `exhibitions[]` — exhibition names + building
- `credit_line` — attribution string
- `identifiers[]` — all `{ label, value }` pairs (accession numbers, call numbers, etc.)
- `object_rights` — CC0 or other rights statement from `freetext.objectRights`
- `is_cc0` — boolean gated on `metadata_usage.access === 'CC0'`
- `record_link` — canonical SI URL for the object
- `media_summary` — `{ count, has_cc0_images, thumbnail_url }` — call `smithsonian_get_media` for full image list

**Errors:**
- `not_found` (NotFound) — no object with that ID in the catalog. Recovery: verify the ID via `smithsonian_search`.
- `invalid_id` (InvalidParams) — ID format is clearly malformed. Recovery: use `record_id` values from `smithsonian_search` results directly.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `smithsonian_explore`

**Description:** Browse Smithsonian collections by category to answer "what does the Smithsonian have about X?" questions. Constructs and executes a category-constrained search, then returns an overview: a curated set of sample objects and counts. Four browse modes: `museum` (by unit code or museum name), `culture` (by culture term), `period` (by decade, e.g. "1920s"), `medium` (by object type). Use as the entry point for open-ended research rather than a specific query.

**Input:**
- `mode: "museum" | "culture" | "period" | "medium"` — browse dimension.
- `value: string` — category value appropriate to the mode:
  - `museum`: unit code (`"NMNH"`) or full museum name (`"National Museum of Natural History"`)
  - `culture`: culture term (`"Aztec"`, `"Sioux"`, `"Japanese"`)
  - `period`: decade string (`"1940s"`, `"1860s"`)
  - `medium`: object type (`"Painting"`, `"Aircraft"`, `"Fossil"`, `"Photograph"`)
- `rows?: number` — sample objects to return (default 10).

**Output:**
- `mode`, `value`, `total_count` — how many objects match
- `sample_objects[]` — representative objects: `{ record_id, title, date, unit_code, thumbnail_url, is_cc0 }`
- `museum_breakdown[]` — when mode is not `museum`, top 5 contributing units with counts (helps plan museum-focused follow-up searches)

**Errors:**
- `no_results` (NotFound) — no objects match the category. Recovery: try a broader value, check spelling, or switch mode.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `smithsonian_find_related`

**Description:** Discover objects across Smithsonian collections related to a given object. Fetches the anchor object's metadata (culture, period, object type, maker names, topic terms), then fans out up to 4 parallel searches using different metadata signals as queries. Deduplicates against the anchor and merges results into a ranked list with the similarity signals that connected each related object. Cross-museum discovery is the differentiator — the anchor may be NASM aerospace, but related objects span NMNH, SAAM, and NMAH.

**Input:**
- `id: string` — `record_id` of the anchor object (from `smithsonian_search` or `smithsonian_get_object`).
- `limit?: number` — max related objects to return (default 10, max 20).

**Output:**
- `anchor` — summary of the anchor object (`{ record_id, title, unit_code }`)
- `related[]` — `{ record_id, title, date, unit_code, museum_name, thumbnail_url, is_cc0, similarity_signals[] }` where `similarity_signals` is a string array of the metadata terms that connected this object (e.g. `["culture: Plains Indian", "period: 1880s"]`)
- `search_signals_used[]` — which metadata fields drove the fan-out searches

**Errors:**
- `not_found` (NotFound) — anchor object not found. Recovery: verify the ID via `smithsonian_search`.
- `invalid_id` (InvalidParams) — ID format is clearly malformed.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `smithsonian_get_media`

**Description:** Returns all available images for a Smithsonian object at multiple resolutions. Only CC0 (open access) objects and their CC0-licensed images are returned — the tool explicitly reports when an object exists but its media is not open access. Each image includes high-res JPEG/TIFF URLs, screen-size and thumbnail URLs, pixel dimensions, and accessibility alt text. Intended for use with image-capable MCP clients that can display or analyze the photos.

**Input:**
- `id: string` — `record_id` of the object (e.g. `"nasm_A19670093000"`).

**Output:**
- `record_id`, `title`
- `is_cc0` — boolean, whether the object metadata is CC0
- `images[]` — per-image entries, each with:
  - `media_id` — IDS identifier
  - `is_cc0` — whether this specific image is CC0 (may differ from the object-level flag)
  - `alt_text` — accessibility text
  - `description` — extended accessibility description
  - `thumbnail_url` — `_thumb` URL (~120px)
  - `screen_url` — `_screen` URL (~800px)
  - `high_res_jpeg` — `{ url, width, height }` — full resolution JPEG when available
  - `high_res_tiff` — `{ url, width, height }` — archival TIFF when available

**Errors:**
- `not_found` (NotFound) — object not in catalog. Recovery: verify via `smithsonian_search`.
- `no_media` (NotFound) — object found but has no online media. Recovery: the physical object may not have been digitized.
- `not_cc0` (Forbidden) — object found with media, but none of the media is CC0. Recovery: use `smithsonian_search` with `filters.cc0_only: true` to find CC0 objects.
- `invalid_id` (InvalidParams) — ID format is clearly malformed.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

## Workflow Analysis

### `smithsonian_find_related` (4–5 upstream calls)

| # | Call | Purpose | Condition |
|:--|:-----|:--------|:----------|
| 1 | `GET /content/edanmdm:{id}` | Fetch anchor object metadata | always |
| 2 | `GET /search?q={culture}&fq=unit_code:*` | Fan-out search by culture | if `indexedStructured.culture` non-empty |
| 3 | `GET /search?q={maker}&rows=10` | Fan-out search by maker name | if maker names present |
| 4 | `GET /search?q={topic}&fq=type:edanmdm` | Fan-out search by topic term | if topics non-empty |
| 5 | `GET /search?q={period}+{object_type}` | Fan-out search by period + type | always |

Calls 2–5 use `Promise.allSettled` — one failed fan-out degrades gracefully. Results are deduped against the anchor ID and ranked by signal count.

---

## Design Decisions

### No IIIF — SI uses its own IDS

The idea doc referenced IIIF image manifests. Live probing shows the Smithsonian IDS (`ids.si.edu/ids/deliveryService`) does NOT serve IIIF manifests — it's a proprietary delivery service. Images are accessed via direct download URLs with size suffixes (`_thumb`, `_screen`, `.jpg`, `.tif`). The `smithsonian_get_media` tool exposes these URLs directly, which works well for image-capable MCP clients.

### `smithsonian_explore` is a search workflow, not a browse endpoint

The idea doc assumed a category browse endpoint. Live probing confirmed the `/terms` and `/category/search` endpoints return 404 — the open API does not expose category hierarchies. The `smithsonian_explore` tool constructs its overview by running a constrained `search` query using the mode as a filter field. This loses some richness (no true hierarchical browsing) but delivers the same agent goal: "show me what the Smithsonian has in category X."

### `smithsonian_get_media` is a separate tool, not merged into `smithsonian_get_object`

The object endpoint returns a `media_summary` (count, has_cc0, thumbnail). Full image arrays can be 15–20 images per object, each with 4 resolution variants — 300–500 lines of data in a typical object like the Amelia Earhart Vega. Separating media retrieval keeps `smithsonian_get_object` focused on provenance/catalog data and lets agents skip the image fetch for text-only research workflows.

### Rename from `smithsonian_get_image` to `smithsonian_get_media`

The idea doc used `smithsonian_get_image`. Renamed to `smithsonian_get_media` — the API technically supports Videos and 3D Images too (surfaced in `indexedStructured.online_media_type`), and the IDS returns multiple images per call. The current implementation focuses on Images; the name leaves room for future expansion without a breaking rename.

### `record_id` vs. `url` for IDs

The API response has two ID-like fields: `url` (e.g. `"edanmdm:nasm_A19670093000"`) and `content.descriptiveNonRepeating.record_ID` (e.g. `"nasm_A19670093000"`). The content endpoint accepts the full `edanmdm:` prefixed URL. The design uses `record_id` (the shorter form) as the identifier agents work with; the service layer prepends `edanmdm:` when calling the content endpoint. This matches the observable SI URL patterns (e.g., `si.edu/object/...:nasm_A19670093000`).

### No DataCanvas — direct paginated returns

An earlier iteration spilled large result sets to a DuckDB-backed DataCanvas (`rows > 20` routed the full page to a SQL-queryable table). It was removed: the result set is catalog object summaries capped at ≤100 rows, where the workflow is find-the-object-then-drill-in, not aggregate-over-rows — the wrong shape for SQL, and `smithsonian_explore` already covers the cross-museum breakdown case. `smithsonian_search` now returns up to `rows` (≤100) summaries directly; page through larger result sets with `start` + `rows`.

### CC0 gating is object-level AND image-level

The catalog has two distinct CC0 flags:
1. `content.descriptiveNonRepeating.metadata_usage.access` — the object *metadata* license
2. Per-image `media[].usage.access` — each image's individual license

In practice they agree, but the design checks both. `smithsonian_get_media` surfaces `is_cc0` on both the object and each individual image. An object can be CC0 metadata but have some restricted images (or vice versa).

---

## Known Limitations

- **No category browse endpoint**: The open API doesn't expose `/terms` or `/category/search`. `smithsonian_explore` works around this via constrained search but can't return true hierarchical category trees.
- **Filter values require prior knowledge**: Filters like `unit_code`, `object_type`, `culture` accept arbitrary strings but there's no discovery endpoint to list valid values. The design notes this in parameter descriptions and points agents to search first to discover real values.
- **Rate limits**: The free api.data.gov tier has ~1,000 req/hr. The `smithsonian_find_related` workflow makes 5 calls; a session of 50 related searches could hit the hourly limit. The service layer must implement backoff on 429.
- **Objects without media**: A significant portion of catalog objects have no digitized media — `smithsonian_get_media` returns `no_media` for these.
- **EDAN content type variety**: Not all records are `type: edanmdm`. The catalog also has `type: ead_component`, `edanmdm`, library records, etc. The design targets `edanmdm` type records (the museum objects), but some search results may be library records with different field structures. The service normalizer should handle sparse/absent fields gracefully.

---

## API Reference

### Endpoints

| Endpoint | Method | Used By |
|:---------|:-------|:--------|
| `/search` | GET | `smithsonian_search`, `smithsonian_explore`, `smithsonian_find_related` |
| `/content/{id}` | GET | `smithsonian_get_object`, `smithsonian_get_media`, `smithsonian_find_related` |

### Search parameters

| Param | Type | Notes |
|:------|:-----|:------|
| `q` | string | Full-text query |
| `rows` | number | Page size (max 100) |
| `start` | number | Offset (0-indexed) |
| `fq` | string | Filter query, e.g. `fq=unit_code:NASM`, `fq=media_usage:CC0`, `fq=online_media_type:Images` |
| `api_key` | string | Required — from api.data.gov |

### Search response shape

```json
{
  "status": 200,
  "responseCode": 1,
  "response": {
    "rows": [
      {
        "id": "ld1-...",
        "title": "Lockheed Vega 5B, Amelia Earhart",
        "unitCode": "NASM",
        "type": "edanmdm",
        "url": "edanmdm:nasm_A19670093000",
        "content": {
          "freetext": { "notes": [{...}], "name": [{...}], "date": [{...}], ... },
          "indexedStructured": { "date": [...], "name": [...], "object_type": [...], "culture": [...], ... },
          "descriptiveNonRepeating": {
            "record_ID": "nasm_A19670093000",
            "unit_code": "NASM",
            "data_source": "National Air and Space Museum",
            "record_link": "http://n2t.net/ark:/65665/...",
            "metadata_usage": { "access": "CC0" },
            "online_media": {
              "media": [...],
              "mediaCount": 19
            }
          }
        }
      }
    ],
    "rowCount": 215,
    "message": "content found"
  }
}
```

### Content endpoint response shape (`/content/{id}`)

The content endpoint wraps the object differently than search — the object is directly at `response`, not at `response.rows[0]`. The service normalizer must handle both envelopes:

```json
{
  "status": 200,
  "responseCode": 1,
  "response": {
    "id": "ld1-...",
    "title": "Lockheed Vega 5B, Amelia Earhart",
    "unitCode": "NASM",
    "type": "edanmdm",
    "url": "edanmdm:nasm_A19670093000",
    "content": {
      "freetext": { "notes": [...], "name": [...], "date": [...] },
      "indexedStructured": { "date": [...], "name": [...], "object_type": [...], "culture": [...] },
      "descriptiveNonRepeating": {
        "record_ID": "nasm_A19670093000",
        "unit_code": "NASM",
        "data_source": "National Air and Space Museum",
        "record_link": "http://n2t.net/ark:/65665/...",
        "metadata_usage": { "access": "CC0" },
        "online_media": { "media": [...], "mediaCount": 19 }
      }
    }
  }
}
```

Key difference from search: the item object is `response` (not `response.rows[0]`). The `content` block structure is identical between the two endpoints.

### Media item shape (within `online_media.media[]`)

```json
{
  "id": "media:NASM-A19670093000-NASM2018-10363-000001",
  "idsId": "NASM-A19670093000-NASM2018-10363-000001",
  "type": "Images",
  "usage": { "access": "CC0" },
  "content": "https://ids.si.edu/ids/deliveryService?id=...",
  "thumbnail": "https://ids.si.edu/ids/deliveryService?id=...",
  "altTextAccessibility": "...",
  "extDescrAccessibility": "...",
  "resources": [
    { "label": "High-resolution TIFF", "url": "https://ids.si.edu/ids/download?id=....tif", "width": 8688, "height": 5792, "dimensions": "8688x5792" },
    { "label": "High-resolution JPEG", "url": "https://ids.si.edu/ids/download?id=....jpg", "width": 8688, "height": 5792, "dimensions": "8688x5792" },
    { "label": "Screen Image", "url": "https://ids.si.edu/ids/download?id=...._screen" },
    { "label": "Thumbnail Image", "url": "https://ids.si.edu/ids/download?id=...._thumb" }
  ]
}
```

### Error shape (key missing)

```json
{ "error": { "code": "API_KEY_MISSING", "message": "No api_key was supplied. Get one at https://api.si.edu:443" } }
```

### Error shape (rate limited)

```json
{ "error": { "code": "OVER_RATE_LIMIT", "message": "You have exceeded your rate limit. Try again later or contact us at https://api.si.edu:443/contact/ for assistance" } }
```

### Unit codes (major museums)

| Code | Museum |
|:-----|:-------|
| NASM | National Air and Space Museum |
| NMNH | National Museum of Natural History |
| SAAM | Smithsonian American Art Museum |
| NMAH | National Museum of American History |
| NMAAHC | National Museum of African American History and Culture |
| NMAI | National Museum of the American Indian |
| NMAfA | National Museum of African Art |
| NPG | National Portrait Gallery |
| CHNDM | Cooper Hewitt, Smithsonian Design Museum |
| HMSG | Hirshhorn Museum and Sculpture Garden |
| FSG | Freer Gallery of Art and Arthur M. Sackler Gallery |
| NPM | National Postal Museum |
| ACM | Anacostia Community Museum |
| NZP | National Zoo & Conservation Biology Institute |
| SIL | Smithsonian Libraries and Archives |
| AAA | Archives of American Art |

### Resilience

- **Error-in-200 responses**: The API returns HTTP 200 with `{ "error": { "code": "...", "message": "..." } }` in the body for `API_KEY_MISSING` and `OVER_RATE_LIMIT` — HTTP status alone is insufficient. The service normalizer must check for `response.error` before treating a 200 as success. `API_KEY_MISSING` should surface as a `ConfigurationError` (server misconfiguration, not a retryable condition). `OVER_RATE_LIMIT` maps to 429 retry logic.
- Retry on 429 (`OVER_RATE_LIMIT`) with exponential backoff (base 2s, max 3 retries)
- Retry on 503 with backoff (1s base, 2 retries)
- `fetchWithTimeout` handles non-OK HTTP status → `ServiceUnavailable` automatically; the service layer adds the error-in-200 check on top
- `api_key` injected by service, never exposed in error messages
