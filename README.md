<div align="center">
  <h1>@cyanheads/smithsonian-mcp-server</h1>
  <p><b>Search 14.5M Smithsonian Open Access objects across 20+ museums via MCP, and retrieve CC0 images for the 5.2M that carry openly-licensed media. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/smithsonian-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/smithsonian-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/smithsonian-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/smithsonian-mcp-server/releases/latest/download/smithsonian-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=smithsonian-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvc21pdGhzb25pYW4tbWNwLXNlcnZlciJdLCJlbnYiOnsiTUNQX1RSQU5TUE9SVF9UWVBFIjoic3RkaW8iLCJTTUlUSFNPTklBTl9BUElfS0VZIjoieW91ci1hcGkta2V5In19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22smithsonian-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fsmithsonian-mcp-server%22%5D%2C%22env%22%3A%7B%22MCP_TRANSPORT_TYPE%22%3A%22stdio%22%2C%22SMITHSONIAN_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://smithsonian.caseyjhand.com/mcp](https://smithsonian.caseyjhand.com/mcp)

</div>

---

## Overview

The Smithsonian's Open Access catalog: 14.5 million objects across 20+ museums, 5.2 million with CC0 images. Search by free text or category, browse by museum, culture, date, or topic, and discover connections across collections.

### Tools

| Tool | Description |
|:---|:---|
| `smithsonian_search_objects` | Search across 14.5M objects by text query with optional filters (museum, type, date term, culture, place, topic, name, scientific name, media type, online-only, CC0, on view now). Returns curated summaries with total count. |
| `smithsonian_list_terms` | Enumerate the valid term vocabulary for an indexed filter field (unit_code, culture, place, date, online_media_type, topic). Call before filtering to avoid empty results from invalid values; pass `contains` to resolve a guessed value to its exact term(s). `unit_code` terms come back with their museum names. |
| `smithsonian_get_object` | Fetch a normalized catalog metadata projection for an object by ID: title, dates, the labeled physical description, the indexed values usable as search filters, current display, the sets the catalog files it under, credit line, and identifiers. |
| `smithsonian_get_media` | Return an object's CC0-licensed images in catalog order at multiple resolutions (thumbnail, screen, full-size JPEG, archival TIFF), with the object's `cc0_image_count`; with `media: "3d"`, its CC0 3D model packages and their downloadable files, with `cc0_model_count`. Page a long list with `start` and `limit`. Only CC0 media is returned. An object with none fails with a distinct error reason: nothing digitized, no media of the requested kind, or only restricted media. |
| `smithsonian_browse_category` | Browse objects within one exact category (museum, culture, period, medium, topic) with total count, a page of objects, and museum breakdown. Requires an exact indexed category term. |
| `smithsonian_find_related` | Discover cross-collection objects related to an anchor, matched on shared culture, named-party, topic, and period signals. |

### Skill

| Skill | Description |
|:---|:---|
| `smithsonian-guide` | Gates for agents querying the catalog: query syntax (`OR` never widens a search), counting a museum's or a place's holdings, reading a person's indexed name, what an on-view flag does and doesn't say, genus-level scientific names, and mirror-served pages |

Ships in `skills/` for plugin installs, the npm package, the Docker image, and the `.mcpb` bundle, and is served over MCP as `skill://smithsonian-guide/SKILL.md`.

---

## Capability reference

### `smithsonian_search_objects` <sub>tool</sub>

