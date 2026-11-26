# smithsonian-mcp-server — Design

## API key

`SMITHSONIAN_API_KEY` is required: the Smithsonian Open Access API has no keyless access, and a request without a key returns `{"error": {"code": "API_KEY_MISSING", ...}}`. The key is free and issued instantly at [https://api.data.gov/signup](https://api.data.gov/signup), and allows 1,000 requests per hour.

When the api.data.gov edge refuses the key (HTTP 403 naming an `API_KEY_*` code), every tool fails `api_key_rejected` (Forbidden) with a hint that names the variable to fix and says retrying won't help, since only the operator can replace the key. All six tools declare the reason; `Forbidden` is not one of the framework's baseline codes, and a tool's own `not_cc0` uses the same code, so callers branch on `reason`.

---

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations | Errors |
|:-----|:------------|:-----------|:------------|:-------|
| `smithsonian_search_objects` | Full-text search across 14.5M objects with exact filters. Returns curated summaries, thumbnails, and total count. | `query`, `filters` (unit_code, object_type, date, culture, place, topic, name, scientific_name, online_media_type, online_only, cc0_only, on_view_only), `rows`, `start` | `readOnlyHint: true`, `openWorldHint: true` | `no_results` (NotFound), `invalid_filter` (ValidationError) |
| `smithsonian_list_terms` | Enumerate the valid term vocabulary for an indexed filter field. Controlled-vocabulary terms are often plural or qualified, so drawing filter values from here avoids empty results. Returns one page of the field's distinct terms, plus a `labels` map of museum names for `unit_code`; `contains` narrows the vocabulary by a case-insensitive substring, matching the museum name and the names a unit also goes by (National Museum of Natural History, Freer Gallery of Art and Arthur M. Sackler Gallery, Cooper-Hewitt, National Design Museum) as well as the code for `unit_code`. Each field's vocabulary is cached (`SMITHSONIAN_TERMS_CACHE_TTL_SECONDS`) since upstream returns the whole set on every call, and concurrent cold reads of one field share one request. | `field` (unit_code, culture, place, date, online_media_type, topic), `contains`, `start`, `rows` | `readOnlyHint: true`, `openWorldHint: true` | `no_terms` (NotFound) |
| `smithsonian_get_object` | Normalized metadata by ID, including labeled notes, the labeled physical description, the record's indexed filter values, current display, the sets the catalog files it under, scientific names, reported taxonomy/coordinates, and a media summary. | `id` (alias `record_id`) | `readOnlyHint: true`, `openWorldHint: true` | `not_found` (NotFound), `invalid_id` (ValidationError) |
| `smithsonian_browse_category` | Paginated browse within one exact category. Mode: `museum` \| `culture` \| `period` \| `medium` \| `topic`; `value` must be an exact indexed category term, not free text. Searches a constrained query internally and returns the category total, a page of matching objects, and a museum breakdown of that page. | `mode`, `value`, `rows`, `start` | `readOnlyHint: true`, `openWorldHint: true` | `invalid_category` (ValidationError) |
| `smithsonian_find_related` | Given an object ID, finds related items across collections by matching the anchor's metadata signals (culture, period, object_type, named party, topics). Returns a page of related objects (default 10), each tagged with the signals that connected it. | `id` (alias `record_id`), `limit`, `start`, `unit_code` | `readOnlyHint: true`, `openWorldHint: true` | `not_found` (NotFound), `invalid_id` (ValidationError) |
| `smithsonian_get_media` | Returns CC0 image URLs at multiple resolutions for an object, or with `media: "3d"` its CC0 3D model packages and their download files. Filters by each image's or package's license and reports the object metadata license separately. Includes alt text and accessibility descriptions from the catalog. Pages a long image or package list. | `id` (alias `record_id`), `media`, `start`, `limit` | `readOnlyHint: true`, `openWorldHint: true` | `not_found` (NotFound), `no_media` (NotFound), `no_images` (NotFound), `no_models` (NotFound), `not_cc0` (Forbidden), `invalid_id` (ValidationError) |

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
| `SMITHSONIAN_TERMS_CACHE_TTL_SECONDS` | No | Seconds each field's term vocabulary is cached in the `StorageService` (default: `3600`). `/terms/{field}` ignores paging and always returns the whole vocabulary — `place` alone is ~114k terms — so every uncached call re-downloads it. Concurrent cold reads of one field in one tenant share one request. `0` disables the cache and that sharing. |
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
5. `smithsonian_get_media` — extract and gate images, or with `media: "3d"` model packages, from a fetched object.
6. `smithsonian_browse_category` — mode-dispatch to constrained searches.
7. `smithsonian_find_related` — multi-search fan-out.

Each step is independently testable.

---

## Tool Detail

### `smithsonian_search_objects`

**Description:** Search across 14.5 million Smithsonian objects by text query and optional filters. Filters narrow by museum unit, object type, indexed date term, culture, geographic place, subject topic, named party, scientific name, media type, online/CC0 availability, and objects on display now. Returns curated summaries (title, date, museum, thumbnail URL, CC0 flag) with the total match count. The `record_id` in each result is the identifier for `smithsonian_get_object`, `smithsonian_get_media`, and `smithsonian_find_related`.

**Input:**
- `query: string` — Free-text search. Required. Use specific terms for precision (`"Tlingit totem pole"`) or broad terms for browsing (`"quilt"`). Filters append hard `AND` constraints; plain words and quoted phrases remain ungrouped because EDAN changes implicit matching inside parentheses. Active Lucene expressions are grouped to preserve Boolean precedence; quoted and escaped punctuation stays literal.
- `filters?: object` — Optional structured filters. The object is strict: an unknown key is rejected by name as a schema validation error, so a misspelled filter fails loudly instead of widening the search.
  - `online_media_type?: string` — exact indexed category from `smithsonian_list_terms { field: "online_media_type" }`, such as Images, 3D Models, or Sound recordings. Quoted and escaped as a hard constraint, composing with availability filters. Invalid terms follow vocabulary-aware `invalid_filter` recovery; valid terms with no overlap are identified as exact. An Images match does not guarantee attached/CC0 images; read `get_object.media_summary`. Media terms feed search only, with no browse mode.
  - `scientific_name?: string` — exact value from `smithsonian_get_object.scientific_names`, quoted and escaped as a hard constraint. Not enumerable through `smithsonian_list_terms`; filtered-zero recovery names the object field as the source.
  - `unit_code?: string` — museum unit code (e.g. `"NASM"`, `"SAAM"`). Natural History is indexed under discipline sub-units (`"NMNHBIRDS"`, `"NMNHPALEO"`), not a bare `"NMNH"`. Matched exactly and case-sensitively (`"NMAfA"` carries a lowercase f); `smithsonian_list_terms` with `field: "unit_code"` enumerates the live vocabulary, and `contains: "Natural History"` lists the NMNH codes.
  - `object_type?: string` — object type term from `indexedStructured.object_type` (e.g. `"Paintings"`, `"Photographs"`, `"Aircraft"`). Not enumerable through `smithsonian_list_terms`; take it from `smithsonian_get_object`'s `indexed.object_type` for a known object, or from the `object_type` of search results.
  - `date?: string` — indexed date term from `indexedStructured.date`. Commonly a decade (`"1920s"`, `"1960s"`), but the vocabulary also carries year ranges (`"500-1500"`), century terms (`"21st century"`), and BCE forms (`"-2500"`, `"BCE 1000s"`) — 128 of the 201 indexed terms are not decade-shaped, so no shape gate is applied.
  - `culture?: string` — culture term from `indexedStructured.culture` (e.g. `"Plains Indian"`).
  - `place?: string` — geographic place from `indexedStructured.place` (e.g. `"United States of America"`).
  - `topic?: string` — subject term from `indexedStructured.topic` (e.g. `"Quilts"`, `"Aviation"`), the vocabulary `smithsonian_get_object` returns as `indexed.topic` (its `topics[]` also carries free-text subject strings such as `"Quilts--History"` that match nothing here). Enumerable via `smithsonian_list_terms` (about 133,000 terms). A hard constraint: `topic:"Quilts"` matches 1,134 objects where the bare word as free text matches 2,677.
  - `name?: string` — indexed named party from `indexedStructured.name` (e.g. `"Warhol, Andy"`), covering every role the catalog records — maker, collector, donor, issuing authority. Written surname-first. Not enumerable via `smithsonian_list_terms`. `smithsonian_get_object`'s `indexed.name` lists every party a record is indexed under, and is the reliable source; its `makers[]` reads the free-text block, which names the same parties in a different form often enough to miss (`"Major J. A. L. Möller (Jacob A.L. Möller/Monty Möller), Non-Indian, 1883-1957"` for the indexed `"Möller, Major J. A. L."`), so it is a starting guess rather than an exact value. A `smithsonian_find_related` name signal also carries the indexed form of a record's first indexed name. Also a hard constraint: `name:"Warhol, Andy"` matches 421 against 715 for the same string as free text. Added so `smithsonian_find_related`'s indexed-name fan-out has a reproducible `search_continuation`.
  - `online_only?: boolean` — when true, ANDs the Lucene term `online_media_type:*` into `q` to restrict to records carrying an indexed `online_media_type` value. That vocabulary covers digitized surrogates (finding aids, catalog cards, scanned books, full text, electronic resources) alongside images, 3D models, and video; the surrogate types often have no deliverable media attached, so a match can still report `has_media: false`. `has_media` reads `descriptiveNonRepeating.online_media` — a separate upstream signal — and is what predicts a `smithsonian_get_media` outcome.
  - `cc0_only?: boolean` — when true, ANDs the Lucene term `media_usage:CC0` into `q`. That term marks a record as *having CC0 media attached*, not as being CC0-licensed, so this selects on media presence rather than license: of 14.5M records, 5.25M carry the term and the 9.24M excluded are CC0 too, just undigitized. `has_media` remains the signal that predicts a `smithsonian_get_media` outcome.
  - `on_view_only?: boolean` — when true, ANDs `onPhysicalExhibit:"Yes"` into `q` (the mirror matches the same flag), selecting objects the catalog flags as on physical display now: about 13,000 records from 13 museums. Most records carry no flag, so an unflagged object may still be on view, and there is no off-view filter: upstream has no exact off-view term (`onPhysicalExhibit:"No"` returns records flagged Yes). `false` or omitted adds nothing. `smithsonian_get_object` reports where a flagged object is shown.
- `rows?: number` — page size (default 20, cap 1,000, EDAN's own `/search` maximum). A larger value is served at the cap and the `notice` opens with "rows N exceeds the cap of 1000; the page was served with rows 1000."; with `SMITHSONIAN_CLAMP_LIMITS=false` it is rejected and the schema advertises `maximum: 1000`.
- `start?: number` — offset for pagination (default 0). A `start` past the end returns a successful empty page, not an error.

**Output:**
- `objects[]` — curated summaries: `{ record_id, title, date, unit_code, museum_name, holding_museum_name?, object_type, thumbnail_url, is_cc0, has_media }`. `unit_code` is the code the record is indexed under (top-level `unitCode`, falling back to `descriptiveNonRepeating.unit_code`); `holding_museum_name` is read from `descriptiveNonRepeating.data_source` and set only when the record's own code differs from the indexed one, as for the `OCIO_DPO3D` 3D scans, which are indexed under the digitization office while `data_source` names the holder. The record's own code is not reported because EDAN often does not index it, so it would hand the caller a filter that matches nothing. `thumbnail_url` (~150px) is the first media item's "Thumbnail Image" resource, falling back to its `thumbnail` field, which on Image Delivery Service records repeats the full-size delivery URL; browse and related results build it the same way. Empty on a page past the end of the result set.
- `total_count` — total matching objects before pagination.
- Enrichment: `truncated` / `shown` / `cap` / `truncationCeiling` / `notice` — `truncated` fires only when objects remain past this page (`start + shown < total_count`), so a terminal or past-the-end page reports nothing withheld; `notice` names the next `start` outright (a clamped page makes `start = page × rows` skip data). With a mirror configured, `sources` / `mirror_snapshot` (see [Open Access mirror](#open-access-mirror)).

**Errors:**
- `no_results` (NotFound) — an unfiltered query matches nothing at all (`rowCount === 0`). Recovery: broaden the query or check spelling. Deliberately keyed to the true match count rather than the page-local length, so a deep `start` against a query with real matches is never told to check its spelling.
- `invalid_filter` (ValidationError) — a filtered search matched nothing, most often a filter value outside the Smithsonian controlled vocabulary (e.g. singular `"Painting"` instead of `"Paintings"`). Recovery: a culture/place/date/topic value is checked against its vocabulary first, and the hint branches on the answer — a value outside it routes to `smithsonian_list_terms { field, contains: <value> }`, while a value the index already enumerates is named as exact (resolving it returns the same value) and the caller is told to drop it or pick a different term. When the vocabulary read fails, is cut short by the call's deadline, or is skipped, membership is unknown and the hint keeps the resolve-it clause, which claims nothing about the vocabulary. For object_type/unit_code, exact co-occurring values are harvested into the hint, but only for a non-blank query: with a blank or whitespace-only query the re-query has nothing to sample against and EDAN answers its empty `q` with a 400, so the harvest is skipped and the hint stays static. `name` gets neither — it is not enumerable upstream and not carried in result summaries — so it falls to the static hint, which routes to `smithsonian_get_object`'s `indexed` values (name, object_type, place, date, topic) and flags `makers[]` as the free-text approximation. The vocabulary lookups and the harvest run concurrently on the time the call has left; one that fails, is cut short, or is skipped claims no membership and harvests nothing, and the call still fails `invalid_filter`. Caller cancellation is rethrown, not reported as a zero match. Then retry with an exact term.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `smithsonian_get_object`

**Description:** Fetch a normalized catalog metadata projection for a Smithsonian object by its `record_id` (from `smithsonian_search_objects` results). Returns the exposed catalog fields: title, dates, description, makers, the labeled physical description, place and culture associations, topics, the indexed values usable as search filters, exhibition history, current display, the sets the catalog files it under, credit line, accession identifiers, rights statement, and a curated media summary (count, CC0 status, thumbnail). The `record_id` uses the format returned by search — do not manually construct IDs.

**Input:**
- `id: string` — Object `record_id` as returned by `smithsonian_search_objects` (e.g. `"nasm_A19670093000"`). The service prepends `edanmdm:` automatically. `record_id` is accepted as an alias (see [`record_id` vs. `url` for IDs](#record_id-vs-url-for-ids)).

**Output:**
- `record_id`, `title`, `unit_code` (the code the record is indexed under), `museum_name`, `holding_museum_name?` (the holder, when it differs from `unit_code`; rendered as `Held by` in the text output)
- `dates[]` — all labeled date fields (Date, Accession Date, etc.)
- `description` — optional prose from Summary, Physical Description, then Brief Description matching labels; followed by exact Description, Description (Brief), then Citation labels. Administrative notes never become descriptions.
- `notes[]` — every nonempty note as `{ label, content }` in source order, preserving repeated labels and using `Note` when the label is absent. Selected prose and notes use the shared decode-once plain-text projection. The projection removes only the elements `a`, `b`, `br`, `em`, `i`, `p`, `span`, `sub`, and `sup` (any case, with attributes; `br` and `p` leave a space; the element name ends at whitespace, `/`, or `>`, and a quoted attribute value may hold `<` or `>`), then decodes character references once. Every other bracketed run is catalog text and stays.
- `scientific_names[]` — all `indexedStructured.scientific_name` values, preserving order without selecting an accepted name. Search accepts these as exact `filters.scientific_name` constraints with quote/backslash escaping; filtered-zero recovery names this source rather than `list_terms`.
- `taxonomy?` — reported `tax_kingdom`, `tax_phylum`, `tax_class`, `tax_order`, and `tax_family` arrays under their rank names; absent ranks remain omitted.
- `coordinates[]` — valid decimal `geoLocation[].points.point` latitude/longitude pairs with only the same entry's `Other` locality. Blank, non-decimal, incomplete, non-finite, or out-of-range pairs are omitted; valid zero survives. No coordinate accuracy or geocoding is inferred.
- `makers[]` — `{ role, name }` — all named parties (Pilot, Manufacturer, Artist, Author, etc.)
- `physical_description[]` — `{ label, value }` for every `freetext.physicalDescription` entry with content, in catalog order with repeated labels kept, each under the catalog's own label (`Medium`, `Dimensions`, `Length - Total`, `Sex`, `Preparation`, `Physical Location`), or `Physical description` when it has none. Nothing is routed or sorted by label; `[]` when the record has none. Separate from `description`, the prose chosen from notes.
- `place[]` — labeled place fields
- `culture[]` — culture associations
- `topics[]` — the indexed topic terms merged with the catalog's free-text subject strings (`"Quilts--History"`), so not every entry is a `topic` filter value; take those from `indexed.topic`
- `indexed` — `{ name[], place[], object_type[], date[], topic[] }`: the record's indexed values for five `smithsonian_search_objects` filters, in catalog order and not de-duplicated, each passable verbatim as the filter of the same name. An empty array means the record indexes nothing for that filter. The free-text `makers[]`, `place[]`, `dates[]`, and `topics[]` are the catalog's other forms of the same data and often differ (`"Neil A. Armstrong"` for the indexed `"Armstrong, Neil A."`). `culture`, `scientific_names`, and `unit_code` already carry indexed values.
- `exhibitions[]` — free-text exhibition history: `{ name, building? }`, which the catalog rarely fills, so `[]` does not mean the object was never exhibited
- `on_view?` — `true` when the catalog flags the object as on physical display now (`onPhysicalExhibit` "Yes"), `false` when it flags "No", absent when the record carries no flag, which most do; absence says nothing about display
- `current_exhibitions[]` — where the object is on display now: `{ building?, room?, title? }`, absent parts omitted, an entry that names nothing dropped; `[]` when it names none. `building` is a building code (`"NASM"`, `"NPG"`, `"NMAI NY"`), not a `unit_code`.
- `sets[]` — `{ label, value }` for every `freetext.setName` entry with content, in catalog order with repeated labels kept, under the catalog's own label (`See more items in`, `On View`, `Location`, `Exhibition`, `Hangar`, `Department`, `Classification`; the vocabulary varies by unit), or `Set` when it has none. Always present, `[]` when the record lists none; rendered under **Sets:**. For an object on display it names the gallery, floor, hangar, or exhibition that `current_exhibitions` gives only as a building code. It is catalog text, not a second display flag: a National Portrait Gallery record can read `Location: Currently not on view` and carry no `on_view`.
- `credit_line` — attribution string
- `identifiers[]` — all `{ label, value }` pairs (accession numbers, call numbers, etc.)
- `object_rights` — the rights statements: the content of every `freetext.objectRights` entry, then every `freetext.objectRight` entry (the singular key Smithsonian Institution Archives records use), in catalog order, joined with `; `. Absent when neither key has an entry.
- `is_cc0` — boolean gated on `metadata_usage.access === 'CC0'`
- `record_link` — canonical SI URL for the object
- `media_summary` — `{ count, cc0_image_count, has_cc0_images, thumbnail_url, non_image_media[] }` — `count` is the raw total across all media types (images, 3D models, video); `cc0_image_count` is what `smithsonian_get_media` pages through and reports as its own `cc0_image_count`, so the two reconcile; `thumbnail_url` is ~150px. `non_image_media[]` holds `{ type, url?, is_cc0 }` for every media item typed as something other than Images, in catalog order, so images and non-image items together partition the record's media; the text output renders each as `- [<type>](<url>) · CC0: Yes|No`. A `3d_voyager` item's `url` is its viewer page; its model files come from `smithsonian_get_media` with `media: "3d"`, not from here. Call `smithsonian_get_media` for the full image list
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
  - `medium`: object type, usually plural (`"Paintings"`, `"Aircraft"`); not enumerable through `smithsonian_list_terms`, so take it from `smithsonian_get_object`'s `indexed.object_type` for a known object, or from search results
  - `topic`: subject term (`"Quilts"`, `"Aviation"`) from the 133k-term `topic` vocabulary
- `rows?: number` — sample objects to return (default 10, cap 1,000; served at the cap with a notice, like search).
- `start?: number` — pagination offset into the category's match set (default 0, 0-indexed). Page contiguously by advancing `start` by the number of objects returned (the notice names it); the category query and upstream ordering are identical across pages, so adjacent pages reconstruct the full set gap-free. A `start` past the end returns a successful empty page, not an error.

**Output:**
- `mode`, `value`, `total_count` — how many objects match
- `sample_objects[]` — the requested page: `{ record_id, title, unit_code, thumbnail_url, is_cc0 }`
- `museum_breakdown[]` — when mode is not `museum`, top 5 contributing units with counts, computed from the current page (helps plan museum-focused follow-up searches)
- Enrichment: `truncated` / `shown` / `cap` / `truncationCeiling` / `notice` — `truncated` fires only when objects remain past this page (`start + shown < total_count`), so a terminal or past-the-end page reports nothing withheld; `notice` names the next `start` outright, after the clamp sentence when `rows` exceeded the cap. With a mirror configured, `sources` / `mirror_snapshot`

**Errors:**
- `invalid_category` (ValidationError) — the category matches nothing at all (`rowCount === 0`). A browse category is an exact indexed facet, so a zero match means the supplied value did not resolve to retrievable objects, not that an object is missing. Recovery is mode-specific and names the literal next call. For `museum` / `culture` / `period` / `topic` the value is first checked against its vocabulary: outside it, the hint routes to `smithsonian_list_terms { field, contains: value }` (for `unit_code` that call matches museum names as well as codes, so a museum name resolves through it too); inside it — 14 of the 48 unit codes and a long tail of culture terms are indexed with zero objects — the hint says so and routes to a different term or a `smithsonian_search_objects` free-text query, since resolving the value returns it verbatim and loops the caller through the same failure. When the vocabulary read fails, is cut short by the call's deadline, or is skipped, membership is unknown: the hint names the same `smithsonian_list_terms` lookup, claims neither membership nor non-membership, and says what to do with either answer (a term the lookup lists has no retrievable objects, so browse another or search). The lookups run on the time the call has left, and the call still fails `invalid_category`; caller cancellation is rethrown. `medium` gets no vocabulary check (`object_type` is not enumerable upstream); it names the `object_type` values harvested from re-running the value as a free-text search, falling back to routing the caller to that search when the harvest is empty. Candidates are listed, never auto-selected. Not raised for a `start` past the end of a real category, which is normal pagination completion.

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
- `id: string` — `record_id` of the anchor object (from `smithsonian_search_objects` or `smithsonian_get_object`). `record_id` is accepted as an alias.
- `limit?: number` — max related objects to return (default 10, cap 1,000; served at the cap with a notice).
- `start?: number` — pagination offset into the interleaved related-object sequence (default 0). Page contiguously by advancing `start` by the number of objects returned (the notice names it): page N+1 continues where page N ended. Each contributing signal is reachable to a depth of 5,000 objects, fetched from upstream in ≤1,000-row chunks. Near a seam a bounded number of objects (up to the active-signal count) can shift by one page, since a deeper page fetches more per signal and may reallocate an object that ranks very differently across signals. Beyond 5,000 matches for a signal, `truncated` stays true but deeper pages aren't reachable.
- `unit_code?: string` — scopes every signal to one museum with a hard `unit_code` filter, so each fan-out's `search_continuation` carries it. Takes the indexed code a result row's `unit_code` reports (`"NASM"`; the 3D scans are `"OCIO_DPO3D"`), never a `holding_museum_name`. Matched exactly and case-sensitively and not checked against the vocabulary, like `smithsonian_search_objects`'s filter; an empty string reads as omitted. The anchor's own code keeps related objects in its museum, and another code finds related objects held elsewhere. Without it, signals run across every museum, which is how an aerospace anchor reaches natural history and art.

**Output:**
- `anchor` — summary of the anchor object (`{ record_id, title, unit_code }`)
- `related[]` — `{ record_id, title, unit_code, museum_name, holding_museum_name?, thumbnail_url, is_cc0, similarity_signals[] }` where `similarity_signals` is a string array of **every** metadata term that connected this object (an object surfaced by multiple fan-out signals carries all of them, e.g. `["culture: Plains Indian", "topic: Basketry"]`)
- `search_signals_used[]` — which metadata fields drove the fan-out searches
- With a mirror configured: `sources`, `mirror_snapshot` (see [Open Access mirror](#open-access-mirror)); the anchor read can come from the mirror while the signal searches stay live
- `signals[]` — per-signal breakdown of every fan-out that returned: `{ signal, row_count, search_continuation }`. `row_count` is the signal's true upstream match count, uncapped — unlike `truncationCeiling` it is not clamped to the 5,000 per-signal reach, so the two disagree exactly when a signal is broader than this tool can page. `search_continuation` is the `smithsonian_search_objects` input (`{ query, filters? }`) that reproduces that fan-out's query exactly, with `filters.unit_code` when the call was scoped, and `smithsonian_search_objects` applies `start` straight to the upstream offset with no depth cap — so it is the retrieval path for everything past the 5,000 reach. A fan-out whose upstream call failed is omitted (it has no known row count); `search_signals_used` still lists it.
- `notice` — composes the clamp sentence (when `limit` exceeded its cap), safe partial-failure categories and failed-signal labels, and empty-result and paging guidance, which names the next `start`, on both wire surfaces. A signal still pending when the call's deadline passes is named `(timeout)` beside the signals that finished. No signals, no non-anchor matches, partial empty results, and exhausted pages have distinct guidance; when every window held its signal's whole match set, a scoped call that finds only the anchor says so, names the `unit_code`, and suggests checking it or omitting it. A later-chunk failure drops the entire signal to avoid a gap; if every attempted signal fails, the first failure in signal order is thrown. Caller cancellation rejects even after a successful signal.
- Enrichment: `truncated` / `shown` / `cap` / `truncationCeiling` / `notice` disclose when related objects were omitted — capped by `limit` or more matches available upstream (page with `start`); `truncationCeiling` is an upper bound on the *reachable* related pool — each signal's upstream match count is capped at its per-signal reach (5,000) before summing, so the ceiling never exceeds what `start` can retrieve. `notice` names both continuation tiers: `start` for the next page, `signals[].search_continuation` for a signal past the reach.

**Errors:**
- `not_found` (NotFound) — anchor object not found. Recovery: verify the ID via `smithsonian_search_objects`.
- `invalid_id` (ValidationError) — ID format is clearly malformed.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `smithsonian_get_media`

**Description:** Returns CC0-licensed images for a Smithsonian object at multiple resolutions, or with `media: "3d"` its CC0 3D model packages and their downloadable files, reporting the object metadata license separately. Items come in catalog order and can be paged. An object with no CC0 item of the requested kind fails with its own declared error reason — nothing digitized, media that is entirely non-image (images mode) or has no 3D package (3D mode), or items that are entirely non-CC0 — decided on the whole record before paging, so the reason is the same at any `start`. A `start` at or past the count returns an empty list. Each image includes high-res JPEG/TIFF URLs, screen-size and thumbnail URLs, pixel dimensions where the catalog lists them, and accessibility alt text. Intended for use with image-capable MCP clients that can display or analyze the photos.

**Input:**
- `id: string` — `record_id` of the object (e.g. `"nasm_A19670093000"`). `record_id` is accepted as an alias.
- `media?: "images" | "3d"` — default `"images"`. `"3d"` returns the record's `3d_voyager` packages in place of its images.
- `start?: number` — offset into the CC0 images, or with `media: "3d"` the CC0 model packages, 0-indexed in catalog order (integer ≥ 0, default 0).
- `limit?: number` — images, or with `media: "3d"` packages, to return from `start` (page-size contract, cap 1,000: a larger value is served at the cap with a notice, or rejected under `SMITHSONIAN_CLAMP_LIMITS=false`). Omitted returns everything from `start`.

**Output:**
- `record_id`, `title`
- `is_cc0` — boolean, whether the object metadata is CC0
- `cc0_image_count` — CC0 images on the record before paging, the same count as `smithsonian_get_object`'s `media_summary.cc0_image_count`; reported in 3D mode too
- `cc0_model_count?` — CC0 3D model packages on the record before paging; present only with `media: "3d"`
- Enrichment: `truncated` / `shown` / `cap` / `truncationCeiling` / `notice` — `truncated` fires only when CC0 items remain past this page; the `notice` names the next `start`, or says to omit `limit` to return the rest. In 3D mode they count packages.
- With a mirror configured: `sources`, `mirror_snapshot` (see [Open Access mirror](#open-access-mirror))
- `images[]` — per-image entries, each with:
  - `media_id` — IDS identifier
  - `is_cc0` — whether this specific image is CC0 (may differ from the object-level flag)
  - `alt_text` — accessibility text; omitted when empty
  - `description` — extended accessibility description; omitted when empty
  - `thumbnail_url` — `_thumb` URL (~150px)
  - `screen_url` — `_screen` URL (~1,200px on the long edge), or the image's full-size delivery URL when the catalog lists no screen image
  - `high_res_jpeg` — `{ url, width?, height? }` — the catalog's high-resolution JPEG with its pixel dimensions, or, when it lists none, `{ url }` set to the image's full-size delivery URL without dimensions; absent only when the image has neither
  - `high_res_tiff` — `{ url, width?, height? }` — archival TIFF when available
  - Always `[]` with `media: "3d"`.
- `models[]` — present only with `media: "3d"`: the CC0 `3d_voyager` packages from `start`, each `{ media_id, is_cc0, viewer_url?, thumbnail_url?, files[] }`. Each package is gated on its own `usage.access`, as each image is. `viewer_url` is the Voyager web page, not a file. `files[]` holds the downloads the package lists, in catalog order, `[]` when it lists none (not an error): `{ url, filename?, category?, file_type?, model_file_type?, units?, draco_compressed?, size_bytes? }`. Every field but `url` is the catalog's value as written (`filename` and `category` from the resource, the rest from its `attributes[]` keys `FILE_TYPE`, `MODEL_FILE_TYPE`, `UNITS`, `DRACO_COMPRESSED`, `FILE_SIZE`, read wherever those keys sit across the entries) and absent when the catalog gives none. Spellings vary (`Full resolution`, `Full_resolution`; `glb`, `GLB`) and are passed through.

**Errors:**
- `not_found` (NotFound) — object not in catalog. Recovery: verify via `smithsonian_search_objects`.
- `no_media` (NotFound) — object found but has no online media, in either mode. Recovery: the physical object may not have been digitized.
- `no_images` (NotFound) — images mode: object found with media, but all of it is non-image (3D models, scanned books, documents). Recovery: the hint names the media types present and points at `smithsonian_get_object`'s `media_summary.non_image_media`, which links each item; for an object with a 3D package it names the `media: "3d"` call.
- `no_models` (NotFound) — `media: "3d"`: object found with media, but none of it is a `3d_voyager` package. Recovery: the hint names the media types present and the call that reaches them (the images call when the record has images, else `media_summary.non_image_media`).
- `not_cc0` (Forbidden) — object found with images, or with `media: "3d"` 3D packages, but none of them is CC0 (raised at any `start`). Recovery: use `smithsonian_search_objects` with `filters.cc0_only: true` to find CC0 objects with images, or `filters.online_media_type: "3D Models"` for objects with 3D packages.
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
| 5 | `GET /search?q=object_type:{type} AND date:{period}&start=0…` | Fan-out by period + type, same chunked depth, filters in `smithsonian_search_objects` order so the continuation replays the same request | if period or object type is present |

When `unit_code` is set, every fan-out query in calls 2–5 also carries `AND unit_code:"{code}"`. Calls 2–5 use `Promise.allSettled` — one failed fan-out degrades gracefully — and every read of the call, the anchor included, runs on the one deadline the call shares (see [Response cache](#response-cache)). Each signal is fetched from the top (`start=0`) to a depth of `min(start + limit, 5000)`, split into chunks of at most 1,000 rows (the hard upstream `rows` ceiling — a single call requesting more silently collapses to a 10-row page). The first chunk is a single call that also reveals the signal's real match count; deeper chunks (`start=1000, 2000, …`) fire in parallel and only when both the requested depth and the real total exceed one chunk, so a shallow page costs exactly one call per signal. Results are deduped against the anchor ID and interleaved round-robin so each fan-out signal contributes, accumulating every signal that surfaced an object. The `start` offset is then applied to the merged interleave (not the upstream query), so pages are contiguous — page N+1 continues where page N ended. (Because a deeper page fetches more rows per signal, an object that ranks very differently across signals can be reallocated to a different bucket, shifting a bounded number of objects — up to the active-signal count — by one page near a seam.) When the interleave extends past the page or a signal reports more matches than were fetched, the response discloses `truncated` with a `truncationCeiling` (each signal's count capped at the 5,000 reach before summing); advancing `start` retrieves the next window, up to the per-signal cap.

---

## Design Decisions

### No IIIF — SI uses its own IDS

The idea doc referenced IIIF image manifests. Live probing shows the Smithsonian IDS (`ids.si.edu/ids/deliveryService`) does NOT serve IIIF manifests — it's a proprietary delivery service. Images are accessed via direct download URLs with size suffixes (`_thumb`, `_screen`, `.jpg`, `.tif`). The `smithsonian_get_media` tool exposes these URLs directly, which works well for image-capable MCP clients.

### `smithsonian_browse_category` is a search workflow, not a browse endpoint

The idea doc assumed a category browse endpoint. Live probing confirmed the `/terms` and `/category/search` endpoints return 404 — the open API does not expose category hierarchies. The `smithsonian_browse_category` tool constructs its overview by running a constrained `search` query using the mode as a filter field. This loses some richness (no true hierarchical browsing) but delivers the same agent goal: "show me what the Smithsonian has in category X."

### `smithsonian_get_media` is a separate tool, not merged into `smithsonian_get_object`

The object endpoint returns a `media_summary` (count, cc0_image_count, has_cc0_images, thumbnail). Full image arrays can be 15–20 images per object, each with 4 resolution variants — 300–500 lines of data in a typical object like the Amelia Earhart Vega. Separating media retrieval keeps `smithsonian_get_object` focused on catalog metadata and lets agents skip the image fetch for text-only research workflows.

### 3D files come from `smithsonian_get_media`'s `media` mode

A 3D package lists its downloads in `resources[]`, one record carries 49 packages, and a package lists up to 14 files. Carrying them in `media_summary.non_image_media` would add that weight to every `smithsonian_get_object` call, and a seventh tool would split media retrieval across two names. `media: "3d"` on `smithsonian_get_media` returns the packages and files instead, so 3D files stay out of `smithsonian_get_object`; images mode is unchanged.

### `physical_description` is one labeled list

`smithsonian_get_object` returns every `freetext.physicalDescription` entry under its own label, in catalog order, and routes none into materials or dimensions by label. Labels can't separate the two: units label specimen attributes (`Sex`, `Preparation`), storage locations (`Physical Location`), and collection depths (`Depth (m)`) alongside materials and measurements, and a list of measurement labels would still miss `Diameter`, `Culmen`, and similar.

### Rename from `smithsonian_get_image` to `smithsonian_get_media`

The idea doc used `smithsonian_get_image`. Renamed to `smithsonian_get_media` — the API technically supports video and 3D models too (surfaced in `indexedStructured.online_media_type`), and the IDS returns multiple images per call. The tool returns images by default and 3D model packages with `media: "3d"`; the name left room for that without a breaking rename.

### Rename from `smithsonian_search` / `smithsonian_explore` to `smithsonian_search_objects` / `smithsonian_browse_category`

The two-word names presented free-text search and exact-category browse as peer starting points, and "explore" read as the open-ended entry point while the handler required one exact, case-sensitive controlled-vocabulary value — so agents routinely picked it first and collected repeated errors. The three-word names state the role: `search_objects` is the sole recommended start for open-ended discovery, `browse_category` pages within a category the caller has already resolved. No compatibility aliases were kept — retaining the old names would preserve the ambiguous affordance and advertise duplicate discovery tools.

### `record_id` vs. `url` for IDs

The API response has two ID-like fields: `url` (e.g. `"edanmdm:nasm_A19670093000"`) and `content.descriptiveNonRepeating.record_ID` (e.g. `"nasm_A19670093000"`). The content endpoint accepts the full `edanmdm:` prefixed URL. The design uses `record_id` (the shorter form) as the identifier agents work with; the service layer prepends `edanmdm:` when calling the content endpoint. This matches the observable SI URL patterns (e.g., `si.edu/object/...:nasm_A19670093000`).

### `record_id` is an alias of `id`

Results name the object `record_id`, so an agent following them sends that key. `smithsonian_get_object`, `smithsonian_get_media`, and `smithsonian_find_related` accept it as an alias of their `id` input (`inputAliases: { record_id: 'id' }`). The advertised `inputSchema`, the descriptions, and the recovery hints keep `id`. Sending both keys fails `invalid_arguments`.

### No DataCanvas — direct paginated returns

An earlier iteration spilled large result sets to a DuckDB-backed DataCanvas (`rows > 20` routed the full page to a SQL-queryable table). It was removed: the result set is catalog object summaries, where the workflow is find-the-object-then-drill-in, not aggregate-over-rows — the wrong shape for SQL, and `smithsonian_browse_category` already covers the cross-museum breakdown case. `smithsonian_search_objects` returns up to `rows` (≤1,000) summaries directly; page through larger result sets with `start` + `rows`.

### Page sizes are served at their cap, not rejected

`rows` and `limit` accept any whole number of at least 1. Above the tool's cap (search, browse, and related 1,000; `smithsonian_list_terms` 40,000, `smithsonian_get_media` 1,000) the page is served at the cap and the `notice` opens with "<field> <n> exceeds the cap of <cap>; the page was served with <field> <cap>." Rejecting would cost the caller a round trip to learn a number the server can act on itself. The caps are EDAN's own `/search` maximum of 1,000 rows, and for `list_terms` and `get_media` (a vocabulary and one record's image list, which EDAN returns whole) response-size choices: 40,000 terms keeps a page near 1 MB per output surface, and 1,000 images near 600 KB. `SMITHSONIAN_CLAMP_LIMITS=false` restores rejection and advertises each cap as the schema `maximum`, for clients that validate against the schema. Paging notices name the next `start` outright: after a clamp, `start = page × rows` would skip data.

### `content[]` reads back to `structuredContent`

Catalog text carries Markdown-significant characters (`M*A*S*H`, bracketed MARC runs like `<Funktionentafeln …>`, trailing spaces, blank lines), so every upstream or caller-echoed string `format()` writes goes through the encoder for its slot. A CommonMark parse of `content[]` then reads back to the `structuredContent` value:

- Running text, label lines, list items, and bold use `escapeMarkdownInline`, which writes edge spaces as `&#32;`.
- ATX headings (titles, `media_id`, the browse `value`) use `headingText` in `src/mcp-server/tools/markdown-encoders.ts`: each line goes through `escapeMarkdownInline`, and the lines are joined with `&#10;`, because a heading can't span lines.
- Record IDs, `list_terms` fields and terms, and find_related's `search_continuation` render as code spans through `markdown().inlineCode()`, which sizes the fence past any backticks in the value.
- Thumbnails render as `![Thumbnail](<url>)`. The catalog record link and the media resolutions render as links; only thumbnails embed, so a client never fetches a full-size image inline.
- get_object's multi-value fields and find_related's signals render one list item per value, because values carry the `, ` and `; ` a join would use (`Korean War, 1950-1953` is one topic).
- `structuredContent.notice` carries raw text. The `notice` trailer (`noticeTrailer` in the same file) escapes the notice and quotes each line when it renders, so failed-signal labels, a scoped `unit_code`, and an echoed `contains` reach `content[]` escaped and the structured notice unchanged.

### Response cache

`SmithsonianService` keeps an in-process cache of normalized search pages (keyed by request URL, `SMITHSONIAN_SEARCH_CACHE_TTL_SECONDS`, default 1 hour) and raw content records (`SMITHSONIAN_CONTENT_CACHE_TTL_SECONDS`, default 24 hours). The api.data.gov key allows 1,000 requests per hour and every caller of a deployment shares it, so the repeated identical search and the get_object → get_media → find_related chain on one record (three reads of one record) cost one request per TTL. The cache is per instance, holds 64 MiB counted in UTF-8 bytes of the stored JSON, and evicts least recently used first. It stores successes only, so an error is never replayed, and concurrent identical requests share one load. The bare and `edanmdm:` forms of an ID share an entry. A TTL of `0` disables both caching and the sharing for that kind of read. Each tool call has one 50 s deadline, shared by every read the call chains (the anchor, each fan-out and deeper chunk, a vocabulary lookup, a harvest), and each read retries within the time the call has left. A read that starts with none left sends nothing and fails `Timeout` (`reason: 'retry_deadline_exceeded'`). The deadline sits 10 s inside the 60 s request timeout MCP SDK clients default to, so a hung upstream fails here first; a deadline per read would multiply by the reads a call chains. A caller whose read joins a shared load waits on it only until its own deadline, then rejects `Timeout` alone; the shared load keeps its own 50 s ceiling from its start and is aborted once no caller waits, so one caller's cancellation or expiry never cancels a request another caller waits on. A warm vocabulary or stored cache entry still answers after the deadline, since it sends no request. Cancelling a call ends a pending backoff at once.

The shared-load half lives in `src/services/smithsonian/shared-loads.ts`, which `ResponseCache` and the vocabulary read both use. Concurrent cold reads of one field's vocabulary in one tenant share one `/terms` request, keyed by tenant and field as storage is: the load runs on its own signal and 50 s ceiling, writes storage before any waiter resumes, and stores nothing when it fails. `SMITHSONIAN_TERMS_CACHE_TTL_SECONDS=0` turns this sharing off with the cache, so each read then runs on its caller's own signal and deadline.

### Vocabulary loads are keyed by tenant and field, with storage as the only store

The vocabulary read uses `SharedLoads` directly, not `ResponseCache.fetch`: `fetch` would hold a second copy of each vocabulary (`topic` alone is about 3.8 MB) in the 64 MiB instance cache beside the one in `StorageService`. Keying the load as storage is keyed means one load writes the one entry its callers read.

### Open Access mirror

The Smithsonian publishes the whole Open Access corpus as bulk metadata in a public S3 bucket. The server can hold a local SQLite copy and answer from it, which spends none of the shared 1,000-per-hour key budget.

- **Off by default.** The full mirror needs about 17 GB of disk (measured on a 75k-record sample and extrapolated per unit) and an operator-run first build, and a default install should work with only an API key. `SMITHSONIAN_MIRROR_PATH` turns it on; the variable stays out of `server.json` and `manifest.json` because the one-click install has no place to build a corpus.
- **What it answers.** Object reads (`get_object`, `get_media`, the `find_related` anchor) once the mirror is ready, falling back to the live API on a miss or a store error. Filter-only searches (empty or `*` query) within a 100,000-index-entry scan budget, measured to keep a mirror query to tens of milliseconds of synchronous work, `filters.on_view_only` included (an `on_view` presence facet derived from `onPhysicalExhibit` "Yes"). Free text, over-budget searches, and `list_terms` stay live.
- **Stored subset.** Each stored record keeps the fields the tools read, among them `onPhysicalExhibit` and the `exhibition` entries (`building`, `room`, `exhibitionTitle`) that `get_object` reports as `on_view` and `current_exhibitions`, the `freetext` entries `setName` and `objectRight` that it reports as `sets` and `object_rights`, and for each 3D file the `category`, `filename`, and `attributes[]` (filtered to `UNITS`, `FILE_TYPE`, `MODEL_FILE_TYPE`, `DRACO_COMPRESSED`, and `FILE_SIZE`) that `get_media` with `media: "3d"` reads.
- **Schema upgrades.** `SCHEMA_VERSION` 2 added the on-view fields and the `on_view` facet; version 3 added the `setName`, `objectRight`, and 3D file keys. Opening a store built under an older version migrates it by clearing every shard's ETag (so the next sync re-reads the whole bucket) and, from version 2, adding the `shards_etag` index, which answers the stale-shard probe without a scan; the migration is proportional to the shard count, not the record count. A version 3 sync rewrites nearly every stored doc, since most records carry `setName`; facet rows are unchanged. Until a shard is re-read, its records and every `on_view` search are answered from the live API, while other filter-only searches stay on the mirror. On a version 1 store the reason is that a stale shard's records are not yet indexed under `on_view`, so a mirror count would be short; from version 2 on, routing a stale shard live is the conservative choice, since its stored docs lack the newer keys. A server with a refresh schedule (HTTP with a cron expression) starts the refresh at once instead of waiting for its next tick; one without logs a startup notice naming `mirror:refresh`. A rollback across a schema bump needs one manual step on the way back: the older release keeps the newer stamp while it rewrites changed shards under its older subset, so the newer release reopens the store without migrating and serves those docs without the newer keys. Before redeploying the newer release, clear every shard's ETag (`sqlite3 <store> 'UPDATE shards SET etag = NULL'`) so its next refresh re-reads the bucket.
- **Ordering.** Mirror pages run in ingest order, not the live API's, so a notice says so and a walk lines up only while `sources` stays the same.
- **Provenance.** The five object-reading tools gain `sources` (`oa_mirror`, `edan_api`) and `mirror_snapshot` (ISO date of the bulk publish) when a mirror is configured, so an agent can cite the snapshot beside a count. A server without a mirror sets neither field.
- **Build and refresh.** `mirror:init`, `mirror:refresh`, and `mirror:status` run `dist/mirror/cli.js`; init and refresh run the same shard-by-shard pass, resumable after an interrupt. On HTTP, a cron job (`SMITHSONIAN_MIRROR_REFRESH_CRON`, default `0 12 * * *` in server local time, empty for none) runs the CLI refresh in a child process so its per-shard transactions never stall serving threads or `/healthz`; the expression is validated at startup. On stdio the operator refreshes out-of-band. The store's sync lease lets one sync run at a time: a CLI run that finds the lease held exits 75 without syncing, and the cron job logs that tick as skipped, not failed. Teardown stops the refresh child and closes the store.
- **Only init starts a build.** A refresh of a store holding no shards fails with `mirror_not_built` before any request. The first build downloads the whole bucket, so a scheduled refresh of a mistyped `SMITHSONIAN_MIRROR_PATH` must not start one. Startup opens a missing file as an empty store, logs a warning naming the variable, and answers live. That keeps the documented Docker flow working: the container starts first and `mirror:init` runs inside it. A file that isn't a SQLite store fails startup with a `ConfigurationError` naming the variable.
- **Never VACUUM the store.** The `facets` index stores `objects.rowid`, which `VACUUM` may renumber for a table without an integer primary key, pointing facet entries at the wrong records.
- **Dependencies.** `node-cron` schedules the refresh. `better-sqlite3` is an optional peer, needed on Node only.
- **Docker.** The image creates `/var/lib/smithsonian-mcp-server`, owned by the runtime user, for a mounted volume; the operator sets the path and runs `docker exec <container> bun run mirror:init`.

### The museum alias is match-only

`smithsonian_list_terms` `contains` matches a few extra names per `unit_code` (National Museum of Natural History for the NMNH divisions, Freer Gallery of Art and Arthur M. Sackler Gallery for `NMAA`, Cooper-Hewitt, National Design Museum for `CHNDM` and `CHSDM`) without relabeling. `museum_name` keeps its sourced data-dictionary label: relabeling would change it on every object tool and split it from `holding_museum_name`, which reads `data_source` verbatim.

### Published agent skill

`skills/smithsonian-guide/SKILL.md` carries the gates that tool descriptions can't hold: `OR` never widens a search, a museum that spans several unit codes, place terms that are separate strings, the `name` filter matching every role, a record's indexed name read from `get_object`, what the on-view flag does and doesn't say, and mirror-served pages. It ships in the npm package, the Docker image, plugin installs, and the `.mcpb` bundle, and `createApp({ skills: 'skills' })` serves it over MCP as `skill://smithsonian-guide/SKILL.md`. The server `instructions` point to it.

### Object metadata and image licenses are separate

The catalog has two distinct CC0 flags:
1. `content.descriptiveNonRepeating.metadata_usage.access` — the object *metadata* license
2. Per-media-item `media[].usage.access` — each image's or 3D package's individual license

`smithsonian_get_media` gates delivery on each image's license, or with `media: "3d"` on each package's, and surfaces `is_cc0` on both the object and each returned item. The metadata flag does not gate delivery: an object can have CC0 metadata and restricted images, or the reverse.

---

## Known Limitations

- **No category browse endpoint**: The open API exposes `/terms/{field}` for flat filter vocabularies (what `smithsonian_list_terms` reads) but no `/category/search`. `smithsonian_browse_category` works around this via constrained search and can't return true hierarchical category trees.
- **Some filter values require object discovery**: `object_type`, `name`, and the `place`, `date`, and `topic` values of a particular record come from `get_object.indexed` on a record that carries them (`object_type` can also be harvested from search results). Scientific names come from `get_object.scientific_names`. `object_type` and `name` are not enumerable through `list_terms`; the other supported vocabularies, including media types, are.
- **No off-view filter and no on-view census**: the on-display flag is set on about 13,000 records from 13 museums, so `on_view_only` selects flagged objects and an unflagged object may still be on view.
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

A 3D package is a `3d_voyager` item. Its `content` is the Voyager viewer page, and each `resources[]` entry is a downloadable file. Per-file keys sit in `attributes[]`, which can hold them in one object or split across several:

```json
{
  "type": "3d_voyager",
  "usage": { "access": "CC0" },
  "content": "https://3d-api.si.edu/voyager/3d_package:c0bc58e6-b172-4543-ad58-50261aea523c",
  "resources": [
    {
      "url": "https://3d-api.si.edu/content/document/3d_package:c0bc58e6-b172-4543-ad58-50261aea523c/resources/TYCHO-100k-2048_std_draco.glb",
      "category": "Low Resolution",
      "filename": "TYCHO-100k-2048_std_draco.glb",
      "attributes": [
        { "UNITS": "m", "FILE_TYPE": "draco compressed glb", "MODEL_FILE_TYPE": "draco compressed glb", "DRACO_COMPRESSED": true, "GLTF_STANDARDIZED": false },
        { "FILE_SIZE": 2567980 }
      ]
    }
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
| NZP | Smithsonian's National Zoo & Conservation Biology Institute |
| SIL | Smithsonian Libraries |
| AAA | Archives of American Art |

### Resilience

- **Error-in-200 responses**: The service checks the top-level `error` before treating a 200 as success. `API_KEY_MISSING` raises non-retryable `InternalError`; `OVER_RATE_LIMIT` raises retryable `ServiceUnavailable`. Real HTTP 429 responses map to `RateLimited`.
- **A 200 without its payload**: a read refuses a 200 that lacks what the endpoint always carries, because EDAN answers a missing record with HTTP 404 and an unknown terms field with HTTP 400, so a bare 200 is an upstream fault, and cached as an empty page, vocabulary, or record it would be served to every caller for its TTL. The payloads are a `response.rows` array with a numeric `response.rowCount` for `/search`, a `response` carrying a string `url` for `/content`, and a `response.terms` array for `/terms`. A reply without it raises retryable `ServiceUnavailable` with `reason: 'upstream_unavailable'`, is retried within the call's deadline, and is never cached. Only an HTTP 404 on `/content/{id}` is `not_found`.
- Transient failures retry with exponential backoff (base 2s, max 3 retries), all inside the call's one 50 s deadline, which every read of the call shares; each read gets the time the call has left, and one that starts with none sends nothing and fails `Timeout` (`reason: 'retry_deadline_exceeded'`). A tool that makes a single read keeps a 50 s bound too, because the retry loop gives up early when its next backoff would outlast the time left.
- `fetchWithTimeout` maps non-OK HTTP statuses to their corresponding error codes. A 404 on `/search` or `/terms/{field}` is reclassified as retryable `ServiceUnavailable`; `/content/{id}` retains `NotFound`.
- **Refused key**: the api.data.gov edge answers a missing or invalid key with HTTP 403 and an `API_KEY_*` code in its JSON body. The captured body stays on the server, so the service reads the code from it and raises non-retryable `Forbidden` with `reason: 'api_key_rejected'`, `errorCode`, and a recovery hint naming `SMITHSONIAN_API_KEY`. Any other 403 keeps the status-mapped `Forbidden`.
- The API key is sent in the `X-Api-Key` header, never in URLs.
