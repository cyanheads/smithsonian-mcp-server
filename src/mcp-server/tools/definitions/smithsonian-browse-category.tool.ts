/**
 * @fileoverview smithsonian_browse_category tool — browse objects within one exact Smithsonian category.
 * @module mcp-server/tools/definitions/smithsonian-browse-category.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { RequestContextLike } from '@cyanheads/mcp-ts-core/utils';
import {
  getSmithsonianService,
  luceneField,
  type SmithsonianService,
} from '@/services/smithsonian/smithsonian-service.js';

/** The category dimension a browse targets. */
type BrowseMode = 'museum' | 'culture' | 'period' | 'medium';

/** The `NNNNs` decade shape a period value must take, e.g. "1940s". */
const DECADE_PATTERN = /^\d{4}s$/;

/**
 * The indexed EDAN field each browse mode constrains. Every mode applies its value
 * as one literal term against this field — no shape gate and no case folding, not
 * even for museum: unit codes run from "SI" to "CFCHFOLKLIFE" and carry separators
 * ("OCIO_DPO3D", "OFEO-SG"), so length and character class can't tell a code from a
 * museum name, and EDAN matches the term case-sensitively ("NMAfA" is real, "NMAFA"
 * matches nothing). An unusable value reaches the invalid_category error and its
 * smithsonian_list_terms recovery instead of becoming a free-text search whose hit
 * count was reported as a museum total.
 */
const MODE_FIELD: Record<BrowseMode, string> = {
  museum: 'unit_code',
  culture: 'culture',
  period: 'date',
  medium: 'object_type',
};

/** Upper bound on object_type candidates named in a medium recovery hint. */
const MAX_OBJECT_TYPE_CANDIDATES = 12;

/**
 * Compose the mode-specific recovery hint for a zero-match category browse. A
 * browse category is an exact indexed facet, so a zero match means the supplied
 * value is not a usable term, not that an object is missing (issue #31). Each
 * mode names the literal next call that resolves the value to a real term:
 * museum, culture, and period resolve through the enumerable
 * smithsonian_list_terms vocabulary; medium's object_type is not enumerable
 * upstream, so `objectTypes` — harvested from a free-text re-query — names the
 * candidates directly, falling back to routing the caller to that same search
 * when the harvest comes back empty. Never auto-selects a candidate: the hint
 * lists terms and the caller picks the intended one.
 */
function categoryRecoveryHint(mode: BrowseMode, value: string, objectTypes: string[]): string {
  switch (mode) {
    case 'museum': {
      /**
       * No live unit code contains a space — the vocabulary runs "SI" to
       * "CFCHFOLKLIFE" and separates with "_" or "-" ("OCIO_DPO3D", "OFEO-SG").
       * A spaced value is therefore a museum name, the mistake this mode's
       * description warns against, and can never appear as a `contains` substring
       * of a real code: naming that call would dead-end the caller on an empty
       * term list. Route it to the unfiltered vocabulary instead, which fits in
       * one page and names every code the caller can choose from.
       */
      const resolve = value.includes(' ')
        ? 'smithsonian_list_terms { field: "unit_code" } and pick the code for the museum you mean'
        : `smithsonian_list_terms { field: "unit_code", contains: "${value}" }`;
      return `"${value}" is not an exact Smithsonian unit code. Resolve it to a real code with ${resolve}, then browse again with the exact value.`;
    }
    case 'culture':
      return `"${value}" is not an exact culture term. Resolve it with smithsonian_list_terms { field: "culture", contains: "${value}" }, then browse again with the exact value.`;
    case 'period':
      return `"${value}" matched no indexed decade. Resolve an indexed value with smithsonian_list_terms { field: "date", contains: "${value}" }, then browse again with the exact value.`;
    case 'medium':
      if (objectTypes.length > 0) {
        return `"${value}" is not an exact object_type term. Object types present for a free-text search of "${value}" — ${objectTypes.join(', ')}. Browse again with one of these exact terms (object_type is commonly plural, e.g. "Paintings").`;
      }
      return `"${value}" is not an exact object_type term, and object_type is not enumerable through smithsonian_list_terms. Run smithsonian_search_objects { query: "${value}" } and inspect the object_type values in the results (commonly plural, e.g. "Paintings") to find the exact term, then browse again with mode "medium".`;
  }
}

/**
 * Harvest the object_type vocabulary that co-occurs with a failed medium value,
 * by re-running it as a free-text search with no filters — the same filtered-zero
 * harvest smithsonian_search_objects performs (issue #15). object_type is the one
 * browse dimension smithsonian_list_terms cannot enumerate, so this turns a hint
 * that could only tell the caller where to look into one that names the terms.
 * Best-effort and failure-path only: an empty or throwing re-query yields no
 * candidates and the static hint stands.
 */