- Free-text search over 14.5M objects from 20+ museums
- Filters append hard `AND` constraints. Plain words and quoted phrases keep their matching semantics; active Lucene expressions are grouped to preserve Boolean precedence.
- `filters.online_media_type` accepts exact `smithsonian_list_terms` media categories such as `Images`, `3D Models`, and `Sound recordings`. These describe the index; even `Images` does not guarantee attached or CC0 images. Check `smithsonian_get_object.media_summary` for deliverability. Media categories feed search, with no media-type browse mode.
- Filters: museum unit code, object type, indexed date term (`1920s`, `500-1500`, `21st century`, `-2500`), culture, geographic place, subject topic, named party (`name`), scientific name (`scientific_name`), indexed media category (`online_media_type`), online-only, CC0-only, on view now (`on_view_only`)
- `topic` and `name` are hard indexed constraints, not free text — `topic: "Quilts"` matches 1,134 objects where the bare word matches 2,677, and `name: "Warhol, Andy"` matches 421 against 715
- Returns curated summaries: title, date, museum, object type, thumbnail URL, CC0 flag, `record_id`, plus `holding_museum_name` when the holding unit differs from the indexed `unit_code` (the 3D digitization scans)
- `filters.on_view_only: true` selects objects the catalog flags as on physical display now (about 13,000 records from 13 museums). Most records carry no flag, so an unflagged object may still be on view, and there is no off-view filter.
- An unknown `filters` key is rejected by name
- Use `start` + `rows` for standard pagination (offset-based, default 20, up to 1,000 per page — a larger `rows` is served at 1,000 with a notice). When objects remain, the notice names the next `start`

---

### `smithsonian_list_terms` <sub>tool</sub>

- Fields: `unit_code`, `culture`, `place`, `date`, `online_media_type`, `topic` — a controlled vocabulary, often plural (e.g. `Paintings`, not `Painting`); ground filter values here before searching or browsing
- `contains` filters the vocabulary by a case-insensitive substring — resolves a guessed value (e.g. `greek` → `Greek, Attic`) in one call; for `unit_code` it also matches museum names (`National Air and Space` → `NASM`) and the names a unit also goes by: National Museum of Natural History for the NMNH divisions, Freer Gallery of Art and Arthur M. Sackler Gallery for `NMAA`, Cooper-Hewitt, National Design Museum for `CHNDM` and `CHSDM`. Name matching ignores case, surrounding whitespace, a leading "Smithsonian" or "Smithsonian's", `&` versus "and", apostrophe style, and hyphens versus spaces; code matching is a plain case-insensitive substring. Each `unit_code` term comes back with a `labels` map of its museum name
- Paginate with `start` + `rows` (default 50, up to 40,000 per page — a larger `rows` is served at 40,000 with a notice); `topic` (133k terms) and `place` (114k) are large enough to pair with `contains`
- No per-term object counts are available upstream — only the term values themselves
- Each field's vocabulary is cached for `SMITHSONIAN_TERMS_CACHE_TTL_SECONDS` (default 3600 seconds, `0` disables the cache and the sharing of concurrent cold reads) — upstream ignores paging and returns the whole set on every call, so paging a large vocabulary uncached re-downloads it each time. Concurrent cold reads of one field share one `/terms` request
- `object_type` is not enumerable here — take it from `smithsonian_get_object` `indexed.object_type` for a known object, or harvest it from the `object_type` field in `smithsonian_search_objects` results

---

### `smithsonian_get_object` <sub>tool</sub>

- Input: `id`, the `record_id` from `smithsonian_search_objects` — do not construct IDs manually. `record_id` is also accepted as the key; sending both fails `invalid_arguments`
- Returns the exposed catalog fields: title, dates (all labeled), makers (with roles), `physical_description`, place associations, culture terms, topic/subject terms, free-text exhibition history (rarely filled, so `[]` does not mean never exhibited), `sets`, accession identifiers, credit line, rights statement
- `physical_description` is `[{ label, value }]`: every catalog entry under its own label (`Medium`, `Dimensions`, `Length - Total`, `Sex`, `Preparation`, `Physical Location`), in catalog order with repeated labels kept. Nothing is sorted by label, since a label can't separate materials from measurements, specimen attributes, or storage locations. `[]` when the record has none
- `object_rights` joins every `objectRights` entry, then every `objectRight` entry, with `; `
- `indexed` holds the `name`, `place`, `object_type`, `date`, and `topic` values the record is indexed under, each passable verbatim to the `smithsonian_search_objects` filter of the same name; the free-text `makers`, `place`, `dates`, and `topics` often differ from them
- Current display for objects the catalog flags: `on_view` (`true` or `false`, absent when the record carries no flag) and `current_exhibitions`, each `{ building?, room?, title? }` where `building` is a building code, not a `unit_code`
- `sets` is `[{ label, value }]` from the catalog's set names, always present (`[]` when the record lists none): the collections and departments an object is filed under and, for a displayed object, the gallery, hangar, or exhibition (`See more items in`, `Location`, `Exhibition`, `On View`). It is catalog text, not a second display flag: a National Portrait Gallery record can read `Location: Currently not on view` with no `on_view`. Venue text comes from here
- Media summary included — call `smithsonian_get_media` for full image URLs, or with `media: "3d"` for the model files of a 3D package. `media_summary.non_image_media[]` lists every media item that is not an image (3D models, scanned books, documents) as `{ type, url?, is_cc0 }`, in catalog order; a 3D item's `url` is its viewer page, not a file
- `holding_museum_name` names the holding unit when it differs from `unit_code`, the code the record is indexed under (the 3D digitization scans); the text output renders it as `Held by`
- All nonempty notes retain their catalog labels and source order. `description` selects recognized prose labels; administrative notes stay labeled.
- Natural-history metadata includes all `scientific_names`, reported `taxonomy` ranks, and valid decimal collection `coordinates` with their own locality when present. The arrays are empty when no names or valid points are available; absent ranks are omitted. No accepted name, geocoding, or accuracy is inferred. Use `scientific_names` as exact `filters.scientific_name` values in search; this field is not enumerable via `smithsonian_list_terms`.

