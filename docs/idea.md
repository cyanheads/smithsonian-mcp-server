# smithsonian-mcp-server — Idea & Requirements

Smithsonian Open Access — 19.4M objects across 20 museums and research centers, with deep metadata, provenance, and high-resolution open-access imagery.

| | |
|---|---|
| **Status** | Pre-build design · scaffolded on `@cyanheads/mcp-ts-core@0.9.16` |
| **Category** | external-data |
| **Auth** | none |
| **API cost** | free — no key (rate-limited) |
| **Pattern** | deep single-source |
| **Complexity** | low |
| **Composes with** | `wikipedia-mcp-server`, `wikidata-mcp-server` |

## Overview

Museum collections and natural history across the Smithsonian Institution's 20 museums and research centers — 19.4 million objects spanning art, natural-history specimens, aerospace artifacts, American history, African American culture, Indigenous collections, scientific instruments, and photography.

The API earns a standalone server: a single source, but with massive coverage, deep metadata, high-resolution imagery, and cross-collection discovery an LLM can reason over in ways the raw catalog search can't.

## Audience

Educators, researchers, history/science enthusiasts, content creators, students, cultural-heritage professionals. Museum collections carry inherent browsing appeal plus serious research utility.

## User Goals

- Find objects related to a topic, period, culture, or material across all 20 museums
- Get detailed provenance, materials, and exhibition history for a specific artifact
- Browse a museum's collection by category, period, or medium
- Discover connections between objects across museums
- Access high-resolution images for open-access (CC0) objects
- Research a culture, artist, or scientific domain through the collection lens

## API Surface

Single API, keyless, free, rate-limited. Elasticsearch-style query language with nested filters.

| Capability | Purpose |
|:---|:---|
| Search | Full-text across all collections; faceted by museum / type / date / place / culture / medium |
| Object detail | Full metadata, provenance, materials, dimensions, images, related objects |
| Category browse | Hierarchical navigation by museum unit, object type, topic |
| Image access | IIIF-compatible image URLs for open-access objects |
| Terms / facets | Valid filter values for structured queries |

Good candidate for the convenience-shortcut pattern: plain text search for the 80% case, structured filters for power users.

## Tool Surface (planned)

Organized around discovery and research workflows, not raw endpoints.

| Tool | Behavior |
|:---|:---|
| `smithsonian_search` | Full-text across all 19.4M objects. Shortcut `query` for simple search; structured filters (museum, object_type, date_range, culture, place, medium, maker). Returns thumbnails, attribution, object IDs, and faceted counts so the agent narrows without a separate facet call. |
| `smithsonian_get_object` | Full record by ID: title, description, date, materials, dimensions, provenance, exhibition history, unit, collection, credit line, image URLs (multi-resolution), related object IDs. |
| `smithsonian_explore` | Guided browse by category. Mode: `museum` \| `culture` \| `period` \| `medium`. Returns a category overview with sample objects and counts — the "what does the Smithsonian have about X?" entry point. |
| `smithsonian_find_related` | Given an object ID, find related items across collections via the API's relatedness data plus metadata similarity (culture, period, medium, maker, topic). Cross-museum discovery is the value-add. |
| `smithsonian_get_image` | High-res IIIF image URL(s) at multiple resolutions. Open-access (CC0) objects only; states access status clearly when an object isn't open. |

## Design Notes & Requirements

- **Curate output for the LLM's next decision** — the API returns large nested objects; don't pass through raw Elasticsearch hits. Format as structured markdown (title, date, museum, one-line description, thumbnail).
- **`smithsonian_explore` uses the mode-consolidation pattern** — one tool with a category enum instead of four browse tools.
- **Cross-collection discovery is the differentiator** — the raw relatedness field is shallow; the LLM reasons about deeper connections by combining metadata across objects.
- **IIIF images** integrate with image-capable MCP clients — the model can describe the artifact photo.
- Route large search results (some queries return thousands of objects) to DataCanvas.
- Composes with Wikipedia/Wikidata for context on topics, artists, and events surfaced through browsing.

## Build Constraints

- Framework: `@cyanheads/mcp-ts-core@0.9.16`
- No credentials → fully hostable
- Respect the rate limit; cache where sensible
- Honor open-access flags before returning image URLs
