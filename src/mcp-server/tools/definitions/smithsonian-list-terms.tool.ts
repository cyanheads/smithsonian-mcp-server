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
    'Enumerate the valid term vocabulary for an indexed Smithsonian filter field (unit_code, culture, place, date, online_media_type). Terms are a controlled vocabulary — often plural or qualified (e.g. "Paintings", not "Painting") — so guessed filter values tend to return nothing. Returns a page of the field\'s distinct term values; large vocabularies (place has 100k+ terms) page via start and rows.',
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
    contains: z
      .string()
      .optional()
      .describe(
        'Case-insensitive substring filter on the term vocabulary — resolve a filter value (e.g. "greek") to its exact controlled-vocabulary term(s).',
      ),
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
      .describe(
        'Distinct terms available for this query (the full vocabulary, or the contains-match count) — upper bound for omitted items.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when a contains filter matched no terms — how to broaden or drop the filter.',
      ),
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
      {
        field: input.field,
        start: input.start,
        rows: input.rows,
        ...(input.contains !== undefined && { contains: input.contains }),
      },
      ctx,
    );

    // no_terms means the field itself has no indexed vocabulary — only meaningful
    // when enumerating unfiltered. With a contains filter, a zero result is a
    // successful "no term matches" (absence confirmation), surfaced as a notice below.
    if (total === 0 && !input.contains) {
      throw ctx.fail('no_terms', `No terms indexed for field "${input.field}".`, {
        ...ctx.recoveryFor('no_terms'),
        field: input.field,
      });
    }

    ctx.log.info('Terms listed', { field: input.field, count: terms.length, total });

    if (input.contains && total === 0) {
      ctx.enrich.notice(
        `No term in the "${input.field}" vocabulary contains "${input.contains}". ` +
          'Broaden or re-spell the substring, or omit contains to browse the full vocabulary.',
      );
    }

    if (terms.length < total) {
      ctx.enrich.truncated({ shown: terms.length, cap: input.rows, ceiling: total });
    }

    return { field: input.field, terms, total };
  },

  format: (result) => {
    const lines: string[] = [
      `**Field:** \`${result.field}\` — ${result.total.toLocaleString()} distinct terms, showing ${result.terms.length}\n`,
    ];
    for (const t of result.terms) {
      lines.push(`- \`${t}\``);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