---

### `smithsonian_get_media` <sub>tool</sub>

- Only CC0-licensed media is returned, never restricted content, in catalog order. `media` is `"images"` (the default) or `"3d"`. Images mode returns `images[]` with `cc0_image_count` (the same count as `smithsonian_get_object`'s `media_summary.cc0_image_count`); `"3d"` returns `models[]` with `cc0_model_count`, and `images` is `[]` while `cc0_image_count` still counts the record's CC0 images
- `start` and `limit` page the image list, or with `media: "3d"` the model packages: omit `limit` to get everything from `start`; `limit` is capped at 1,000 and a larger value is served at the cap with a notice. A `start` at or past the count returns an empty list
- Failure reasons when an object has no CC0 media of the requested kind, decided on the whole record before paging: `no_media` (nothing digitized, in either mode), `no_images` (images mode: media exists but is entirely non-image — 3D models, scanned books, documents; the recovery hint names the types present, points to `smithsonian_get_object`'s `media_summary.non_image_media`, which links each item, and for an object with a 3D package names the `media: "3d"` call), `no_models` (`media: "3d"`: media exists but no 3D model package), `not_cc0` (images, or with `media: "3d"` model packages, exist but none are CC0, thrown as `Forbidden`)
- Each image entry includes a thumbnail (~150px), a screen-size image (~1,200px on the long edge), a full-size JPEG (the catalog's high-resolution JPEG with pixel dimensions, or the image's full-size delivery URL without them when none is listed), and an archival TIFF when one exists
- Each 3D package entry carries `media_id`, its Voyager `viewer_url` (a web page, not a file), a `thumbnail_url`, and `files[]`: each file's `url` and, as the catalog spells them, `filename`, `category` (resolution tier such as `Low resolution`, `Full resolution`, `iOS AR model`, `Watertight`), `file_type`, `model_file_type`, `units`, `draco_compressed`, and `size_bytes`. `files` is `[]` when the catalog lists none
- Use `smithsonian_search_objects` with `filters.cc0_only: true` to find objects with downloadable CC0 images, or `filters.online_media_type: "3D Models"` for objects with 3D packages, before calling this tool

---

### `smithsonian_browse_category` <sub>tool</sub>

- Five modes: `museum` (by unit code, e.g. `"NASM"` — matched exactly, not by museum name), `culture` (e.g. `"Aztecs"`), `period` (indexed date term, e.g. `"1940s"` or `"500-1500"`), `medium` (object type, e.g. `"Paintings"`), `topic` (subject term, e.g. `"Quilts"`)
- `value` must be an exact indexed category term — resolve `museum`, `culture`, `period`, and `topic` vocabulary with `smithsonian_list_terms` first; `object_type` is not enumerable there, so take it from `smithsonian_get_object` `indexed.object_type` for a known object, or harvest it from `smithsonian_search_objects` results
- Returns total count, a page of sample objects, and a museum breakdown showing which institutions hold matching items (computed from the current page)
- Use `start` + `rows` for standard pagination (offset-based, default 10, up to 1,000 per page — a larger `rows` is served at 1,000 with a notice). When objects remain, the notice names the next `start` — adjacent pages retrieve the objects a capped sample omits
- A category value that matches nothing throws `invalid_category` with a mode-specific recovery hint: a value outside the vocabulary gets the exact `smithsonian_list_terms` call that resolves it, and a value the index enumerates but that matches no objects is named as such and routed elsewhere. When the vocabulary read fails or the call's time runs out, membership is unknown: the hint names the `smithsonian_list_terms { field, contains: value }` lookup that settles it (for `unit_code` it matches museum names as well as codes), claims neither membership nor non-membership, and says what to do with either answer. The call still fails `invalid_category`
- For open-ended or topic discovery, use `smithsonian_search_objects` instead — this tool requires an exact category value

---

### `smithsonian_find_related` <sub>tool</sub>

- Matches shared culture, named-party, topic, and period+type metadata signals against the wider catalog; cross-museum discovery is the differentiator — an NASM aerospace anchor may surface related objects from NMNH, SAAM, and NMAH
- The named-party signal carries the catalog's own role for the party (`maker`, `collector`, `donor`, `issuing authority`, …) rather than a fixed `maker` label, prefers the indexed `name` facet as a hard filter when the record has one, and is dropped when its value only repeats the culture signal
- The topic signal is a hard `topic:` filter, so every object it tags carries that subject term rather than merely mentioning the word
- `similarity_signals` on each result names every metadata term that connected it to the anchor — an object surfaced by more than one signal carries all of them
- Page with `start` — a 0-indexed offset into the interleaved related set (default `limit` 10, up to 1,000 — a larger `limit` is served at 1,000 with a notice, and the notice names the next `start`); each signal is reachable to a depth of 5,000 (fetched in ≤1,000-row chunks — a deeper page can shift an object by a bounded amount near a seam), and a truncated response reports `truncationCeiling` as an upper bound on the reachable related pool
- `unit_code` scopes every signal to one museum: the indexed code a result row reports (matched exactly and case-sensitively, not checked against the vocabulary), never a `holding_museum_name`. It keeps related objects inside the anchor's museum, or, with another code, finds related objects held elsewhere. Each `search_continuation` carries it as `filters.unit_code`. A scoped call whose signals all come back with no match beyond the anchor says so in its notice and suggests omitting `unit_code`. Omit it, or pass an empty string, to search every museum
- `signals[]` breaks the fan-out down per signal: `row_count` is that signal's true upstream size (uncapped, so it can exceed the 5,000 reach) and `search_continuation` is the exact `smithsonian_search_objects` input that retrieves the signal's full match set at any depth — the retrieval path past this tool's per-signal reach
- Partial failures name the failed signals with safe categories in the same notice as paging guidance; a signal still pending when the call's 50 s deadline passes is named `(timeout)` beside the ones that finished. Empty successes distinguish missing anchor signals, no non-anchor matches, and exhausted pages. All-failed searches reject with the first signal failure; caller cancellation always rejects.

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Smithsonian-specific:

- Wraps the [Smithsonian Open Access API](https://edan.si.edu/openaccess/apidocs/) (14.5M objects across 20+ museums, 5.2M carrying CC0 media) with a free `api.data.gov` key
- CC0 gating on `smithsonian_get_media` — only open-access images and 3D model packages returned, never restricted content; each image and each package is gated on its own license
- Graceful degradation in `smithsonian_find_related` — a failure in one metadata signal doesn't abort the rest
- Response normalization across heterogeneous museum metadata schemas
- In-process response cache — repeated identical searches, and the `get_object` → `get_media` → `find_related` chain on one record, cost one upstream request per cache lifetime against the shared hourly key budget; concurrent cold reads of one field's term vocabulary share one request too
- Optional local mirror of the Open Access bulk metadata ([below](#optional-open-access-mirror)) — object reads and filter-only searches answer from disk instead of spending API requests

Agent-friendly output:

- `has_media` on every object summary — agents can gate image download calls without an extra lookup (the `is_cc0` flag is the metadata license, which the Open Access corpus carries almost everywhere)
- Typed error reasons (`no_results`, `invalid_filter`, `no_terms`, `invalid_category`, `not_found`, `no_media`, `no_images`, `no_models`, `not_cc0`, `invalid_id`, `api_key_rejected`) with recovery hints for each case
- `similarity_signals` on related-object results let agents explain why objects were surfaced
- `total_count` on all search responses enables agents to communicate result scope before paginating
- Over-cap page sizes are served at the cap with a notice instead of rejected, and paging notices name the next `start` outright
- `sources` and `mirror_snapshot` on the five object-reading tools, set only when a mirror is configured, say where an answer came from

---

## Getting started

### Public Hosted Instance

A public instance is available at `https://smithsonian.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "smithsonian-mcp-server": {
      "type": "streamable-http",
      "url": "https://smithsonian.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

> **Requires a free `api.data.gov` API key** — register at [https://api.data.gov/signup](https://api.data.gov/signup) and set `SMITHSONIAN_API_KEY` in your config.

Add the following to your MCP client configuration file:

```json
{
  "mcpServers": {
    "smithsonian-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/smithsonian-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "SMITHSONIAN_API_KEY": "your-api-key"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "smithsonian-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/smithsonian-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "SMITHSONIAN_API_KEY": "your-api-key"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "smithsonian-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "SMITHSONIAN_API_KEY=your-api-key",
        "ghcr.io/cyanheads/smithsonian-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 SMITHSONIAN_API_KEY=your-api-key bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.4](https://bun.sh/) or higher (or Node.js v24+).
- A free `api.data.gov` API key — register at [https://api.data.gov/signup](https://api.data.gov/signup). Approval is instant.
- Optional: about 17 GB of disk for the full [Open Access mirror](#optional-open-access-mirror), and `better-sqlite3` on Node.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/smithsonian-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd smithsonian-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# Edit .env and set SMITHSONIAN_API_KEY
```

---

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `SMITHSONIAN_API_KEY` | **Required.** Free API key from [api.data.gov/signup](https://api.data.gov/signup). | — |
| `SMITHSONIAN_BASE_URL` | Smithsonian Open Access API base URL. | `https://api.si.edu/openaccess/api/v1.0` |
| `SMITHSONIAN_TERMS_CACHE_TTL_SECONDS` | Seconds to cache each indexed field's term vocabulary. `0` disables the cache and the sharing of concurrent cold reads of one field. | `3600` |
| `SMITHSONIAN_SEARCH_CACHE_TTL_SECONDS` | Seconds to cache each search page in memory. `0` disables the cache and the sharing of concurrent identical requests. | `3600` |
| `SMITHSONIAN_CONTENT_CACHE_TTL_SECONDS` | Seconds to cache each object record in memory. `0` disables the cache and the sharing of concurrent identical requests. | `86400` |
| `SMITHSONIAN_CLAMP_LIMITS` | Serve an over-cap `rows` or `limit` at its cap with a notice. `false` rejects it instead and advertises each cap as the schema `maximum`. | `true` |
| `SMITHSONIAN_MIRROR_PATH` | SQLite file path of the [Open Access mirror](#optional-open-access-mirror). Empty or unset turns the mirror off. | — |
| `SMITHSONIAN_MIRROR_REFRESH_CRON` | Cron expression, in server local time, on which an HTTP server refreshes the mirror. Empty turns the in-server refresh off. Checked at startup when the mirror is on. | `0 12 * * *` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_SESSION_MODE` | Session mode: `auto`, `stateful`, or `stateless`. The server declares `stateless` in code; set this only to override it. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). A relative path resolves against the application root, which for an installed server is the server package's own directory. | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

---

## Optional Open Access mirror

By default every read goes to the live Smithsonian API, whose key allows 1,000 requests per hour. The server can instead keep a local SQLite copy of the Smithsonian Open Access bulk metadata and answer from it, so a heavy deployment spends far fewer requests. The mirror is off unless `SMITHSONIAN_MIRROR_PATH` names a file; a default install behaves as described above.

**What it serves**

- Object reads (`smithsonian_get_object`, `smithsonian_get_media`, and the anchor of `smithsonian_find_related`) come from the mirror once it is built, and go live on a miss or a store error.
- Filter-only searches (an empty or `*` query) come from the mirror when they stay within a 100,000-index-entry scan budget.
- Free-text searches, over-budget searches, and `smithsonian_list_terms` stay live.
- `filters.on_view_only` searches come from the mirror too, once every shard has been read under the current schema (see **Upgrading a store** below).
- Mirror pages run in mirror order, not the live API's, and their notice says so.

**Provenance.** Every tool except `smithsonian_list_terms` gains two optional fields when a mirror is configured: `sources` (`oa_mirror`, `edan_api`, or both) and, when part of the answer came from the mirror, `mirror_snapshot` (the ISO date of the bulk publish).

**Build and refresh**

```sh
bun run build
SMITHSONIAN_MIRROR_PATH=./smithsonian-oa.sqlite bun run mirror:init     # one-time build; resumable
SMITHSONIAN_MIRROR_PATH=./smithsonian-oa.sqlite bun run mirror:refresh  # bring it up to date with the bucket
SMITHSONIAN_MIRROR_PATH=./smithsonian-oa.sqlite bun run mirror:status   # print the sync state
```

The `mirror:*` scripts run `dist/mirror/cli.js`. On the HTTP transport the server refreshes the mirror on `SMITHSONIAN_MIRROR_REFRESH_CRON` by running `mirror:refresh` in a child process, so a refresh never stalls requests; on stdio, run `mirror:refresh` yourself. One sync runs on a store at a time: a `mirror:init` or `mirror:refresh` that finds another process syncing the store exits 75 without syncing, and a scheduled refresh that meets one skips that tick. Only `mirror:init` starts a build: a refresh of a store that holds nothing fails and asks for `mirror:init`, and a server whose store has no completed build logs a warning and answers every read live. The store holds the whole corpus, so it needs substantial disk. Never `VACUUM` it: the facet index stores row ids that `VACUUM` may renumber.

On Node, the mirror needs the optional peer dependency `better-sqlite3`; Bun uses its built-in SQLite.

**Upgrading a store.** A store built under an older schema migrates when the server or a `mirror:*` command first opens it, which marks every shard to be re-read on the next sync. Until a shard is re-read, its records are answered from the live API, and so is every `on_view_only` search; other filter-only searches stay on the mirror. A server with a refresh schedule (HTTP, unless `SMITHSONIAN_MIRROR_REFRESH_CRON` is empty) starts that refresh at once; without one, startup logs a notice naming `mirror:refresh`.

**Docker.** The image creates `/var/lib/smithsonian-mcp-server`, owned by the runtime user. Mount a volume there, point `SMITHSONIAN_MIRROR_PATH` at a file inside it, and build once:

```sh
docker exec <container> bun run mirror:init
```

---

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t smithsonian-mcp-server .
docker run --rm -e SMITHSONIAN_API_KEY=your-api-key -p 3010:3010 smithsonian-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/smithsonian-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

---

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and the published skill, and initializes the Smithsonian service and the optional mirror. |
| `src/config` | Server-specific environment variable parsing (`SMITHSONIAN_*`: API key, base URL, cache lifetimes, page-size clamp, mirror path and refresh schedule). |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`), the shared page-size clamp, and mirror provenance fields. |
| `src/services/smithsonian` | Smithsonian Open Access API client, in-memory response cache, Open Access mirror store and ingest, normalization, and type definitions. |
| `src/mirror` | Mirror CLI (`init`, `refresh`, `status`) and the in-server refresh schedule. |
| `skills/smithsonian-guide` | Agent skill published to agents that install the server, and served over MCP as `skill://smithsonian-guide/SKILL.md`. |
| `tests/` | Unit and integration tests. |
| `docs/` | Design document and directory tree. |

---

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) / [`AGENTS.md`](./AGENTS.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools in the `tools` array in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

---

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
