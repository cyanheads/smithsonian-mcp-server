# smithsonian-mcp-server — Design

## API key

`SMITHSONIAN_API_KEY` is required: the Smithsonian Open Access API has no keyless access, and a request without a key returns `{"error": {"code": "API_KEY_MISSING", ...}}`. The key is free and issued instantly at [https://api.data.gov/signup](https://api.data.gov/signup), and allows 1,000 requests per hour.

---

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations | Errors |
|:-----|:------------|:-----------|:------------|:-------|
| `smithsonian_search_objects` | Full-text search across 14.5M objects with exact filters. Returns curated summaries, thumbnails, and total count. | `query`, `filters` (unit_code, object_type, date, culture, place, topic, name, scientific_name, online_media_type, online_only, cc0_only), `rows`, `start` | `readOnlyHint: true`, `openWorldHint: true` | `no_results` (NotFound), `invalid_filter` (ValidationError) |
| `smithsonian_list_terms` | Enumerate the valid term vocabulary for an indexed filter field. Controlled-vocabulary terms are often plural or qualified, so drawing filter values from here avoids empty results. Returns one page of the field's distinct terms, plus a `labels` map of museum names for `unit_code`; `contains` narrows the vocabulary by a case-insensitive substring, matching the museum name as well as the code for `unit_code`. Each field's vocabulary is cached (`SMITHSONIAN_TERMS_CACHE_TTL_SECONDS`) since upstream returns the whole set on every call. | `field` (unit_code, culture, place, date, online_media_type, topic), `contains`, `start`, `rows` | `readOnlyHint: true`, `openWorldHint: true` | `no_terms` (NotFound) |
| `smithsonian_get_object` | Normalized metadata by ID, including labeled notes, scientific names, reported taxonomy/coordinates, and a media summary. | `id` | `readOnlyHint: true`, `openWorldHint: true` | `not_found` (NotFound), `invalid_id` (ValidationError) |
| `smithsonian_browse_category` | Paginated browse within one exact category. Mode: `museum` \| `culture` \| `period` \| `medium` \| `topic`; `value` must be an exact indexed category term, not free text. Searches a constrained query internally and returns the category total, a page of matching objects, and a museum breakdown of that page. | `mode`, `value`, `rows`, `start` | `readOnlyHint: true`, `openWorldHint: true` | `invalid_category` (ValidationError) |
| `smithsonian_find_related` | Given an object ID, finds related items across collections by matching the anchor's metadata signals (culture, period, object_type, named party, topics). Returns a page of related objects (default 10), each tagged with the signals that connected it. | `id`, `limit`, `start` | `readOnlyHint: true`, `openWorldHint: true` | `not_found` (NotFound), `invalid_id` (ValidationError) |
| `smithsonian_get_media` | Returns CC0 image URLs at multiple resolutions for an object. Filters by each image's license and reports the object metadata license separately. Includes alt text and accessibility descriptions from the catalog. | `id` | `readOnlyHint: true`, `openWorldHint: true` | `not_found` (NotFound), `no_media` (NotFound), `no_images` (NotFound), `not_cc0` (Forbidden), `invalid_id` (ValidationError) |

### Resources

None. The Smithsonian catalog is too dynamic and the IDs too opaque to benefit from stable URI injection. All access flows through tools.

### Prompts

None. This is a pure data-access server.

---

## Overview

Smithsonian Open Access MCP server wrapping the Smithsonian Institution's EDAN (Enterprise Digital Asset Network) Open Access API. Exposes 14.5 million objects across 20+ museums and research centers — art, natural history specimens, aerospace artifacts, American history, African American culture, Indigenous collections, scientific instruments, photography, and library materials.

The server earns standalone status: single-source, but with massive cross-collection coverage, deep catalog metadata, high-resolution CC0 imagery, and a query surface that rewards LLM-driven discovery.

## Requirements

- `SMITHSONIAN_API_KEY` is **required** — free from [https://api.data.gov/signup](https://api.data.gov/signup). Server startup fails with a clear `ConfigurationError` when absent.
- Rate limit: `api_key` from api.data.gov has standard limits (~1,000 req/hr for free tier). DEMO_KEY is ~5 req/min — not suitable for production.
- API endpoint: `https://api.si.edu/openaccess/api/v1.0/`
- Object IDs are prefixed: `edanmdm:{record_ID}` — e.g. `edanmdm:nasm_A19670093000`. The `record_ID` field in `content.descriptiveNonRepeating` is the stable identifier.
- CC0 delivery gates on each image's `media[].usage.access === 'CC0'`; `content.descriptiveNonRepeating.metadata_usage.access` reports the object metadata license separately.
- Images are served by the Smithsonian IDS (Image Delivery Service) at `ids.si.edu`. **No IIIF manifests** — the IDS uses direct download URLs with `_screen`, `_thumb`, and high-res TIFF/JPEG variants.
- Read-only throughout.

## Domain Mapping

| Noun | Operations |
|:-----|:-----------|
| Object | search (by text + filters), get (by ID), browse (by exact category), find-related (by metadata similarity) |
| Media | get-images (by object ID, CC0 only) |

The `smithsonian_browse_category` tool is a workflow over the `search` operation: it constructs a category-constrained search and returns an enriched overview rather than exposing a separate browse API endpoint (which doesn't exist in the open API).

`smithsonian_find_related` is a multi-step workflow: fetch anchor object → extract metadata signals → fan-out searches → deduplicate and interleave.

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `SmithsonianService` | Smithsonian EDAN Open Access API | All tools |

Single service — one API, one base URL, one auth pattern. Two primary methods internally: `search(params)` and `getContent(id)`. The service handles `api_key` injection, retry/backoff, response normalization, an in-process response cache, and the optional Open Access mirror (see [Open Access mirror](#open-access-mirror)).

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `SMITHSONIAN_API_KEY` | **Yes** | API key from https://api.data.gov/signup. Server fails to start without it. |
| `SMITHSONIAN_BASE_URL` | No | Override the API base URL (default: `https://api.si.edu/openaccess/api/v1.0`). |
| `SMITHSONIAN_TERMS_CACHE_TTL_SECONDS` | No | Seconds each field's term vocabulary is cached in the `StorageService` (default: `3600`). `/terms/{field}` ignores paging and always returns the whole vocabulary — `place` alone is ~114k terms — so every uncached call re-downloads it. `0` disables caching. |
| `SMITHSONIAN_SEARCH_CACHE_TTL_SECONDS` | No | Seconds each normalized `/search` page is cached in memory, keyed by request URL (default: `3600`). `0` disables the cache and the sharing of concurrent identical requests. |
| `SMITHSONIAN_CONTENT_CACHE_TTL_SECONDS` | No | Seconds each `/content` record is cached in memory, keyed by request URL (default: `86400`). `0` disables the cache and the sharing of concurrent identical requests. |
| `SMITHSONIAN_CLAMP_LIMITS` | No | Default `true`: an over-cap `rows` or `limit` is served at its cap with a notice. `false` rejects it and advertises each cap as the schema `maximum`. |
| `SMITHSONIAN_MIRROR_PATH` | No | SQLite file path of the Open Access mirror. Empty or unset turns the mirror off (the default). |
| `SMITHSONIAN_MIRROR_REFRESH_CRON` | No | Cron expression, in server local time, on which an HTTP server refreshes the mirror (default: `0 12 * * *`). Empty turns the in-server refresh off. Validated at startup when the mirror is on. |

The mirror variables stay out of `server.json` and `manifest.json`: the mirror is an operator feature for self-hosted HTTP deployments, not part of the one-click install.

## Implementation Order

1. Config (`src/config/server-config.ts`) — `SMITHSONIAN_API_KEY`, base URL. Hard-fail on missing key.
2. `SmithsonianService` — `search()` + `getContent()` with retry/backoff, URL construction, API key injection, response normalization helpers (flatten `freetext[]` label-content arrays, extract media, check CC0).
3. `smithsonian_search_objects` — search returning up to `rows` (≤1,000) curated summaries with offset pagination.
4. `smithsonian_get_object` — single content fetch with full field normalization.
5. `smithsonian_get_media` — extract and gate images from a fetched object.
6. `smithsonian_browse_category` — mode-dispatch to constrained searches.
7. `smithsonian_find_related` — multi-search fan-out.

Each step is independently testable.

---

## Tool Detail

### `smithsonian_search_objects`

**Description:** Search across 14.5 million Smithsonian objects by text query and optional filters. Filters narrow by museum unit, object type, indexed date term, culture, geographic place, subject topic, named party, and online/CC0 availability. Returns curated summaries (title, date, museum, thumbnail URL, CC0 flag) with the total match count. The `record_id` in each result is the identifier for `smithsonian_get_object` and `smithsonian_find_related`.

**Input:**
- `query: string` — Free-text search. Required. Use specific terms for precision (`"Tlingit totem pole"`) or broad terms for browsing (`"quilt"`). Filters append hard `AND` constraints; plain words and quoted phrases remain ungrouped because EDAN changes implicit matching inside parentheses. Active Lucene expressions are grouped to preserve Boolean precedence; quoted and escaped punctuation stays literal.
- `filters?: object` — Optional structured filters. The object is strict: an unknown key is rejected by name as a schema validation error, so a misspelled filter fails loudly instead of widening the search.
  - `online_media_type?: string` — exact indexed category from `smithsonian_list_terms { field: "online_media_type" }`, such as Images, 3D Models, or Sound recordings. Quoted and escaped as a hard constraint, composing with availability filters. Invalid terms follow vocabulary-aware `invalid_filter` recovery; valid terms with no overlap are identified as exact. An Images match does not guarantee attached/CC0 images; read `get_object.media_summary`. Media terms feed search only, with no browse mode.
  - `scientific_name?: string` — exact value from `smithsonian_get_object.scientific_names`, quoted and escaped as a hard constraint. Not enumerable through `smithsonian_list_terms`; filtered-zero recovery names the object field as the source.
  - `unit_code?: string` — museum unit code (e.g. `"NASM"`, `"SAAM"`). Natural History is indexed under discipline sub-units (`"NMNHBIRDS"`, `"NMNHPALEO"`), not a bare `"NMNH"`. Matched exactly and case-sensitively (`"NMAfA"` carries a lowercase f); `smithsonian_list_terms` with `field: "unit_code"` enumerates the live vocabulary.
  - `object_type?: string` — object type term from `indexedStructured.object_type` (e.g. `"Paintings"`, `"Photographs"`, `"Aircraft"`).
  - `date?: string` — indexed date term from `indexedStructured.date`. Commonly a decade (`"1920s"`, `"1960s"`), but the vocabulary also carries year ranges (`"500-1500"`), century terms (`"21st century"`), and BCE forms (`"-2500"`, `"BCE 1000s"`) — 128 of the 201 indexed terms are not decade-shaped, so no shape gate is applied.
  - `culture?: string` — culture term from `indexedStructured.culture` (e.g. `"Plains Indian"`).
  - `place?: string` — geographic place from `indexedStructured.place` (e.g. `"United States of America"`).
  - `topic?: string` — subject term from `indexedStructured.topic` (e.g. `"Quilts"`, `"Aviation"`), the same vocabulary `smithsonian_get_object` returns as `topics[]`. Enumerable via `smithsonian_list_terms` (133,113 terms). A hard constraint: `topic:"Quilts"` matches 1,134 objects where the bare word as free text matches 2,677.
  - `name?: string` — indexed named party from `indexedStructured.name` (e.g. `"Warhol, Andy"`), covering every role the catalog records — maker, collector, donor, issuing authority. Written surname-first. Not enumerable via `smithsonian_list_terms`. A `smithsonian_find_related` name signal carries the indexed form verbatim and is the reliable source; `smithsonian_get_object`'s `makers[]` reads the free-text block, which names the same parties in a different form often enough to miss (`"Major J. A. L. Möller (Jacob A.L. Möller/Monty Möller), Non-Indian, 1883-1957"` for the indexed `"Möller, Major J. A. L."`), so it is a starting guess rather than an exact value. Also a hard constraint: `name:"Warhol, Andy"` matches 421 against 715 for the same string as free text. Added so `smithsonian_find_related`'s indexed-name fan-out has a reproducible `search_continuation`.
  - `online_only?: boolean` — when true, ANDs the Lucene term `online_media_type:*` into `q` to restrict to records carrying an indexed `online_media_type` value. That vocabulary covers digitized surrogates (finding aids, catalog cards, scanned books, full text, electronic resources) alongside images, 3D models, and video; the surrogate types often have no deliverable media attached, so a match can still report `has_media: false`. `has_media` reads `descriptiveNonRepeating.online_media` — a separate upstream signal — and is what predicts a `smithsonian_get_media` outcome.
  - `cc0_only?: boolean` — when true, ANDs the Lucene term `media_usage:CC0` into `q`. That term marks a record as *having CC0 media attached*, not as being CC0-licensed, so this selects on media presence rather than license: of 14.5M records, 5.25M carry the term and the 9.24M excluded are CC0 too, just undigitized. `has_media` remains the signal that predicts a `smithsonian_get_media` outcome.
- `rows?: number` — page size (default 20, cap 1,000, EDAN's own `/search` maximum). A larger value is served at the cap and the `notice` opens with "rows N exceeds the cap of 1000; the page was served with rows 1000."; with `SMITHSONIAN_CLAMP_LIMITS=false` it is rejected and the schema advertises `maximum: 1000`.
- `start?: number` — offset for pagination (default 0). A `start` past the end returns a successful empty page, not an error.

**Output:**
- `objects[]` — curated summaries: `{ record_id, title, date, unit_code, museum_name, holding_museum_name?, object_type, thumbnail_url, is_cc0, has_media }`. `unit_code` is the code the record is indexed under (top-level `unitCode`, falling back to `descriptiveNonRepeating.unit_code`); `holding_museum_name` is read from `descriptiveNonRepeating.data_source` and set only when the record's own code differs from the indexed one, as for the `OCIO_DPO3D` 3D scans, which are indexed under the digitization office while `data_source` names the holder. The record's own code is not reported because EDAN often does not index it, so it would hand the caller a filter that matches nothing. Empty on a page past the end of the result set.
- `total_count` — total matching objects before pagination.
- Enrichment: `truncated` / `shown` / `cap` / `truncationCeiling` / `notice` — `truncated` fires only when objects remain past this page (`start + shown < total_count`), so a terminal or past-the-end page reports nothing withheld; `notice` names the next `start` outright (a clamped page makes `start = page × rows` skip data). With a mirror configured, `sources` / `mirror_snapshot` (see [Open Access mirror](#open-access-mirror)).

**Errors:**
- `no_results` (NotFound) — an unfiltered query matches nothing at all (`rowCount === 0`). Recovery: broaden the query or check spelling. Deliberately keyed to the true match count rather than the page-local length, so a deep `start` against a query with real matches is never told to check its spelling.
- `invalid_filter` (ValidationError) — a filtered search matched nothing, most often a filter value outside the Smithsonian controlled vocabulary (e.g. singular `"Painting"` instead of `"Paintings"`). Recovery: a culture/place/date/topic value is checked against its vocabulary first, and the hint branches on the answer — a value outside it routes to `smithsonian_list_terms { field, contains: <value> }`, while a value the index already enumerates is named as exact (resolving it returns the same value) and the caller is told to drop it or pick a different term. For object_type/unit_code, exact co-occurring values are harvested into the hint, but only for a non-blank query: with a blank or whitespace-only query the re-query has nothing to sample against and EDAN answers its empty `q` with a 400, so the harvest is skipped and the hint stays static. `name` gets neither — it is not enumerable upstream and not carried in result summaries — so it falls to the static hint, which routes to a `smithsonian_find_related` name signal for the indexed form and flags `makers[]` as the free-text approximation. Then retry with an exact term.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `smithsonian_get_object`

**Description:** Fetch a normalized catalog metadata projection for a Smithsonian object by its `record_id` (from `smithsonian_search_objects` results). Returns the exposed catalog fields: title, dates, description, makers, materials, dimensions, place and culture associations, topics, exhibition history, credit line, accession identifiers, rights statement, and a curated media summary (count, CC0 status, thumbnail). The `record_id` uses the format returned by search — do not manually construct IDs.

**Input:**
- `id: string` — Object `record_id` as returned by `smithsonian_search_objects` (e.g. `"nasm_A19670093000"`). The service prepends `edanmdm:` automatically.

**Output:**
- `record_id`, `title`, `unit_code` (the code the record is indexed under), `museum_name`, `holding_museum_name?` (the holder, when it differs from `unit_code`; rendered as `Held by` in the text output)
- `dates[]` — all labeled date fields (Date, Accession Date, etc.)
- `description` — optional prose from Summary, Physical Description, then Brief Description matching labels; followed by exact Description, Description (Brief), then Citation labels. Administrative notes never become descriptions.
- `notes[]` — every nonempty note as `{ label, content }` in source order, preserving repeated labels and using `Note` when the label is absent. Selected prose and notes use the shared decode-once plain-text projection.
- `scientific_names[]` — all `indexedStructured.scientific_name` values, preserving order without selecting an accepted name. Search accepts these as exact `filters.scientific_name` constraints with quote/backslash escaping; filtered-zero recovery names this source rather than `list_terms`.
- `taxonomy?` — reported `tax_kingdom`, `tax_phylum`, `tax_class`, `tax_order`, and `tax_family` arrays under their rank names; absent ranks remain omitted.
- `coordinates[]` — valid decimal `geoLocation[].points.point` latitude/longitude pairs with only the same entry's `Other` locality. Blank, non-decimal, incomplete, non-finite, or out-of-range pairs are omitted; valid zero survives. No coordinate accuracy or geocoding is inferred.
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
- `media_summary` — `{ count, cc0_image_count, has_cc0_images, thumbnail_url, non_image_media[] }` — `count` is the raw total across all media types (images, 3D models, video); `cc0_image_count` is what `smithsonian_get_media` returns, so the two reconcile. `non_image_media[]` holds `{ type, url?, is_cc0 }` for every media item typed as something other than Images, in catalog order, so images and non-image items together partition the record's media; the text output renders each as `- [<type>](<url>) · CC0: Yes|No`. Call `smithsonian_get_media` for the full image list
- With a mirror configured: `sources`, `mirror_snapshot` (see [Open Access mirror](#open-access-mirror))

**Errors:**
- `not_found` (NotFound) — no object with that ID in the catalog. Recovery: verify the ID via `smithsonian_search_objects`.
- `invalid_id` (ValidationError) — ID format is clearly malformed. Recovery: use `record_id` values from `smithsonian_search_objects` results directly.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `smithsonian_browse_category`

**Description:** Browse Smithsonian objects within one exact category. Returns the category total count, the requested page of matching objects, and a breakdown of which museums those page objects come from. Five browse modes: `museum` (by unit code), `culture` (by culture term), `period` (by indexed date term, e.g. "1920s" or "500-1500"), `medium` (by object type), `topic` (by subject term). Every mode matches an exact indexed facet value — `smithsonian_search_objects` is the entry point for open-ended discovery, and `smithsonian_list_terms` is the preparation step that resolves museum, culture, date, and topic vocabulary.

**Input:**
- `mode: "museum" | "culture" | "period" | "medium" | "topic"` — browse dimension.
- `value: string` — category value appropriate to the mode:
  - `museum`: unit code (`"NASM"`, `"NMNHBIRDS"`), applied verbatim as a `unit_code` filter — matched exactly and case-sensitively, never as a museum name
  - `culture`: culture term (`"Aztec"`, `"Sioux"`, `"Japanese"`)
  - `period`: indexed date term (`"1940s"`, `"500-1500"`, `"21st century"`, `"-2500"`) — no shape gate, since most of the indexed `date` vocabulary is not decade-shaped
  - `medium`: object type, usually plural (`"Paintings"`, `"Aircraft"`)
  - `topic`: subject term (`"Quilts"`, `"Aviation"`) from the 133k-term `topic` vocabulary
- `rows?: number` — sample objects to return (default 10, cap 1,000; served at the cap with a notice, like search).
- `start?: number` — pagination offset into the category's match set (default 0, 0-indexed). Page contiguously by advancing `start` by the number of objects returned (the notice names it); the category query and upstream ordering are identical across pages, so adjacent pages reconstruct the full set gap-free. A `start` past the end returns a successful empty page, not an error.

**Output:**
- `mode`, `value`, `total_count` — how many objects match
- `sample_objects[]` — the requested page: `{ record_id, title, unit_code, thumbnail_url, is_cc0 }`
- `museum_breakdown[]` — when mode is not `museum`, top 5 contributing units with counts, computed from the current page (helps plan museum-focused follow-up searches)
- Enrichment: `truncated` / `shown` / `cap` / `truncationCeiling` / `notice` — `truncated` fires only when objects remain past this page (`start + shown < total_count`), so a terminal or past-the-end page reports nothing withheld; `notice` names the next `start` outright, after the clamp sentence when `rows` exceeded the cap. With a mirror configured, `sources` / `mirror_snapshot`

**Errors:**
- `invalid_category` (ValidationError) — the category matches nothing at all (`rowCount === 0`). A browse category is an exact indexed facet, so a zero match means the supplied value did not resolve to retrievable objects, not that an object is missing. Recovery is mode-specific and names the literal next call. For `museum` / `culture` / `period` / `topic` the value is first checked against its vocabulary: outside it, the hint routes to `smithsonian_list_terms { field, contains: value }` (for `unit_code` that call matches museum names as well as codes, so a museum name resolves through it too); inside it — 14 of the 48 unit codes and a long tail of culture terms are indexed with zero objects — the hint says so and routes to a different term or a `smithsonian_search_objects` free-text query, since resolving the value returns it verbatim and loops the caller through the same failure. `medium` gets no vocabulary check (`object_type` is not enumerable upstream); it names the `object_type` values harvested from re-running the value as a free-text search, falling back to routing the caller to that search when the harvest is empty. Candidates are listed, never auto-selected. Not raised for a `start` past the end of a real category, which is normal pagination completion.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `smithsonian_find_related`

**Description:** Discover objects across Smithsonian collections related to a given anchor object, matched on shared metadata signals — culture, period, object type, named parties, and topic terms. Each related object is tagged with the signals that connected it to the anchor. Cross-museum discovery is the differentiator — the anchor may be NASM aerospace, but related objects span NMNH, SAAM, and NMAH.

**Signal construction:** four fan-out slots, built in a fixed order and interleaved round-robin — culture, named party, topic, period+type.

- **Culture** — `culture:` filter on `indexedStructured.culture[0]`.
- **Named party** — one slot, sourced in preference order. `indexedStructured.name[0]` when the record has one, as a hard `name:` filter labeled `name` (bibliographic and authority records wrap the entry as `{ content, type }` or `{ content, VIAF }` instead of a bare string — the value is read from `content` either way); otherwise the first `freetext.name[]` entry whose value isn't already the culture filter's, labeled from that entry's own `label` lowercased (`collector`, `donor`, `issuing authority`, `culture/people`). EDAN uses the freetext block for any named party and maker is a minority of them, so a fixed `maker` label asserted a relationship the catalog never made. The two blocks have no positional correspondence and no shared formatting — a record with three freetext entries can index one name, drawn from a different entry and written differently — so no pairing between them is attempted. When every candidate repeats the culture value the slot goes unused rather than re-running that value as a looser free-text query.
- **Topic** — `topic:` filter on `indexedStructured.topic[0]`. A hard facet, not free text: `topic:"Quilts"` matches 1,134 against 2,677 for the bare word.
- **Period + type** — `date:` and `object_type:` filters combined into one fan-out.

**Input:**
- `id: string` — `record_id` of the anchor object (from `smithsonian_search_objects` or `smithsonian_get_object`).
- `limit?: number` — max related objects to return (default 10, cap 1,000; served at the cap with a notice).
- `start?: number` — pagination offset into the interleaved related-object sequence (default 0). Page contiguously by advancing `start` by the number of objects returned (the notice names it): page N+1 continues where page N ended. Each contributing signal is reachable to a depth of 5,000 objects, fetched from upstream in ≤1,000-row chunks. Near a seam a bounded number of objects (up to the active-signal count) can shift by one page, since a deeper page fetches more per signal and may reallocate an object that ranks very differently across signals. Beyond 5,000 matches for a signal, `truncated` stays true but deeper pages aren't reachable.

**Output:**
- `anchor` — summary of the anchor object (`{ record_id, title, unit_code }`)
- `related[]` — `{ record_id, title, unit_code, museum_name, holding_museum_name?, thumbnail_url, is_cc0, similarity_signals[] }` where `similarity_signals` is a string array of **every** metadata term that connected this object (an object surfaced by multiple fan-out signals carries all of them, e.g. `["culture: Plains Indian", "topic: Basketry"]`)
- `search_signals_used[]` — which metadata fields drove the fan-out searches
- With a mirror configured: `sources`, `mirror_snapshot` (see [Open Access mirror](#open-access-mirror)); the anchor read can come from the mirror while the signal searches stay live
- `signals[]` — per-signal breakdown of every fan-out that returned: `{ signal, row_count, search_continuation }`. `row_count` is the signal's true upstream match count, uncapped — unlike `truncationCeiling` it is not clamped to the 5,000 per-signal reach, so the two disagree exactly when a signal is broader than this tool can page. `search_continuation` is the `smithsonian_search_objects` input (`{ query, filters? }`) that reproduces that fan-out's query exactly, and `smithsonian_search_objects` applies `start` straight to the upstream offset with no depth cap — so it is the retrieval path for everything past the 5,000 reach. A fan-out whose upstream call failed is omitted (it has no known row count); `search_signals_used` still lists it.
- `notice` — composes the clamp sentence (when `limit` exceeded its cap), safe partial-failure categories and failed-signal labels (escaped for the rendered Markdown), and empty-result and paging guidance, which names the next `start`, on both wire surfaces. No signals, no non-anchor matches, partial empty results, and exhausted pages have distinct guidance. A later-chunk failure drops the entire signal to avoid a gap; if every attempted signal fails, the first failure in signal order is thrown. Caller cancellation rejects even after a successful signal.
- Enrichment: `truncated` / `shown` / `cap` / `truncationCeiling` / `notice` disclose when related objects were omitted — capped by `limit` or more matches available upstream (page with `start`); `truncationCeiling` is an upper bound on the *reachable* related pool — each signal's upstream match count is capped at its per-signal reach (5,000) before summing, so the ceiling never exceeds what `start` can retrieve. `notice` names both continuation tiers: `start` for the next page, `signals[].search_continuation` for a signal past the reach.

**Errors:**
- `not_found` (NotFound) — anchor object not found. Recovery: verify the ID via `smithsonian_search_objects`.
- `invalid_id` (ValidationError) — ID format is clearly malformed.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `smithsonian_get_media`

**Description:** Returns CC0-licensed images for a Smithsonian object at multiple resolutions, reporting the object metadata license separately. The tool never returns an empty `images[]` — each way an object can yield no images (nothing digitized, media that is entirely non-image, images that are entirely non-CC0) has its own declared error reason. Each image includes high-res JPEG/TIFF URLs, screen-size and thumbnail URLs, pixel dimensions, and accessibility alt text. Intended for use with image-capable MCP clients that can display or analyze the photos.

**Input:**
- `id: string` — `record_id` of the object (e.g. `"nasm_A19670093000"`).

**Output:**
- `record_id`, `title`
- `is_cc0` — boolean, whether the object metadata is CC0
- With a mirror configured: `sources`, `mirror_snapshot` (see [Open Access mirror](#open-access-mirror))
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
- `not_found` (NotFound) — object not in catalog. Recovery: verify via `smithsonian_search_objects`.
- `no_media` (NotFound) — object found but has no online media. Recovery: the physical object may not have been digitized.
- `no_images` (NotFound) — object found with media, but all of it is non-image (scanned books, 3D models, sound recordings). Recovery: the hint names the media types present and points at `smithsonian_get_object`'s `media_summary.non_image_media`, which links each item.
- `not_cc0` (Forbidden) — object found with images, but none of them is CC0. Recovery: use `smithsonian_search_objects` with `filters.cc0_only: true` to find CC0 objects.
- `invalid_id` (ValidationError) — ID format is clearly malformed.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

## Workflow Analysis

### `smithsonian_find_related` (5+ upstream calls)

| # | Call | Purpose | Condition |
|:--|:-----|:--------|:----------|
| 1 | `GET /content/edanmdm:{id}` | Fetch anchor object metadata | always |
| 2 | `GET /search?q=culture:{culture}&start=0…` | Fan-out by culture, chunked to depth `min(start+limit, 5000)` | if `indexedStructured.culture` non-empty |
| 3 | `GET /search?q=name:{name}&start=0…` (or `q={freetext name}`) | Fan-out by named party, same chunked depth | if a named-party candidate survives the culture-duplicate check |
| 4 | `GET /search?q=topic:{topic}&start=0…` | Fan-out by topic term, same chunked depth | if `indexedStructured.topic` non-empty |
| 5 | `GET /search?q={period}+{object_type}&start=0…` | Fan-out by period + type, same chunked depth | if period or object type is present |

Calls 2–5 use `Promise.allSettled` — one failed fan-out degrades gracefully. Each signal is fetched from the top (`start=0`) to a depth of `min(start + limit, 5000)`, split into chunks of at most 1,000 rows (the hard upstream `rows` ceiling — a single call requesting more silently collapses to a 10-row page). The first chunk is a single call that also reveals the signal's real match count; deeper chunks (`start=1000, 2000, …`) fire in parallel and only when both the requested depth and the real total exceed one chunk, so a shallow page costs exactly one call per signal. Results are deduped against the anchor ID and interleaved round-robin so each fan-out signal contributes, accumulating every signal that surfaced an object. The `start` offset is then applied to the merged interleave (not the upstream query), so pages are contiguous — page N+1 continues where page N ended. (Because a deeper page fetches more rows per signal, an object that ranks very differently across signals can be reallocated to a different bucket, shifting a bounded number of objects — up to the active-signal count — by one page near a seam.) When the interleave extends past the page or a signal reports more matches than were fetched, the response discloses `truncated` with a `truncationCeiling` (each signal's count capped at the 5,000 reach before summing); advancing `start` retrieves the next window, up to the per-signal cap.

---

## Design Decisions

### No IIIF — SI uses its own IDS

The idea doc referenced IIIF image manifests. Live probing shows the Smithsonian IDS (`ids.si.edu/ids/deliveryService`) does NOT serve IIIF manifests — it's a proprietary delivery service. Images are accessed via direct download URLs with size suffixes (`_thumb`, `_screen`, `.jpg`, `.tif`). The `smithsonian_get_media` tool exposes these URLs directly, which works well for image-capable MCP clients.

### `smithsonian_browse_category` is a search workflow, not a browse endpoint

The idea doc assumed a category browse endpoint. Live probing confirmed the `/terms` and `/category/search` endpoints return 404 — the open API does not expose category hierarchies. The `smithsonian_browse_category` tool constructs its overview by running a constrained `search` query using the mode as a filter field. This loses some richness (no true hierarchical browsing) but delivers the same agent goal: "show me what the Smithsonian has in category X."

### `smithsonian_get_media` is a separate tool, not merged into `smithsonian_get_object`

The object endpoint returns a `media_summary` (count, cc0_image_count, has_cc0_images, thumbnail). Full image arrays can be 15–20 images per object, each with 4 resolution variants — 300–500 lines of data in a typical object like the Amelia Earhart Vega. Separating media retrieval keeps `smithsonian_get_object` focused on catalog metadata and lets agents skip the image fetch for text-only research workflows.

### Rename from `smithsonian_get_image` to `smithsonian_get_media`

The idea doc used `smithsonian_get_image`. Renamed to `smithsonian_get_media` — the API technically supports video and 3D models too (surfaced in `indexedStructured.online_media_type`), and the IDS returns multiple images per call. The current implementation focuses on Images; the name leaves room for future expansion without a breaking rename.

### Rename from `smithsonian_search` / `smithsonian_explore` to `smithsonian_search_objects` / `smithsonian_browse_category`

The two-word names presented free-text search and exact-category browse as peer starting points, and "explore" read as the open-ended entry point while the handler required one exact, case-sensitive controlled-vocabulary value — so agents routinely picked it first and collected repeated errors. The three-word names state the role: `search_objects` is the sole recommended start for open-ended discovery, `browse_category` pages within a category the caller has already resolved. No compatibility aliases were kept — retaining the old names would preserve the ambiguous affordance and advertise duplicate discovery tools.

### `record_id` vs. `url` for IDs

The API response has two ID-like fields: `url` (e.g. `"edanmdm:nasm_A19670093000"`) and `content.descriptiveNonRepeating.record_ID` (e.g. `"nasm_A19670093000"`). The content endpoint accepts the full `edanmdm:` prefixed URL. The design uses `record_id` (the shorter form) as the identifier agents work with; the service layer prepends `edanmdm:` when calling the content endpoint. This matches the observable SI URL patterns (e.g., `si.edu/object/...:nasm_A19670093000`).

### No DataCanvas — direct paginated returns

An earlier iteration spilled large result sets to a DuckDB-backed DataCanvas (`rows > 20` routed the full page to a SQL-queryable table). It was removed: the result set is catalog object summaries, where the workflow is find-the-object-then-drill-in, not aggregate-over-rows — the wrong shape for SQL, and `smithsonian_browse_category` already covers the cross-museum breakdown case. `smithsonian_search_objects` returns up to `rows` (≤1,000) summaries directly; page through larger result sets with `start` + `rows`.

### Page sizes are served at their cap, not rejected

`rows` and `limit` accept any whole number of at least 1. Above the tool's cap (search, browse, and related 1,000; `smithsonian_list_terms` 40,000) the page is served at the cap and the `notice` opens with "<field> <n> exceeds the cap of <cap>; the page was served with <field> <cap>." Rejecting would cost the caller a round trip to learn a number the server can act on itself. The caps are EDAN's own `/search` maximum of 1,000 rows, and for `list_terms` (a vocabulary EDAN returns whole) a response-size choice that keeps a page near 1 MB per output surface. `SMITHSONIAN_CLAMP_LIMITS=false` restores rejection and advertises each cap as the schema `maximum`, for clients that validate against the schema. Paging notices name the next `start` outright: after a clamp, `start = page × rows` would skip data.

### Response cache

`SmithsonianService` keeps an in-process cache of normalized search pages (keyed by request URL, `SMITHSONIAN_SEARCH_CACHE_TTL_SECONDS`, default 1 hour) and raw content records (`SMITHSONIAN_CONTENT_CACHE_TTL_SECONDS`, default 24 hours). The api.data.gov key allows 1,000 requests per hour and every caller of a deployment shares it, so the repeated identical search and the get_object → get_media → find_related chain on one record (three reads of one record) cost one request per TTL. The cache is per instance, holds 64 MiB counted in UTF-8 bytes of the stored JSON, and evicts least recently used first. It stores successes only, so an error is never replayed, and concurrent identical requests share one load. The bare and `edanmdm:` forms of an ID share an entry. A TTL of `0` disables both caching and the sharing for that kind of read. Every upstream read also runs inside one 50 s deadline across attempts and backoff, which keeps a hung upstream under the 60 s request timeout MCP SDK clients default to; cancelling a call ends a pending backoff at once.

### Open Access mirror

The Smithsonian publishes the whole Open Access corpus as bulk metadata in a public S3 bucket. The server can hold a local SQLite copy and answer from it, which spends none of the shared 1,000-per-hour key budget.

- **Off by default.** The full mirror needs about 17 GB of disk (measured on a 75k-record sample and extrapolated per unit) and an operator-run first build, and a default install should work with only an API key. `SMITHSONIAN_MIRROR_PATH` turns it on; the variable stays out of `server.json` and `manifest.json` because the one-click install has no place to build a corpus.
- **What it answers.** Object reads (`get_object`, `get_media`, the `find_related` anchor) once the mirror is ready, falling back to the live API on a miss or a store error. Filter-only searches (empty or `*` query) within a 100,000-index-entry scan budget, measured to keep a mirror query to tens of milliseconds of synchronous work. Free text, over-budget searches, and `list_terms` stay live.
- **Ordering.** Mirror pages run in ingest order, not the live API's, so a notice says so and a walk lines up only while `sources` stays the same.
- **Provenance.** The five object-reading tools gain `sources` (`oa_mirror`, `edan_api`) and `mirror_snapshot` (ISO date of the bulk publish) when a mirror is configured, so an agent can cite the snapshot beside a count. A server without a mirror sets neither field.
- **Build and refresh.** `mirror:init`, `mirror:refresh`, and `mirror:status` run `dist/mirror/cli.js`; init and refresh run the same shard-by-shard pass, resumable after an interrupt. On HTTP, a cron job (`SMITHSONIAN_MIRROR_REFRESH_CRON`, default `0 12 * * *` in server local time, empty for none) runs the CLI refresh in a child process so its per-shard transactions never stall serving threads or `/healthz`; the expression is validated at startup. On stdio the operator refreshes out-of-band. Teardown stops the refresh child and closes the store.
- **Only init starts a build.** A refresh of a store holding no shards fails with `mirror_not_built` before any request. The first build downloads the whole bucket, so a scheduled refresh of a mistyped `SMITHSONIAN_MIRROR_PATH` must not start one. Startup opens a missing file as an empty store, logs a warning naming the variable, and answers live. That keeps the documented Docker flow working: the container starts first and `mirror:init` runs inside it. A file that isn't a SQLite store fails startup with a `ConfigurationError` naming the variable.
- **Never VACUUM the store.** The `facets` index stores `objects.rowid`, which `VACUUM` may renumber for a table without an integer primary key, pointing facet entries at the wrong records.
- **Dependencies.** `node-cron` schedules the refresh. `better-sqlite3` is an optional peer, needed on Node only.
- **Docker.** The image creates `/var/lib/smithsonian-mcp-server`, owned by the runtime user, for a mounted volume; the operator sets the path and runs `docker exec <container> bun run mirror:init`.

### Published agent skill

`skills/smithsonian-guide/SKILL.md` carries the gates that tool descriptions can't hold: `OR` never widens a search, a museum that spans several unit codes, place terms that are separate strings, the `name` filter matching every role, and mirror-served pages. It ships in the npm package, the Docker image, plugin installs, and the `.mcpb` bundle, and `createApp({ skills: 'skills' })` serves it over MCP as `skill://smithsonian-guide/SKILL.md`. The server `instructions` point to it.

### Object metadata and image licenses are separate

The catalog has two distinct CC0 flags:
1. `content.descriptiveNonRepeating.metadata_usage.access` — the object *metadata* license
2. Per-image `media[].usage.access` — each image's individual license

`smithsonian_get_media` gates delivery on each image's license and surfaces `is_cc0` on both the object and each returned image. The metadata flag does not gate delivery: an object can have CC0 metadata and restricted images, or the reverse.

---

## Known Limitations

- **No category browse endpoint**: The open API exposes `/terms/{field}` for flat filter vocabularies (what `smithsonian_list_terms` reads) but no `/category/search`. `smithsonian_browse_category` works around this via constrained search and can't return true hierarchical category trees.
- **Some filter values require object discovery**: `object_type` and `name` are not enumerable through `list_terms`; harvest object types from search and indexed names from related-search continuations. Scientific names come from `get_object.scientific_names`. Other supported vocabularies, including media types, are enumerable through `list_terms`.
- **Rate limits**: The free api.data.gov tier has ~1,000 req/hr. The `smithsonian_find_related` workflow makes ~5 calls for a shallow page — more when paging a broad signal deep (each 1,000-row chunk is one call, capped per signal); a session of 50 related searches could hit the hourly limit. The service layer implements backoff on 429 and caches responses, so repeated identical searches, and the get_object → get_media → find_related chain on one record, cost one request per TTL. The optional mirror removes object reads and filter-only searches from the budget entirely.
- **Objects without media**: A significant portion of catalog objects have no digitized media — `smithsonian_get_media` returns `no_media` for these.
- **EDAN content type variety**: Not all records are `type: edanmdm`. The catalog also has `type: ead_component`, `edanmdm`, library records, etc. The design targets `edanmdm` type records (the museum objects), but some search results may be library records with different field structures. The service normalizer should handle sparse/absent fields gracefully.

---

## API Reference

### Endpoints

| Endpoint | Method | Used By |
|:---------|:-------|:--------|
| `/search` | GET | `smithsonian_search_objects`, `smithsonian_browse_category`, `smithsonian_find_related` |
| `/content/{id}` | GET | `smithsonian_get_object`, `smithsonian_get_media`, `smithsonian_find_related` |

### Search parameters

| Param | Type | Notes |
|:------|:-----|:------|
| `q` | string | Full-text query |
| `rows` | number | Upstream page size (max 1,000); `smithsonian_search_objects` and `smithsonian_browse_category` cap at 1,000, and related searches use chunks of up to 1,000. |
| `start` | number | Offset (0-indexed) |
| `fq` | — | Not a working EDAN parameter. Structured filters are ANDed into `q` as Lucene `field:value` terms instead (e.g. `q=quilt AND unit_code:NASM`). |

Authentication uses the required `X-Api-Key` request header, sourced from `SMITHSONIAN_API_KEY`.

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
| NMNHBIRDS | NMNH - Vertebrate Zoology - Birds Division |
| NMNHPALEO | NMNH - Paleobiology Dept. |
| SAAM | Smithsonian American Art Museum |
| NMAH | National Museum of American History |
| NMAAHC | National Museum of African American History and Culture |
| NMAI | National Museum of the American Indian |
| NMAfA | National Museum of African Art |
| NPG | National Portrait Gallery |
| CHNDM | Cooper Hewitt, Smithsonian Design Museum |
| HMSG | Hirshhorn Museum and Sculpture Garden |
| NMAA | National Museum of Asian Art |
| NPM | National Postal Museum |
| ACM | Anacostia Community Museum |
| NZP | National Zoo & Conservation Biology Institute |
| SIL | Smithsonian Libraries and Archives |
| AAA | Archives of American Art |

### Resilience

- **Error-in-200 responses**: The service checks the top-level `error` before treating a 200 as success. `API_KEY_MISSING` raises non-retryable `InternalError`; `OVER_RATE_LIMIT` raises retryable `ServiceUnavailable`. Real HTTP 429 responses map to `RateLimited`.
- Transient failures retry with exponential backoff (base 2s, max 3 retries), all inside one 50 s deadline.
- `fetchWithTimeout` maps non-OK HTTP statuses to their corresponding error codes. A 404 on `/search` or `/terms/{field}` is reclassified as retryable `ServiceUnavailable`; `/content/{id}` retains `NotFound`.
- The API key is sent in the `X-Api-Key` header, never in URLs.