async function harvestObjectTypes(
  svc: SmithsonianService,
  value: string,
  ctx: RequestContextLike,
): Promise<string[]> {
  try {
    const { rows } = await svc.search({ query: value, rows: 100, start: 0, filters: [] }, ctx);
    const types = new Set<string>();
    for (const row of rows) {
      if (row.object_type) types.add(row.object_type);
      if (types.size >= MAX_OBJECT_TYPE_CANDIDATES) break;
    }
    return [...types];
  } catch {
    return [];
  }
}

const SampleObjectSchema = z
  .object({
    record_id: z
      .string()
      .describe('Object identifier — pass to smithsonian_get_object or smithsonian_get_media.'),
    title: z.string().describe('Object title.'),
    unit_code: z.string().describe('Museum unit code.'),
    thumbnail_url: z.string().optional().describe('Thumbnail image URL if available.'),
    is_cc0: z.boolean().describe('True when the object is CC0 open access.'),
  })
  .describe('A sample object from the requested page of category matches.');

export const smithsonianBrowseCategory = tool('smithsonian_browse_category', {
  title: 'Browse Smithsonian by Category',
  description:
    'Browse Smithsonian objects within one exact category — a single museum (mode "museum"), culture, decade (mode "period"), or object type (mode "medium"). The value must be an exact indexed category term, not free text: resolve museum, culture, and period vocabulary with smithsonian_list_terms first (object_type is not enumerable there — harvest it from smithsonian_search_objects results). Returns the category total count, a page of matching objects, and a museum breakdown of that page; page the full category with start and rows. For open-ended or topic discovery, start with smithsonian_search_objects instead.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z
    .object({
      mode: z
        .enum(['museum', 'culture', 'period', 'medium'])
        .describe(
          'Browse dimension: "museum" (by unit code), "culture" (by culture term), "period" (by decade like "1940s"), "medium" (by object type like "Paintings").',
        ),
      value: z
        .string()
        .describe(
          'Category value appropriate to the mode. museum: a unit code like "NASM", "SAAM", or "NMNHBIRDS", matched literally and case-sensitively — not a museum name. culture: term, often plural or qualified ("Aztecs", "Plains Indian"). period: a decade in "NNNNs" form ("1940s", "1860s"), required for that mode. medium: object type, usually plural ("Paintings", "Aircraft"). Smithsonian uses a controlled vocabulary — for museum (unit_code), culture, and period (date), call smithsonian_list_terms to find exact terms; medium (object_type) is not enumerable there, so harvest it from smithsonian_search_objects results.',
        ),
      rows: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe('Number of sample objects to return (default 10, max 50).'),
      start: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('Pagination offset — 0-indexed. Page contiguously with start = page × rows.'),
    })
    /**
     * `value` is polymorphic across the four modes, so the decade format can't be a
     * field-level `.regex()` the way smithsonian_search_objects constrains its
     * dedicated date_decade input. Validating it here rejects a malformed period
     * ("1940", "40s", "1940S") at the schema boundary rather than letting it reach
     * upstream as a guaranteed-zero query that surfaces as invalid_category.
     */
    .superRefine((input, ctx) => {
      if (input.mode === 'period' && !DECADE_PATTERN.test(input.value)) {
        ctx.addIssue({
          code: 'custom',
          path: ['value'],
          message: `Period values must be a decade in "NNNNs" form, e.g. "1940s" — received "${input.value}".`,
        });
      }
    }),

  output: z.object({
    mode: z
      .string()
      .describe(
        'Browse dimension used for this request (one of "museum", "culture", "period", "medium").',
      ),
    value: z.string().describe('Category value queried, as provided in the request.'),
    total_count: z.number().describe('Total number of Smithsonian objects matching this category.'),
    sample_objects: z
      .array(SampleObjectSchema)
      .describe(
        'The requested page of objects matching the category, in upstream order. Empty when start is past the end of the category.',
      ),
    museum_breakdown: z
      .array(
        z
          .object({
            unit_code: z
              .string()
              .describe('Smithsonian unit code for this museum (e.g. "NMNHPALEO", "SAAM").'),
            museum_name: z
              .string()
              .describe(
                'Full name of the museum. A few rarely-indexed archive sub-unit codes have no mapped name and fall back to the raw unit code.',
              ),
            count: z.number().describe('Estimated object count from sample (not exact).'),
          })
          .describe('A single museum contribution entry.'),
      )
      .describe(
        'When mode is not "museum": top contributing museums from the sample, helping plan museum-focused follow-up searches.',
      ),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when matching objects remain past this page. False on a terminal or past-the-end page, where nothing is being withheld.',
      ),
    shown: z.number().optional().describe('Number of sample objects returned.'),
    cap: z.number().optional().describe('The rows cap that was applied.'),
    truncationCeiling: z
      .number()
      .optional()
      .describe('Total matching objects (upper bound for omitted items).'),
    notice: z
      .string()
      .optional()
      .describe('Guidance naming the input that retrieves the objects this page omitted.'),
  },

  errors: [
    {
      reason: 'invalid_category',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The category value matched no objects — a browse category is an exact indexed facet, so a zero match means the value is not a usable term.',
      recovery:
        'Resolve the value to an exact term before browsing again: museum, culture, and period values are enumerable through smithsonian_list_terms; for medium, run smithsonian_search_objects and inspect the object_type values in its results.',
    },
  ],

  async handler(input, ctx) {
    const svc = getSmithsonianService();

    // The category IS the query: the mode's field constraint is embedded in q as a
    // Lucene field:value term (EDAN has no fq param) with no free-text base query.
    // luceneField's quoting is load-bearing — an unquoted multi-word value ends the
    // field term at the first space and leaks its trailing words back out as free text.
    const filters = [luceneField(MODE_FIELD[input.mode], input.value)];

    ctx.log.info('Browsing Smithsonian category', {
      mode: input.mode,
      value: input.value,
      filters,
      start: input.start,
    });

    const { rows: objects, rowCount } = await svc.search(
      { query: '', rows: input.rows, start: input.start, filters },
      ctx,
    );

    // Guard on the TRUE match count, not the page-local length. A start past the
    // end of a real category returns an empty page with rowCount > 0 — normal
    // pagination completion, not a category value outside the vocabulary. Firing
    // invalid_category there would send the caller to resolve a value that was
    // already correct. A genuine zero match means the category value is not an
    // exact indexed term (issue #31), so the recovery is mode-specific: it names
    // the literal next call that resolves the value rather than treating the
    // object as missing.
    if (rowCount === 0) {
      const objectTypes =
        input.mode === 'medium' ? await harvestObjectTypes(svc, input.value, ctx) : [];
      throw ctx.fail(
        'invalid_category',
        `No Smithsonian objects match ${input.mode} category "${input.value}".`,
        {
          recovery: { hint: categoryRecoveryHint(input.mode, input.value, objectTypes) },
          mode: input.mode,
          value: input.value,
        },
      );
    }

    // Build sample objects
    const sampleObjects = objects.map((o) => ({
      record_id: o.record_id,
      title: o.title,
      unit_code: o.unit_code,
      thumbnail_url: o.thumbnail_url,
      is_cc0: o.is_cc0,
    }));

    // Museum breakdown from sample (only when mode !== museum)
    const museumBreakdown: Array<{ unit_code: string; museum_name: string; count: number }> = [];
    if (input.mode !== 'museum') {
      const counts = new Map<string, { museum_name: string; count: number }>();
      for (const obj of objects) {
        const existing = counts.get(obj.unit_code);
        if (existing) {
          existing.count += 1;
        } else {
          counts.set(obj.unit_code, { museum_name: obj.museum_name, count: 1 });
        }
      }
      // Sort by count descending, take top 5
      for (const [unit_code, { museum_name, count }] of [...counts.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 5)) {
        museumBreakdown.push({ unit_code, museum_name, count });
      }
    }

    ctx.log.info('Browse complete', {
      mode: input.mode,
      total: rowCount,
      samples: sampleObjects.length,
    });

    // Account for the offset already consumed: objects remaining BEYOND this page,
    // not merely a page smaller than the category. The page-local comparison would
    // report truncated on the genuine last page (where length is rowCount − start)
    // and on the past-the-end page the rowCount guard above now lets through.
    if (input.start + sampleObjects.length < rowCount) {
      ctx.enrich.truncated({
        shown: sampleObjects.length,
        cap: input.rows,
        ceiling: rowCount,
        guidance:
          `${rowCount} objects match this category; this page shows ${sampleObjects.length} from offset ${input.start}. ` +
          'Retrieve the rest by advancing start (start = page × rows, rows max 50).',
      });
    }

    return {
      mode: input.mode,
      value: input.value,
      total_count: rowCount,
      sample_objects: sampleObjects,
      museum_breakdown: museumBreakdown,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# Smithsonian — ${result.mode}: ${result.value}`);
    lines.push(`**Total objects:** ${result.total_count.toLocaleString()}`);
    lines.push(`**Sample:** ${result.sample_objects.length} objects\n`);
    for (const obj of result.sample_objects) {
      lines.push(
        `- **${obj.title}** (${obj.unit_code}) — ID: \`${obj.record_id}\`${obj.is_cc0 ? ' · CC0' : ''}`,
      );
      if (obj.thumbnail_url) lines.push(`  Thumbnail: ${obj.thumbnail_url}`);
    }
    if (result.museum_breakdown.length > 0) {
      lines.push('\n**Museum breakdown (from sample):**');
      for (const m of result.museum_breakdown) {
        lines.push(`- ${m.museum_name} (${m.unit_code}): ${m.count} in sample`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
