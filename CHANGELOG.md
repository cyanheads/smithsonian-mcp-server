# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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
