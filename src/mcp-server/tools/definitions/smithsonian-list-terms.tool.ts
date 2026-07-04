/**
 * @fileoverview smithsonian_list_terms tool — enumerate valid filter vocabulary for an indexed field.
 * @module mcp-server/tools/definitions/smithsonian-list-terms.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSmithsonianService } from '@/services/smithsonian/smithsonian-service.js';

export const smithsonianListTerms = tool('smithsonian_list_terms', {
  title: 'List Valid Filter Terms',
  description:
    'Enumerate the valid term vocabulary for an indexed Smithsonian filter field (unit_code, culture, place, date, online_media_type). Call this before using smithsonian_search or smithsonian_explore filters to discover exact term strings — Smithsonian uses a controlled vocabulary where terms are often plural or qualified (e.g. "Paintings", not "Painting"), so guessing filter values produces empty results. Returns a page of the field\'s distinct term values; large vocabularies (place has 100k+ terms) page via start and rows.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    field: z
      .enum(['unit_code', 'culture', 'place', 'date', 'online_media_type'])
      .describe(
        'Indexed field to enumerate. Choices: unit_code (museum codes like "NASM"), culture (e.g. "Aztecs"), place (geographic terms), date (decade/era values like "1920s"), online_media_type (media formats like "Images", "3D Models").',
      ),
    start: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Pagination offset (0-indexed). Use with rows to page through large vocabularies.'),
    rows: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe('Number of terms to return per page (default 50, max 100).'),
  }),

  output: z.object({
    field: z.string().describe('The enumerated field, as provided in the request.'),
    terms: z
      .array(
        z
          .string()
          .describe(
            'A term value — pass directly as the filter value in smithsonian_search or smithsonian_explore.',
          ),
      )
      .describe(
        "The field's distinct term values for this page, in the Smithsonian index's native order. No per-term object counts are available upstream.",
      ),
    total: z
      .number()
      .describe(
        'Total number of distinct terms for this field (the full vocabulary size; terms is one page of it).',
      ),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe('True when the term list was capped by the rows parameter.'),
    shown: z.number().optional().describe('Number of terms returned in this page.'),
    cap: z.number().optional().describe('The rows cap that was applied.'),
    truncationCeiling: z
      .number()
      .optional()
      .describe('Total distinct terms for the field (upper bound for omitted items).'),
  },

  errors: [
    {
      reason: 'no_terms',
      code: JsonRpcErrorCode.NotFound,
      when: 'The field returned no indexed terms.',
      recovery:
        'Try a different field name. Valid fields: unit_code, culture, place, date, online_media_type.',
    },
  ],

  async handler(input, ctx) {
    const svc = getSmithsonianService();

    ctx.log.info('Listing Smithsonian terms', {
      field: input.field,
      start: input.start,
      rows: input.rows,
    });

    const { terms, total } = await svc.listTerms(
      { field: input.field, start: input.start, rows: input.rows },
      ctx,
    );

    if (terms.length === 0) {
      throw ctx.fail('no_terms', `No terms indexed for field "${input.field}".`, {
        field: input.field,
      });
    }

    ctx.log.info('Terms listed', { field: input.field, count: terms.length, total });

    if (terms.length < total) {
      ctx.enrich.truncated({ shown: terms.length, cap: input.rows, ceiling: total });
    }

    return { field: input.field, terms, total };
  },

  format: (result) => {
    const lines: string[] = [
      `**Field:** \`${result.field}\` — ${result.total.toLocaleString()} total distinct terms, showing ${result.terms.length}\n`,
    ];
    for (const t of result.terms) {
      lines.push(`- \`${t}\``);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
