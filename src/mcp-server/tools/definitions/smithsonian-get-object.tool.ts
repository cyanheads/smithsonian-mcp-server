/**
 * @fileoverview smithsonian_get_object tool — normalized catalog metadata projection for a Smithsonian object by ID.
 * @module mcp-server/tools/definitions/smithsonian-get-object.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSmithsonianService } from '@/services/smithsonian/smithsonian-service.js';

export const smithsonianGetObject = tool('smithsonian_get_object', {
  title: 'Get Smithsonian Object',
  description:
    'Fetch a normalized catalog metadata projection for a Smithsonian object by its record_id (from smithsonian_search_objects results). Returns title, dates, description, labeled notes, makers, materials, dimensions, places, cultures, topics, exhibitions, credit line, identifiers, rights, and a media summary. Natural-history records can include scientific_names, taxonomy, and collection coordinates without inferred precision. The media summary is a count; full image URLs come from smithsonian_get_media.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    id: z
      .string()
      .describe(
        'Object record_id from smithsonian_search_objects results (e.g. "nasm_A19670093000").',
      ),
  }),

  output: z.object({
    record_id: z.string().describe('Unique object identifier.'),
    title: z.string().describe('Object title.'),
    unit_code: z.string().describe('Museum unit code.'),
    museum_name: z
      .string()
      .describe(
        'Full museum name. A few rarely-indexed archive sub-unit codes have no mapped name and fall back to the raw unit code.',
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
    materials: z
      .array(z.string().describe('A material or physical description string.'))
      .describe('Physical material descriptions.'),
    dimensions: z
      .array(z.string().describe('A dimension or measurement string.'))
      .describe('Dimension and measurement strings.'),
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
      .describe('Subject and topic terms.'),
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
      .describe('Exhibition history.'),
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
    object_rights: z.string().optional().describe('Rights statement from the catalog.'),
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
            'Number of CC0 images smithsonian_get_media returns for this object. Lower than count when the object has non-image media (e.g. 3D models) or non-CC0 images.',
          ),
        has_cc0_images: z
          .boolean()
          .describe('True when at least one CC0 image is available (cc0_image_count > 0).'),
        thumbnail_url: z.string().optional().describe('Thumbnail URL from the first media item.'),
      })
      .describe('Media availability summary. Call smithsonian_get_media for full image URLs.'),
  }),

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
  ],

  async handler(input, ctx) {
    if (!input.id.trim()) {
      throw ctx.fail('invalid_id', 'Object ID must not be empty.', { id: input.id });
    }

    const svc = getSmithsonianService();
    ctx.log.info('Fetching Smithsonian object', { id: input.id });

    const raw = await svc.getContent(input.id, ctx);
    const obj = svc.toFullObject(raw);

    ctx.log.info('Object fetched', {
      record_id: obj.record_id,
      title: obj.title,
      is_cc0: obj.is_cc0,
    });

    return obj;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# ${result.title}`);
    lines.push(
      `**ID:** ${result.record_id} | **Museum:** ${result.museum_name} (${result.unit_code})`,
    );
    lines.push(`**CC0:** ${result.is_cc0 ? 'Yes' : 'No'}`);
    if (result.record_link) lines.push(`**Link:** ${result.record_link}`);
    if (result.description) {
      lines.push('');
      lines.push(result.description);
    }
    if (result.dates.length > 0) {
      lines.push('');
      lines.push('**Dates:**');
      for (const d of result.dates) lines.push(`- ${d.label}: ${d.value}`);
    }
    if (result.notes.length > 0) {
      lines.push('', '**Notes:**');
      for (const note of result.notes) lines.push(`- ${note.label}: ${note.content}`);
    }
    if (result.scientific_names.length > 0)
      lines.push(`**Scientific names:** ${result.scientific_names.join('; ')}`);
    if (result.taxonomy) {
      for (const [rank, values] of Object.entries(result.taxonomy)) {
        if (values) lines.push(`**Taxonomy ${rank}:** ${values.join('; ')}`);
      }
    }
    if (result.coordinates.length > 0) {
      lines.push('**Collection coordinates:**');
      for (const point of result.coordinates)
        lines.push(
          `- ${point.latitude}, ${point.longitude}${point.locality ? ` (${point.locality})` : ''}`,
        );
    }
    if (result.makers.length > 0) {
      lines.push('');
      lines.push('**Makers:**');
      for (const m of result.makers) lines.push(`- ${m.role}: ${m.name}`);
    }
    if (result.materials.length > 0) {
      lines.push('');
      lines.push(`**Materials:** ${result.materials.join('; ')}`);
    }
    if (result.dimensions.length > 0) {
      lines.push(`**Dimensions:** ${result.dimensions.join('; ')}`);
    }
    if (result.culture.length > 0) {
      lines.push(`**Culture:** ${result.culture.join(', ')}`);
    }
    if (result.topics.length > 0) {
      lines.push(`**Topics:** ${result.topics.join(', ')}`);
    }
    if (result.place.length > 0) {
      lines.push(`**Places:** ${result.place.map((p) => `${p.label}: ${p.value}`).join('; ')}`);
    }
    if (result.exhibitions.length > 0) {
      lines.push('');
      lines.push('**Exhibitions:**');
      for (const ex of result.exhibitions) {
        lines.push(`- ${ex.name}${ex.building ? ` (${ex.building})` : ''}`);
      }
    }
    if (result.identifiers.length > 0) {
      lines.push('');
      lines.push('**Identifiers:**');
      for (const id of result.identifiers) lines.push(`- ${id.label}: ${id.value}`);
    }
    if (result.credit_line) lines.push(`**Credit:** ${result.credit_line}`);
    if (result.object_rights) lines.push(`**Rights:** ${result.object_rights}`);
    lines.push('');
    const media = result.media_summary;
    lines.push(
      `**Media:** ${media.count} total item(s); ${media.cc0_image_count} CC0 image(s) via smithsonian_get_media. CC0 images: ${media.has_cc0_images ? 'Yes' : 'No'}`,
    );
    if (media.thumbnail_url) {
      lines.push(`**Thumbnail:** ${media.thumbnail_url}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
