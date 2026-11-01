---
name: smithsonian-guide
description: Gates and workflows for the smithsonian_* tools over the Smithsonian Open Access catalog. Covers query syntax (OR never widens a search), counting a museum's or a place's holdings, finding a person's indexed name through smithsonian_find_related, genus-level scientific names, and mirror-served pages. Use before reporting a Smithsonian count, comparison, or absence, or before filtering by a person, museum, place, or taxon.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

The Smithsonian Open Access catalog through the EDAN API. Museum objects, natural-history specimens, and Smithsonian Libraries and Archives records share one index, so library records sit beside objects in every search: the `name` filter `Warhol, Andy` opens on Smithsonian Libraries books (unit `SIL`). Scope a question about objects with a `unit_code` or `object_type` filter. The API has no per-term record counts and no category hierarchy, so every count is one search's `total_count`, which comes back with any page size; a `rows` of 1 is enough to count.

## Identifiers

| Identifier | Comes from | Goes to |
|:--|:--|:--|
| `record_id` | Rows of smithsonian_search_objects, smithsonian_browse_category, smithsonian_find_related; the `edanmdm:`-prefixed form also works | smithsonian_get_object, smithsonian_get_media, smithsonian_find_related |
| Indexed name (`Warhol, Andy`) | Only a smithsonian_find_related signal (Workflows below) | The `name` filter, which matches the whole indexed string: `Warhol` alone and the `makers[]` form `Warhol, Andy 1928-1987` both match nothing |
| Scientific name | smithsonian_get_object `scientific_names` | The `scientific_name` filter, which also takes a bare genus: `Crotalus` matches 1,877 records across its species, `Crotalus horridus` 281 |
| `holding_museum_name` | Search and related rows; smithsonian_get_object | Nothing. It names the holding unit when that differs from `unit_code` (the 3D scans below) and is never a filter value |

## Gates

**`OR` never widens a search.** EDAN requires every plain word in `query`: `totem pole` returns about a third of what `totem` does, and a quoted phrase narrows it slightly further. `OR` and parentheses change nothing. `quilt OR coverlet`, `(quilt OR coverlet)`, and `quilt coverlet` all return the same 121 records, while `coverlet` alone returns 707. Field clauses joined by `OR` return 0 (`unit_code:"NMNHBIRDS" OR unit_code:"NMNHPALEO"`). `NOT` does exclude, with or without filters: `quilt NOT coverlet` returns 2,694 minus those 121. For words A or B, add the totals of `A` and `B NOT A`.

**A museum can span several codes.** The National Museum of Natural History has no unit code of its own. Its records sit under 11 division codes (`NMNHANTHRO`, `NMNHPALEO`, …), which smithsonian_list_terms lists for field `unit_code` with `contains` `NMNH`. Codes can't be joined with `OR`, so cover a museum with one search per code. The 3D digitization office's own scans are indexed under its code, `OCIO_DPO3D`, not under the unit that holds the scanned object: `"Homo erectus"` returns nothing under `NMNHANTHRO` and 17 scans under `OCIO_DPO3D`. Add `OCIO_DPO3D` to a museum-wide search and keep the rows whose `holding_museum_name` names that museum.

**Place terms are separate strings, not a hierarchy.** `United States` (about 5 million records) and `United States of America` (7,951) are distinct terms, and a record filed under a state alone, such as `Kentucky`, carries no country term. Before counting by place, list the variants with smithsonian_list_terms (field `place` with a `contains` substring), search each one you mean, and say which you counted.

**The `name` filter matches every role.** It matches a party as Author, Subject, Collector, Donor, or maker alike, so `Warhol, Andy` returns library books about Warhol beside his works. Before calling a record someone's work, check the role in smithsonian_get_object `makers[]`, or narrow the search with a museum's `unit_code` or an `object_type`.

**Mirror-served pages.** A deployment can answer record reads and filter-only searches from a snapshot of the Open Access bulk metadata. A response's `sources` says where it came from (`oa_mirror`, `edan_api`) and `mirror_snapshot` dates the snapshot; cite that date beside a count drawn from it. Mirror pages run in mirror order, not the live API's, so the pages of one walk line up only while `sources` stays the same. A walk with a single filter switches to the live API once `start` plus `rows` passes 100,000. Check `sources` on every page of a long walk, and add a second filter to a walk that deep, which keeps all its pages on one source.

## Workflows

**A person's indexed name.** The `name` filter needs the exact indexed string, and smithsonian_get_object doesn't show it: its `makers[]` is the catalog's free-text form.

1. Search the person's name as free text and pick a record they made.
2. Call smithsonian_find_related on that `record_id`. In `signals`, the entry whose `search_continuation` carries `filters.name` holds the indexed form. It is the record's first indexed name, so if it names someone else, try another record. A signal labelled with a role (`maker:`, `collector:`) with the name in `query` means the record has no indexed name; its value is free text and won't match the filter.
3. Search with that `name` filter, narrowed per the role gate above.
