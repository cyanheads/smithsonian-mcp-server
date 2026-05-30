/**
 * @fileoverview smithsonian_get_object tool — full catalog record for a Smithsonian object by ID.
 * @module mcp-server/tools/definitions/smithsonian-get-object.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSmithsonianService } from '@/services/smithsonian/smithsonian-service.js';

export const smithsonianGetObject = tool('smithsonian_get_object', {
  title: 'Get Smithsonian Object',
  description:
    'Fetch the full catalog record for a Smithsonian object by its record_id (from smithsonian_search results). Returns all available metadata: title, dates, materials, dimensions, provenance, exhibition history, credit line, accession identifiers, and a media summary. Call smithsonian_get_media for full image URLs. Use record_id values from smithsonian_search — do not manually construct IDs.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    id: z
      .string()
      .describe('Object record_id from smithsonian_search results (e.g. "nasm_A19670093000").'),
  }),

  output: z.object({
    record_id: z.string().describe('Unique object identifier.'),
    title: z.string().describe('Object title.'),
    unit_code: z.string().describe('Museum unit code.'),
    museum_name: z.string().describe('Full museum name.'),
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
        'Best available prose description (Summary, Physical Description, or Brief Description notes).',
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
        'True when the object metadata is CC0 (open access). Call smithsonian_get_media to get images.',
      ),
    record_link: z
      .string()
      .optional()
      .describe('Canonical Smithsonian Institution URL for this object.'),
    media_summary: z
      .object({
        count: z.number().describe('Total number of online media items.'),
        has_cc0_images: z.boolean().describe('True when at least one image is CC0.'),
        thumbnail_url: z.string().optional().describe('Thumbnail URL from the first media item.'),
      })
      .describe('Media availability summary. Call smithsonian_get_media for full image URLs.'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No object with the given ID exists in the Smithsonian catalog.',
      recovery: 'Verify the ID via smithsonian_search and use the record_id from search results.',
    },
    {
      reason: 'invalid_id',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The ID format is clearly malformed (empty string, whitespace only).',
      recovery:
        'Use record_id values directly from smithsonian_search results — do not construct IDs manually.',
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
      lines.push(`**Topics:** ${result.topics.slice(0, 10).join(', ')}`);
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
    lines.push(
      `**Media:** ${result.media_summary.count} item(s), CC0 images: ${result.media_summary.has_cc0_images ? 'Yes' : 'No'}`,
    );
    if (result.media_summary.thumbnail_url) {
      lines.push(`**Thumbnail:** ${result.media_summary.thumbnail_url}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
