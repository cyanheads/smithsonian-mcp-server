<div align="center">
  <h1>@cyanheads/smithsonian-mcp-server</h1>
  <p><b>Search 14.5M Smithsonian Open Access objects across 20+ museums via MCP, and retrieve CC0 images for the 5.2M that carry openly-licensed media. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/smithsonian-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/smithsonian-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/smithsonian-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.14-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/smithsonian-mcp-server/releases/latest/download/smithsonian-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=smithsonian-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvc21pdGhzb25pYW4tbWNwLXNlcnZlciJdLCJlbnYiOnsiTUNQX1RSQU5TUE9SVF9UWVBFIjoic3RkaW8iLCJTTUlUSFNPTklBTl9BUElfS0VZIjoieW91ci1hcGkta2V5In19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22smithsonian-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fsmithsonian-mcp-server%22%5D%2C%22env%22%3A%7B%22MCP_TRANSPORT_TYPE%22%3A%22stdio%22%2C%22SMITHSONIAN_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://smithsonian.caseyjhand.com/mcp](https://smithsonian.caseyjhand.com/mcp)

</div>

---

## Prerequisites

> **A free `api.data.gov` API key is required.** Register at [https://api.data.gov/signup](https://api.data.gov/signup) — approval is instant. Set it as `SMITHSONIAN_API_KEY` in your MCP client config or `.env` file. The server will not start without it.
>
> **CC0 media gating:** `smithsonian_get_media` only returns CC0-licensed (open access) images. Use `smithsonian_search_objects` with `filters.cc0_only: true` to find objects with downloadable media before calling it.

---

## Tools

Six tools covering the full Smithsonian Open Access workflow — filter vocabulary discovery, search, detail retrieval, CC0 image access, and cross-collection exploration:

| Tool | Description |
|:---|:---|
| `smithsonian_search_objects` | Search across 14.5M objects by text query with optional filters (museum, type, date term, culture, place, topic, name, online-only, CC0). Returns curated summaries with total count. |
| `smithsonian_list_terms` | Enumerate the valid term vocabulary for an indexed filter field (unit_code, culture, place, date, online_media_type, topic). Call before filtering to avoid empty results from invalid values; pass `contains` to resolve a guessed value to its exact term(s). `unit_code` terms come back with their museum names. |
| `smithsonian_get_object` | Fetch a normalized catalog metadata projection for an object by ID: title, dates, materials, dimensions, exhibition history, credit line, and identifiers. |
| `smithsonian_get_media` | Return all CC0-licensed images for an object at multiple resolutions (thumbnail, screen, high-res JPEG/TIFF). Only CC0 images returned, never an empty list — a distinct error reason names why, whether the object has nothing digitized, only non-image media, or only restricted images. |
| `smithsonian_browse_category` | Browse objects within one exact category (museum, culture, period, medium, topic) with total count, a page of objects, and museum breakdown. Requires an exact indexed category term. |
| `smithsonian_find_related` | Discover cross-collection objects related to an anchor, matched on shared culture, named-party, topic, and period signals. |

### `smithsonian_search_objects`

Full-text search with structured filters across the entire Smithsonian catalog.

- Free-text search over 14.5M objects from 20+ museums
- Filters: museum unit code, object type, indexed date term (`1920s`, `500-1500`, `21st century`, `-2500`), culture, geographic place, subject topic, named party (`name`), online-only, CC0-only
- `topic` and `name` are hard indexed constraints, not free text — `topic: "Quilts"` matches 1,134 objects where the bare word matches 2,677, and `name: "Warhol, Andy"` matches 421 against 715
- Returns curated summaries: title, date, museum, object type, thumbnail URL, CC0 flag, `record_id`
- Use `start` + `rows` for standard pagination (offset-based, max 100 per page)

---

### `smithsonian_list_terms`

Enumerate the valid term vocabulary for an indexed filter field before applying filters.

- Supported fields: `unit_code`, `culture`, `place`, `date`, `online_media_type`, `topic`
- Returns the field's distinct term values as a page of the full vocabulary — no per-term object counts are available upstream
- Smithsonian uses a controlled vocabulary (terms are often plural, e.g. `Paintings` not `Painting`) — grounding filter values here avoids empty results
- Pass `contains` to filter the vocabulary by a case-insensitive substring — resolve a guessed value (e.g. `greek` → `Greek, Attic`) to its exact term(s) in one call, or confirm absence with an empty result
- For `unit_code`, a `labels` map returns each code's museum name and `contains` matches that name as well as the code, so `National Air and Space` resolves to `NASM` in one call
- Paginate with `start` + `rows` (default 50 per page, max 100); the largest vocabularies are `topic` (133k terms) and `place` (114k), so pair those with `contains`
- Each field's vocabulary is cached for `SMITHSONIAN_TERMS_CACHE_TTL_SECONDS` (default 1 hour) — upstream ignores paging and returns the whole set on every call, so paging a large vocabulary uncached re-downloads it each time
- `object_type` is not enumerable upstream — discover object-type values from the `object_type` field in `smithsonian_search_objects` results

---

### `smithsonian_get_object`

Normalized catalog metadata for a single object.

- Input: `record_id` from `smithsonian_search_objects` — do not construct IDs manually
- Returns the exposed catalog fields: title, dates (all labeled), makers (with roles), materials, dimensions, place associations, culture terms, topic/subject terms, exhibition history, accession identifiers, credit line, rights statement
- Media summary included — call `smithsonian_get_media` for full image URLs

---

### `smithsonian_get_media`

CC0-gated image access at multiple resolutions.

- Only CC0-licensed images are returned; throws `Forbidden` when an object has media but none is CC0
- Throws `no_images` when an object's media is entirely non-image (scanned books, 3D models, sound recordings); the recovery hint names the types present
- Each image entry includes thumbnail (~120px), screen-size (~800px), and high-resolution JPEG/TIFF URLs with pixel dimensions
- Use `smithsonian_search_objects` with `filters.cc0_only: true` before calling this tool

---

### `smithsonian_browse_category`

Paginated browse within one exact category. For open-ended or topic discovery, use `smithsonian_search_objects` instead.

- Five modes: `museum` (by unit code, e.g. `"NASM"` — matched exactly, not by museum name), `culture` (e.g. `"Aztecs"`), `period` (indexed date term, e.g. `"1940s"` or `"500-1500"`), `medium` (object type, e.g. `"Paintings"`), `topic` (subject term, e.g. `"Quilts"`)
- `value` must be an exact indexed category term — resolve `museum`, `culture`, `period`, and `topic` vocabulary with `smithsonian_list_terms` first; `object_type` is not enumerable there, so harvest it from `smithsonian_search_objects` results
- Returns total count, a page of sample objects, and a museum breakdown showing which institutions hold matching items (computed from the current page)
- Use `start` + `rows` for standard pagination (offset-based, `start = page × rows`, max 50 per page) — adjacent pages retrieve the objects a capped sample omits
- A category value that matches nothing throws `invalid_category` with a mode-specific recovery hint. A value outside the vocabulary gets the exact `smithsonian_list_terms` call that resolves it; a value the index enumerates but that matches no objects is named as such and routed elsewhere, since resolving it returns the same value

---

### `smithsonian_find_related`

Cross-collection discovery via shared metadata signals.

- Matches the anchor's culture, named-party, topic, and period+type metadata signals against the wider catalog
- The named-party signal carries the catalog's own role for the party (`maker`, `collector`, `donor`, `issuing authority`, …) rather than a fixed `maker` label, prefers the indexed `name` facet as a hard filter when the record has one, and is dropped when its value only repeats the culture signal
- The topic signal is a hard `topic:` filter, so every object it tags carries that subject term rather than merely mentioning the word
- Surfaces related objects from across collections, each tagged with the metadata signals that connected it to the anchor
- Cross-museum discovery is the differentiator — an NASM aerospace anchor may surface related objects from NMNH, SAAM, and NMAH
- `similarity_signals` on each result show every metadata term that connected it to the anchor — an object surfaced by more than one signal carries all of them
- Page past a truncated result with `start` — a 0-indexed offset into the interleaved related set; page contiguously with `start = page × limit` (each signal is reachable to a depth of 5,000, fetched in ≤1,000-row chunks; a deeper page can shift an object by a bounded amount near a seam). A truncated response reports `truncationCeiling` as an upper bound on the reachable related pool
- `signals[]` breaks the fan-out down per signal: `row_count` is that signal's true upstream size (uncapped, so it can exceed the 5,000 reach) and `search_continuation` is the exact `smithsonian_search_objects` input that retrieves the signal's full match set at any depth — the retrieval path past this tool's per-signal reach

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Smithsonian-specific:

- Wraps the [Smithsonian Open Access API](https://edan.si.edu/openaccess/apidocs/) (14.5M objects across 20+ museums, 5.2M carrying CC0 media) with a free `api.data.gov` key
- CC0 gating on `smithsonian_get_media` — only open-access images returned, never restricted content
- Graceful degradation in `smithsonian_find_related` — a failure in one metadata signal doesn't abort the rest
- Response normalization across heterogeneous museum metadata schemas

Agent-friendly output:

- `has_media` on every object summary — agents can gate image download calls without an extra lookup (the `is_cc0` flag is the metadata license, which the Open Access corpus carries almost everywhere)
- Typed error reasons (`no_results`, `invalid_filter`, `not_found`, `no_media`, `no_images`, `not_cc0`, `invalid_id`) with recovery hints for each case
- `similarity_signals` on related-object results let agents explain why objects were surfaced
- `total_count` on all search responses enables agents to communicate result scope before paginating

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

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
- A free `api.data.gov` API key — register at [https://api.data.gov/signup](https://api.data.gov/signup). Approval is instant.

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
| `SMITHSONIAN_TERMS_CACHE_TTL_SECONDS` | Seconds to cache each indexed field's term vocabulary. `0` disables caching. | `3600` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

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
| `src/index.ts` | `createApp()` entry point — registers tools and initializes the Smithsonian service. |
| `src/config` | Server-specific environment variable parsing (`SMITHSONIAN_API_KEY`, `SMITHSONIAN_BASE_URL`, `SMITHSONIAN_TERMS_CACHE_TTL_SECONDS`). |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/services/smithsonian` | Smithsonian Open Access API client, normalization, and type definitions. |
| `tests/` | Unit and integration tests. |
| `docs/` | Design document and directory tree. |

---

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) / [`AGENTS.md`](./AGENTS.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools via the barrel in `src/mcp-server/tools/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

---

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
