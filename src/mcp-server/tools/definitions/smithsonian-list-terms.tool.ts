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
    'Enumerate the valid term vocabulary for an indexed Smithsonian filter field. Call this before using smithsonian_search or smithsonian_explore filters to discover exact term strings — guessing filter values produces empty results. Returns the distinct terms sorted by object count descending, so the most-populated terms appear first.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    field: z
      .enum([
        'unit_code',
        'object_type',
        'culture',
        'place',
        'date',
        'media_usage',
        'online_media_type',
      ])
      .describe(
        'Indexed field to enumerate. Common choices: unit_code (museum codes like "NASM"), object_type (artifact categories like "Aircraft"), culture (e.g. "Aztec"), place (geographic terms), date (decade values like "1920s").',
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
          .object({
            value: z
              .string()
              .describe(
                'Term string — pass directly as the filter value in smithsonian_search or smithsonian_explore.',
              ),
            count: z.number().describe('Number of Smithsonian objects indexed under this term.'),
          })
          .describe('A single term entry with its object count.'),
      )
      .describe('Valid term vocabulary for the field, sorted by count descending.'),
    total: z
      .number()
      .describe('Total number of distinct terms for this field in the Smithsonian index.'),
  }),

  errors: [
    {
      reason: 'no_terms',
      code: JsonRpcErrorCode.NotFound,
      when: 'The field returned no indexed terms.',
      recovery:
        'Try a different field name. Valid fields: unit_code, object_type, culture, place, date, media_usage, online_media_type.',
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

    return { field: input.field, terms, total };
  },

  format: (result) => {
    const lines: string[] = [
      `**Field:** \`${result.field}\` — ${result.total.toLocaleString()} total distinct terms, showing ${result.terms.length}\n`,
    ];
    for (const t of result.terms) {
      lines.push(`- \`${t.value}\` (${t.count.toLocaleString()} objects)`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
