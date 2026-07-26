# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.3.4](changelog/0.3.x/0.3.4.md) — 2026-07-26

Neighbor-substring recovery hints now search for the tightest narrow substring instead of trying three fixed candidates

## [0.3.3](changelog/0.3.x/0.3.3.md) — 2026-07-26

Indexed-term recovery hints now name a proven contains substring instead of the failing value itself

## [0.3.2](changelog/0.3.x/0.3.2.md) — 2026-07-26

Add topic and name as filterable facets; find_related's named-party signal now labels roles from the catalog instead of hardcoding maker

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-07-26

Fix Lucene filter escaping, symmetric CC0 rendering in browse_category, and correct the stale 19.4M corpus count to 14.5M

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-07-26 · ⚠️ Breaking

Rename search_objects/find_related date_decade filter to date and accept the full indexed date vocabulary, not just decades

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-07-25

Add a no_images error reason to smithsonian_get_media, dedupe get_object topics, and correct is_cc0/cc0_only description accuracy

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-07-25

Cache term vocabulary with a TTL, add unit_code museum-name labels, and stop recovery hints looping on indexed-but-empty terms

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-07-25 · ⚠️ Breaking

Breaking: rename smithsonian_search/smithsonian_explore to smithsonian_search_objects/smithsonian_browse_category; fix unquoted unit_code filter leaking free text

## [0.1.18](changelog/0.1.x/0.1.18.md) — 2026-07-22

Add smithsonian_find_related per-signal continuation and smithsonian_explore pagination; fix past-the-end no_results/truncation handling in search and list_terms; name the retrieval path in every truncation notice

## [0.1.17](changelog/0.1.x/0.1.17.md) — 2026-07-19

Fix not_found errors missing their recovery hint, smithsonian_explore museum mode silently free-texting unrecognized values, and museum_name falling back to raw codes for most of the vocabulary; correct the online_only field description

## [0.1.16](changelog/0.1.x/0.1.16.md) — 2026-07-19

Correct smithsonian_explore's curated/representative language to match its first-page behavior, tighten tool-definition prose across the surface, fix NMNH unit-code examples, and enforce the date_decade format at the schema boundary

## [0.1.15](changelog/0.1.x/0.1.15.md) — 2026-07-11

Raise smithsonian_find_related's per-signal reach to 5,000 via chunked upstream fetches so deep pages past the old 100-row wall are reachable and truncationCeiling stays honest; align the Codex plugin description with the tool contract

## [0.1.14](changelog/0.1.x/0.1.14.md) — 2026-07-10

Add a contains substring filter to smithsonian_list_terms, route smithsonian_search's filtered-zero recovery through it, and align get_object/find_related descriptions with their actual output contract

## [0.1.13](changelog/0.1.x/0.1.13.md) — 2026-07-10

Add start-paged continuation and truncationCeiling to smithsonian_find_related; fix get_object topic truncation and find_related signal accumulation; refine package/manifest metadata

## [0.1.12](changelog/0.1.x/0.1.12.md) — 2026-07-10

Add ctx.fail() recovery hints and filtered-search term suggestions across all tools, plus a date field on search summaries; fix list_terms past-end pagination; adopt mcp-ts-core 0.10.14 with Socket supply-chain scanning and Dockerfile hardening

## [0.1.11](changelog/0.1.x/0.1.11.md) — 2026-07-04

Fix materials/dimensions duplication and missing not_found reason data; remove non-functional SMITHSONIAN_MAX_ROWS env var; reword tool descriptions and reconcile docs to as-built

## [0.1.10](changelog/0.1.x/0.1.10.md) — 2026-07-04 · 🛡️ Security

Fix output-schema crash on non-truncated results, list_terms upstream shape and filter vocabulary guidance; patch js-yaml DoS advisory GHSA-h67p-54hq-rp68; adopt mcp-ts-core 0.10.10

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-06-20

Adopt @cyanheads/mcp-ts-core 0.10.9 — ctx.content media collector, Canvas SQL invalid_sql classification, fresh-scaffold devcheck guards, plugin-manifest + floating-specifier lint; re-sync scripts and skills

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-06-15

Run the release:github script under bun instead of tsx, matching the rest of the script toolchain

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-06-12

Adopt @cyanheads/mcp-ts-core 0.10.6; truncation enrichment on list tools, ValidationError migration, Docker healthcheck, MCPB bundle cleaner; sync skills

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-06-04

Add smithsonian_list_terms tool — enumerate valid filter vocabulary for unit_code, object_type, culture, place, date, and other indexed fields

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-06-02

Adopt @cyanheads/mcp-ts-core 0.9.21; sync skills (api-mirror, orchestrations, 8 updated); add release:github script

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-05-31

Fix media_summary.count/get_media count mismatch; add cc0_image_count field that reconciles with get_media by construction

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-31

Fix structured filters being silently dropped, fix find_related fan-out returning only first signal's results, remove non-functional online_media_type filter

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-31

Remove DataCanvas integration from smithsonian_search; fixes rows > 20 crash on hosted instance

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-30

Public hosted endpoint at https://smithsonian.caseyjhand.com/mcp

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-30

Initial release — 5 tools for searching, browsing, and retrieving CC0 media from the Smithsonian Open Access API (19.4M objects, 20+ museums). Requires a free api.data.gov key.
