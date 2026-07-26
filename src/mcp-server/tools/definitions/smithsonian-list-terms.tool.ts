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
    'Enumerate the valid term vocabulary for an indexed Smithsonian filter field (unit_code, culture, place, date, online_media_type, topic). Terms are a controlled vocabulary — often plural or qualified (e.g. "Paintings", not "Painting") — so guessed filter values tend to return nothing. Returns a page of the field\'s distinct term values; large vocabularies (topic has 133k terms, place 114k) page via start and rows. For unit_code, each code is returned with its museum name and contains matches the name as well as the code, so a museum name resolves to its code in one call.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    field: z
      .enum(['unit_code', 'culture', 'place', 'date', 'online_media_type', 'topic'])
      .describe(
        'Indexed field to enumerate. Choices: unit_code (museum codes like "NASM"), culture (e.g. "Aztecs"), place (geographic terms), date (decade/era values like "1920s"), online_media_type (media formats like "Images", "3D Models"), topic (subject terms like "Quilts" — 133k terms, so pair it with contains).',
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
        'Case-insensitive substring filter on the term vocabulary — resolve a filter value (e.g. "greek") to its exact controlled-vocabulary term(s). For unit_code the substring also matches each code\'s museum name, so "National Air and Space" resolves to "NASM".',
      ),
  }),

  output: z.object({
    field: z.string().describe('The enumerated field, as provided in the request.'),
    terms: z
      .array(
        z
          .string()
          .describe(
            'A term value — pass directly as the filter value in smithsonian_search_objects or smithsonian_browse_category.',
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
    labels: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Museum name for each unit_code on this page that has one — present only when field is "unit_code". A few rarely-indexed archive sub-unit codes have no mapped name and are absent from this map; their term is still returned in terms.',
      ),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when matching terms remain past this page. False on a terminal or past-the-end page, where nothing is being withheld.',
      ),
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
        'Guidance naming the input that retrieves the terms this page omitted, or how to broaden a contains filter that matched nothing.',
      ),
  },

  errors: [
    {
      reason: 'no_terms',
      code: JsonRpcErrorCode.NotFound,
      when: 'The field returned no indexed terms.',
      recovery:
        'Try a different field name. Valid fields: unit_code, culture, place, date, online_media_type, topic.',
    },
  ],

  async handler(input, ctx) {
    const svc = getSmithsonianService();

    ctx.log.info('Listing Smithsonian terms', {
      field: input.field,
      start: input.start,
      rows: input.rows,
    });

    const { terms, total, labels } = await svc.listTerms(
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

    // These two branches both write the same enrichment `notice` key, so only the
    // last to run would survive. They stay mutually exclusive by construction: the
    // filtered-empty branch needs total === 0, and the truncation trigger below
    // needs something past the page, which total === 0 can never satisfy.
    if (input.contains && total === 0) {
      ctx.enrich.notice(
        `No term in the "${input.field}" vocabulary contains "${input.contains}". ` +
          'Broaden or re-spell the substring, or omit contains to browse the full vocabulary.',
      );
    }

    // Account for the offset already consumed — terms remaining BEYOND this page,
    // not merely a page smaller than the vocabulary. The page-local comparison
    // reported truncated with shown: 0 on a past-the-end page (issue #30).
    if (input.start + terms.length < total) {
      ctx.enrich.truncated({
        shown: terms.length,
        cap: input.rows,
        ceiling: total,
        guidance:
          `${total} terms match; this page shows ${terms.length} from offset ${input.start}. ` +
          'Retrieve the rest by advancing start by rows, or narrow the vocabulary with contains.',
      });
    }

    return { field: input.field, terms, total, ...(labels && { labels }) };
  },

  format: (result) => {
    const labels = result.labels ?? {};
    const lines: string[] = [
      `**Field:** \`${result.field}\` — ${result.total.toLocaleString()} distinct terms, showing ${result.terms.length}\n`,
    ];
    // Rendered over the union of the page and the label keys so every labelled
    // code reaches the markdown surface. `labels` is keyed by the codes on this
    // page, so for a real response the union is the page itself.
    for (const term of new Set([...result.terms, ...Object.keys(labels)])) {
      const name = labels[term];
      lines.push(name ? `- \`${term}\` — ${name}` : `- \`${term}\``);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
