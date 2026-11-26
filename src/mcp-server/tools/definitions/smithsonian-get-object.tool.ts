/**
 * @fileoverview smithsonian_get_object tool — normalized catalog metadata projection for a Smithsonian object by ID.
 * @module mcp-server/tools/definitions/smithsonian-get-object.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  escapeMarkdownInline,
  markdown,
  markdownImage,
  markdownLink,
} from '@cyanheads/mcp-ts-core/utils';
import { headingText } from '@/mcp-server/tools/markdown-encoders.js';
import {
  enrichProvenance,
  provenanceEnrichment,
  provenanceTrailer,
} from '@/mcp-server/tools/provenance.js';
import {
  API_KEY_REJECTED_ERROR,
  getSmithsonianService,
  startCallDeadline,
} from '@/services/smithsonian/smithsonian-service.js';

export const smithsonianGetObject = tool('smithsonian_get_object', {
  title: 'Get Smithsonian Object',
  description:
    'Fetch a normalized catalog metadata projection for a Smithsonian object by its record_id (from smithsonian_search_objects results). Returns title, dates, description, labeled notes, makers, the labeled physical description (materials, measurements, specimen attributes such as sex and preparation), places, cultures, topics, exhibition history, current display (on_view and current_exhibitions, for objects the catalog flags), the sets the catalog files it under (collections, departments, and for displayed objects the gallery or exhibition), credit line, identifiers, rights, and a media summary. indexed carries the exact name, place, object_type, date, and topic values the record is indexed under, each passable verbatim to the smithsonian_search_objects filter of the same name — the free-text makers, places, dates, and topics often differ from them. Natural-history records can include scientific_names, taxonomy, and collection coordinates without inferred precision. The media summary counts the media and links every non-image item (3D models, scanned books, documents); full image URLs come from smithsonian_get_media, and the model files of a 3d_voyager item from smithsonian_get_media with media: "3d".',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    id: z
      .string()
      .describe(
        'Object record_id from smithsonian_search_objects results (e.g. "nasm_A19670093000").',
      ),
  }),
  // Results name the object `record_id`; a call passing that key reaches `id`.
  inputAliases: { record_id: 'id' },

  output: z.object({
    record_id: z.string().describe('Unique object identifier.'),
    title: z.string().describe('Object title.'),
    unit_code: z
      .string()
      .describe(
        'Museum unit code the object is indexed under — the value a unit_code filter matches.',
      ),
    museum_name: z
      .string()
      .describe(
        'Full museum name. A few rarely-indexed archive sub-unit codes have no mapped name and fall back to the raw unit code.',
      ),
    holding_museum_name: z
      .string()
      .optional()
      .describe(
        "The unit that holds the object, from the record's own data source, when it differs from the unit that indexes it (unit_code). Absent otherwise.",
      ),
    dates: z
      .array(
        z
          .object({
            label: z.string().describe('Date field label (e.g. "Date", "Accession Date").'),
            value: z.string().describe('Date value string.'),
          })
          .describe('A single labeled date entry.'),
      )
      .describe('All date fields in the catalog record.'),
    description: z
      .string()
      .optional()
      .describe(
        'Best available prose description from Summary, Physical Description, Brief Description, Description, Description (Brief), or Citation notes. Absent when only administrative notes exist.',
      ),
    notes: z
      .array(
        z
          .object({
            label: z.string().describe('Catalog note label, or Note when absent.'),
            content: z.string().describe('Plain-text note content.'),
          })
          .describe('A labeled catalog note.'),
      )
      .describe('All nonempty catalog notes in source order, including repeated labels.'),
    scientific_names: z
      .array(z.string().describe('A catalog-reported scientific name.'))
      .describe('All reported scientific names in source order; no accepted-name inference.'),
    taxonomy: z
      .object({
        kingdom: z
          .array(z.string().describe('A kingdom value.'))
          .optional()
          .describe('Reported kingdom values.'),
        phylum: z
          .array(z.string().describe('A phylum value.'))
          .optional()
          .describe('Reported phylum values.'),
        class: z
          .array(z.string().describe('A class value.'))
          .optional()
          .describe('Reported class values.'),
        order: z
          .array(z.string().describe('An order value.'))
          .optional()
          .describe('Reported order values.'),
        family: z
          .array(z.string().describe('A family value.'))
          .optional()
          .describe('Reported family values.'),
      })
      .optional()
      .describe('Reported taxonomic ranks; absent ranks remain omitted.'),
    coordinates: z
      .array(
        z
          .object({
            latitude: z.number().describe('Reported decimal latitude in degrees.'),
            longitude: z.number().describe('Reported decimal longitude in degrees.'),
            locality: z.string().optional().describe('Locality reported alongside this point.'),
          })
          .describe('A valid reported decimal coordinate pair.'),
      )
      .describe(
        'Collection points without inferred precision or geocoding; empty when no valid decimal pairs exist.',
      ),
    makers: z
      .array(
        z
          .object({
            role: z
              .string()
              .describe('Role of the named party (e.g. "Artist", "Manufacturer", "Pilot").'),
            name: z.string().describe('Name of the party.'),
          })
          .describe('A single named party entry.'),
      )
      .describe('All named parties associated with this object.'),
    physical_description: z
      .array(
        z
          .object({
            label: z
              .string()
              .describe(
                'Catalog label as written ("Medium", "Dimensions", "Length - Total", "Sex", "Preparation", "Physical Location"), or "Physical description" when absent.',
              ),
            value: z.string().describe('The entry as the catalog writes it.'),
          })
          .describe('One labeled physical-description entry.'),
      )
      .describe(
        "Every entry of the catalog's physical description, in catalog order with repeated labels kept, each under its own label: materials and medium, dimensions and measurements, specimen attributes, and storage locations alike. The label says what an entry is; nothing is sorted by it. Separate from description, the prose chosen from notes. [] when the record has none.",
      ),
    place: z
      .array(
        z
          .object({
            label: z.string().describe('Place field label.'),
            value: z.string().describe('Place name or description.'),
          })
          .describe('A single labeled place entry.'),
      )
      .describe('Geographic place associations.'),
    culture: z.array(z.string().describe('A culture term.')).describe('Culture associations.'),
    topics: z
      .array(z.string().describe('A subject or topic term.'))
      .describe(
        'Subject and topic terms: the indexed topic terms merged with the free-text subject strings of the catalog ("Quilts--History"), so not every entry is a topic filter value — take those from indexed.topic.',
      ),
    indexed: z
      .object({
        name: z
          .array(z.string().describe('An indexed named party.'))
          .describe(
            'Indexed named parties, surname-first ("Armstrong, Neil A.") — each a smithsonian_search_objects filters.name value as written. makers[] is the free-text form of the same parties and often differs.',
          ),
        place: z
          .array(z.string().describe('An indexed place term.'))
          .describe(
            'Indexed place terms ("Virginia", "United States") — each a filters.place value as written. place[] is the free-text form.',
          ),
        object_type: z
          .array(z.string().describe('An indexed object type term.'))
          .describe('Indexed object type terms ("Quilts") — each a filters.object_type value.'),
        date: z
          .array(z.string().describe('An indexed date term.'))
          .describe(
            'Indexed date terms ("1860s") — each a filters.date value. dates[] is the free-text form ("ca. 1850").',
          ),
        topic: z
          .array(z.string().describe('An indexed topic term.'))
          .describe('Indexed topic terms ("Quilts") — each a filters.topic value as written.'),
      })
      .describe(
        "The record's indexed values for five smithsonian_search_objects filters, in catalog order, each passable verbatim as that filter's value to find objects sharing it. An empty array means the record indexes nothing for that filter. culture, scientific_names, and unit_code already carry indexed values.",
      ),
    exhibitions: z
      .array(
        z
          .object({
            name: z.string().describe('Exhibition name.'),
            building: z
              .string()
              .optional()
              .describe('Building or venue where the exhibition was held.'),
          })
          .describe('A single exhibition entry.'),
      )
      .describe(
        'Free-text exhibition history, which the catalog rarely fills: [] does not mean the object was never exhibited. on_view and current_exhibitions report current display.',
      ),
    on_view: z
      .boolean()
      .optional()
      .describe(
        'True when the catalog flags the object as on physical display now, false when it flags it as not. Absent when the record carries no flag, which most do — absence says nothing about display. smithsonian_search_objects filters.on_view_only finds the flagged objects. Venue text, where the catalog gives it, is in sets (On View, Location, Exhibition entries); that is catalog text, not a second display flag.',
      ),
    current_exhibitions: z
      .array(
        z
          .object({
            building: z
              .string()
              .optional()
              .describe(
                'Building code where the object is shown ("NASM", "HAZY", "NPG", "NMAI NY") — not a unit_code.',
              ),
            room: z.string().optional().describe('Gallery or room within the building.'),
            title: z.string().optional().describe('Title of the exhibition showing it.'),
          })
          .describe('One place the object is on display; absent parts are omitted.'),
      )
      .describe(
        "Where the object is on display now, from the catalog's exhibition index; [] when it names none. Often a building code alone: the gallery, hangar, or exhibition name, when catalogued, is in sets, which is catalog text rather than a second display flag.",
      ),
    sets: z
      .array(
        z
          .object({
            label: z
              .string()
              .describe(
                'Catalog label as written, varying by museum ("See more items in", "On View", "Location", "Exhibition", "Hangar", "Department", "Classification"), or "Set" when absent.',
              ),
            value: z
              .string()
              .describe('The collection, department, gallery, or exhibition as written.'),
          })
          .describe('One labeled set entry.'),
      )
      .describe(
        'The sets the catalog files the object under, in catalog order with repeated labels kept: its collections and departments, and for an object on display the gallery, floor, hangar, or exhibition. Catalog text, not a display flag: a "Location: Currently not on view" entry can stand where on_view is absent. [] when the record lists none.',
      ),
    credit_line: z.string().optional().describe('Attribution or credit string.'),
    identifiers: z
      .array(
        z
          .object({
            label: z.string().describe('Identifier type (e.g. "Accession Number", "Call Number").'),
            value: z.string().describe('Identifier value.'),
          })
          .describe('A single labeled identifier.'),
      )
      .describe('All accession and catalog identifiers.'),
    object_rights: z
      .string()
      .optional()
      .describe(
        'Every rights statement in the catalog, in catalog order, joined with "; ". Absent when the catalog gives none.',
      ),
    is_cc0: z
      .boolean()
      .describe(
        'True when the object metadata is CC0 (open access). The Smithsonian Open Access corpus is CC0 throughout, so this flag rarely varies — read media_summary.has_cc0_images to predict whether smithsonian_get_media returns images.',
      ),
    record_link: z
      .string()
      .optional()
      .describe('Canonical Smithsonian Institution URL for this object.'),
    media_summary: z
      .object({
        count: z
          .number()
          .describe(
            'Total number of online media items, across all types (includes non-image media such as 3D models).',
          ),
        cc0_image_count: z
          .number()
          .describe(
            'CC0 images on the object: the same count smithsonian_get_media reports as its cc0_image_count and pages through with start and limit. Lower than count when the object has non-image media (e.g. 3D models) or non-CC0 images.',
          ),
        has_cc0_images: z
          .boolean()
          .describe('True when at least one CC0 image is available (cc0_image_count > 0).'),
        thumbnail_url: z
          .string()
          .optional()
          .describe('Thumbnail URL (~150px) of the first media item.'),
        non_image_media: z
          .array(
            z
              .object({
                type: z
                  .string()
                  .describe(
                    'Upstream media type, e.g. "3d_voyager", "Scanned books", "slideshowXML", "Electronic resource".',
                  ),
                url: z
                  .string()
                  .optional()
                  .describe(
                    "The item's link — a 3D viewer, a scanned book, a document viewer, or a PDF. Absent when the catalog gives none.",
                  ),
                is_cc0: z.boolean().describe('True when this item is CC0 open access.'),
              })
              .describe('A non-image media item.'),
          )
          .describe(
            'Every media item typed as something other than Images, which smithsonian_get_media does not return as images, in catalog order. The model files of a 3d_voyager item come from smithsonian_get_media with media: "3d". Empty when there are none.',
          ),
      })
      .describe(
        'Media availability summary, with a link to each non-image item. Call smithsonian_get_media for full image URLs.',
      ),
  }),

  enrichment: provenanceEnrichment,
  enrichmentTrailer: provenanceTrailer,

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No object with the given ID exists in the Smithsonian catalog.',
      recovery:
        'Verify the ID via smithsonian_search_objects and use the record_id from search results.',
      // Raised by SmithsonianService.getContent, which resolves this hint itself.
      thrownBy: 'service',
    },
    {
      reason: 'invalid_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The ID format is clearly malformed (empty string, whitespace only).',
      recovery:
        'Use record_id values directly from smithsonian_search_objects results — do not construct IDs manually.',
    },
    API_KEY_REJECTED_ERROR,
  ],

  async handler(input, ctx) {
    const deadline = startCallDeadline();
    if (!input.id.trim()) {
      throw ctx.fail('invalid_id', 'Object ID must not be empty.', { id: input.id });
    }

    const svc = getSmithsonianService();
    ctx.log.info('Fetching Smithsonian object', { id: input.id });

    const { record, provenance } = await svc.getContent(input.id, ctx, deadline);
    const obj = svc.toFullObject(record);

    ctx.log.info('Object fetched', {
      record_id: obj.record_id,
      title: obj.title,
      is_cc0: obj.is_cc0,
    });

    enrichProvenance(ctx, [provenance]);
    return obj;
  },

  format: (result) => {
    const esc = escapeMarkdownInline;
    const lines: string[] = [
      `# ${headingText(result.title)}`,
      `**ID:** ${markdown().inlineCode(result.record_id).build()} | **Museum:** ${esc(result.museum_name)} (${esc(result.unit_code)})`,
    ];
    /**
     * A labelled list of already-encoded items, one per value: values carry `, ` and `; `
     * themselves, so a join would not read back. The blank line before it ends the list above,
     * which would otherwise take this label in as a lazy continuation of its last item.
     */
    const list = (label: string, items: string[]) => {
      if (items.length > 0) lines.push('', `**${label}:**`, ...items.map((item) => `- ${item}`));
    };
    const labeled = (entries: Array<{ label: string; value: string }>) =>
      entries.map((entry) => `${esc(entry.label)}: ${esc(entry.value)}`);
    if (result.holding_museum_name) lines.push(`**Held by:** ${esc(result.holding_museum_name)}`);
    lines.push(`**CC0:** ${result.is_cc0 ? 'Yes' : 'No'}`);
    if (result.record_link) {
      lines.push(`**Link:** ${markdownLink('Catalog record', result.record_link)}`);
    }
    if (result.description) lines.push('', esc(result.description));
    list('Dates', labeled(result.dates));
    list(
      'Notes',
      result.notes.map((note) => `${esc(note.label)}: ${esc(note.content)}`),
    );
    list(
      'Scientific names',
      result.scientific_names.map((name) => esc(name)),
    );
    for (const [rank, values] of Object.entries(result.taxonomy ?? {})) {
      list(
        `Taxonomy ${rank}`,
        (values ?? []).map((value) => esc(value)),
      );
    }
    list(
      'Collection coordinates',
      result.coordinates.map(
        (point) =>
          `${point.latitude}, ${point.longitude}${point.locality ? ` (${esc(point.locality)})` : ''}`,
      ),
    );
    list(
      'Makers',
      result.makers.map((m) => `${esc(m.role)}: ${esc(m.name)}`),
    );
    list('Physical description', labeled(result.physical_description));
    list(
      'Culture',
      result.culture.map((culture) => esc(culture)),
    );
    list(
      'Topics',
      result.topics.map((topic) => esc(topic)),
    );
    list('Places', labeled(result.place));
    list(
      'Indexed filter values',
      Object.entries(result.indexed).flatMap(([key, values]) =>
        values.map((value) => `${key}: ${esc(value)}`),
      ),
    );
    // One item per venue: `<title> · <building>, <room>`, absent parts dropped.
    const venues = result.current_exhibitions.map((ex) => {
      const where = [ex.building, ex.room].filter((part) => part !== undefined);
      const parts = [ex.title, where.length > 0 ? where.join(', ') : undefined];
      return `- ${esc(parts.filter((part) => part !== undefined).join(' · '))}`;
    });
    if (result.on_view !== undefined) {
      lines.push('', `**On view:** ${result.on_view ? 'Yes' : 'No'}`, ...venues);
    } else if (venues.length > 0) {
      lines.push('', '**Current exhibitions:**', ...venues);
    }
    list('Sets', labeled(result.sets));
    list(
      'Exhibitions',
      result.exhibitions.map(
        (ex) => `${esc(ex.name)}${ex.building ? ` (${esc(ex.building)})` : ''}`,
      ),
    );
    list('Identifiers', labeled(result.identifiers));
    if (result.credit_line || result.object_rights) lines.push('');
    if (result.credit_line) lines.push(`**Credit:** ${esc(result.credit_line)}`);
    if (result.object_rights) lines.push(`**Rights:** ${esc(result.object_rights)}`);
    const media = result.media_summary;
    lines.push(
      '',
      `**Media:** ${media.count} total item(s); ${media.cc0_image_count} CC0 image(s) via smithsonian_get_media. CC0 images: ${media.has_cc0_images ? 'Yes' : 'No'}`,
    );
    if (media.thumbnail_url) {
      lines.push(`**Thumbnail:** ${markdownImage('Thumbnail', media.thumbnail_url)}`);
    }
    list(
      'Non-image media',
      media.non_image_media.map((item) => {
        const label = item.url ? markdownLink(item.type, item.url) : `${esc(item.type)} (no URL)`;
        return `${label} · CC0: ${item.is_cc0 ? 'Yes' : 'No'}`;
      }),
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
