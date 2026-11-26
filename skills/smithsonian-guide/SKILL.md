---
name: smithsonian-guide
description: Gates and workflows for the smithsonian_* tools over the Smithsonian Open Access catalog. Covers query syntax (OR never widens a search), counting a museum's or a place's holdings, reading a person's indexed name from smithsonian_get_object, what an on-view flag does and doesn't say, genus-level scientific names, and mirror-served pages. Use before reporting a Smithsonian count, comparison, or absence, or before filtering by a person, museum, place, taxon, or display status.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.1"
---

## Scope

The Smithsonian Open Access catalog through the EDAN API. Museum objects, natural-history specimens, and Smithsonian Libraries and Archives records share one index, so library records sit beside objects in every search: the `name` filter `Warhol, Andy` opens on Smithsonian Libraries books (unit `SIL`). Scope a question about objects with a `unit_code` or `object_type` filter. The API has no per-term record counts and no category hierarchy, so every count is one search's `total_count`, which comes back with any page size; a `rows` of 1 is enough to count.

## Identifiers

| Identifier | Comes from | Goes to |
|:--|:--|:--|
| `record_id` | Rows of smithsonian_search_objects, smithsonian_browse_category, smithsonian_find_related; the `edanmdm:`-prefixed form also works | smithsonian_get_object, smithsonian_get_media, smithsonian_find_related |
| Indexed name (`Warhol, Andy`) | smithsonian_get_object `indexed.name`, on a record that carries one (Workflows below) | The `name` filter, which matches the whole indexed string: `Warhol` alone and the `makers[]` form `Warhol, Andy 1928-1987` both match nothing |
| Scientific name | smithsonian_get_object `scientific_names` | The `scientific_name` filter, which also takes a bare genus: `Crotalus` matches 1,877 records across its species, `Crotalus horridus` 281 |
| `holding_museum_name` | Search and related rows; smithsonian_get_object | Nothing. It names the holding unit when that differs from `unit_code` (the 3D scans below) and is never a filter value |

## Gates

**`OR` never widens a search.** EDAN requires every plain word in `query`: `totem pole` returns about a third of what `totem` does, and a quoted phrase narrows it slightly further. `OR` and parentheses change nothing. `quilt OR coverlet`, `(quilt OR coverlet)`, and `quilt coverlet` all return the same 121 records, while `coverlet` alone returns 707. Field clauses joined by `OR` return 0 (`unit_code:"NMNHBIRDS" OR unit_code:"NMNHPALEO"`). `NOT` does exclude, with or without filters: `quilt NOT coverlet` returns 2,694 minus those 121. For words A or B, add the totals of `A` and `B NOT A`.

**A museum can span several codes.** The National Museum of Natural History has no unit code of its own. Its records sit under 11 division codes (`NMNHANTHRO`, `NMNHPALEO`, …), which smithsonian_list_terms lists for field `unit_code` with `contains` `NMNH`; `contains` `Natural History` or the official name resolves to the same 11 codes. Codes can't be joined with `OR`, so cover a museum with one search per code. The 3D digitization office's own scans are indexed under its code, `OCIO_DPO3D`, not under the unit that holds the scanned object: `"Homo erectus"` returns nothing under `NMNHANTHRO` and 17 scans under `OCIO_DPO3D`. Add `OCIO_DPO3D` to a museum-wide search and keep the rows whose `holding_museum_name` names that museum.

**Place terms are separate strings, not a hierarchy.** `United States` (about 5 million records) and `United States of America` (7,951) are distinct terms, and a record filed under a state alone, such as `Kentucky`, carries no country term. Before counting by place, list the variants with smithsonian_list_terms (field `place` with a `contains` substring), search each one you mean, and say which you counted.

**The `name` filter matches every role.** It matches a party as Author, Subject, Collector, Donor, or maker alike, so `Warhol, Andy` returns library books about Warhol beside his works. Before calling a record someone's work, check the role in smithsonian_get_object `makers[]`, or narrow the search with a museum's `unit_code` or an `object_type`. To keep related discovery inside one museum, pass `unit_code` to smithsonian_find_related: it scopes every signal, and each `search_continuation` carries it.

**On view is a flag, not a census.** Records of 13 units carry the catalog's on-physical-exhibit flag, about 13,000 records in all, and `filters.on_view_only` selects those flagged "Yes". A record with no flag says nothing about display, so an unflagged object may be on view, and there is no off-view filter: `on_view` is false only where the catalog flags "No". Report an on-view count as flagged objects, per unit, never as everything on display. smithsonian_get_object `current_exhibitions` names where a flagged object is shown; its `building` is the exhibition's building code, which is not a `unit_code`. `exhibitions` is a rarely filled free-text history, and `[]` there doesn't mean the object was never exhibited. For venue text, read `sets`: its `On View`, `Location`, `Exhibition`, or `Hangar` entries name the gallery, floor, or exhibition. That is catalog text, not a second display flag. A National Portrait Gallery record can read `Location: Currently not on view` in `sets` and carry no `on_view`, so don't read a `sets` entry as an on-view count or a "No" flag.

**Mirror-served pages.** A deployment can answer record reads and filter-only searches from a snapshot of the Open Access bulk metadata. A response's `sources` says where it came from (`oa_mirror`, `edan_api`) and `mirror_snapshot` dates the snapshot; cite that date beside a count drawn from it. Mirror pages run in mirror order, not the live API's, so the pages of one walk line up only while `sources` stays the same. A walk with a single filter switches to the live API once `start` plus `rows` passes 100,000. Check `sources` on every page of a long walk, and add a second filter to a walk that deep, which keeps all its pages on one source.

## Workflows

**A person's indexed name.** The `name` filter needs the exact indexed string. smithsonian_get_object lists it in `indexed.name`; its `makers[]` is the catalog's free-text form of the same parties and often differs.

1. Search the person's name as free text and pick a record they made.
2. Call smithsonian_get_object on that `record_id` and read `indexed.name`, which lists every party the record is indexed under, surname-first. Choose the person's entry. An empty array means the record indexes no name, so try another record.
3. Search with that `name` filter, narrowed per the role gate above.

The same holds for the other filters: `indexed.place`, `indexed.object_type`, `indexed.date`, and `indexed.topic` hold the values a record is indexed under, each passable verbatim to the filter of that name. `topics[]` also carries free-text subject strings (`Quilts--History`) that match nothing as a `topic` filter.
