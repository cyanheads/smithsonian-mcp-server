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
import type { TermDescription } from '@/services/smithsonian/types.js';

/** The category dimension a browse targets. */
type BrowseMode = 'museum' | 'culture' | 'period' | 'medium' | 'topic';

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
  topic: 'topic',
};

/** Upper bound on object_type candidates named in a medium recovery hint. */
const MAX_OBJECT_TYPE_CANDIDATES = 12;

/**
 * Compose the mode-specific recovery hint for a zero-match category browse. A
 * browse category is an exact indexed facet, so a zero match means the value did
 * not resolve to retrievable objects, not that an object is missing (issue #31).
 *
 * For museum, culture, period, and topic, `term.indexed` splits the two ways that
 * happens. A value outside the vocabulary is resolvable, so the hint names the
 * literal smithsonian_list_terms call that resolves it. A value the index
 * enumerates but that matches no object — 14 of the 48 unit codes and a long tail
 * of culture terms are in this state — is NOT resolvable: list_terms hands the
 * same value back and the caller loops through the identical failure (issue #33).
 * That branch says the term is indexed and empty, and routes somewhere that can
 * succeed. Where that route is a `contains` search — culture and topic, the two
 * vocabularies too large to browse whole — it names `term.neighbors.contains`, the
 * tightest substring the service proved lists other terms (issue #47) and few
 * enough of them to beat browsing the field (issue #48), and drops the clause when
 * there is none rather than handing back the failing value (issue
 * #46). museum and period route to the unfiltered vocabulary (48 unit codes, ~200
 * date terms), so neither ever depended on a substring. medium's object_type is
 * not enumerable upstream, so it never gets a vocabulary check; `objectTypes`,
 * harvested from a free-text re-query, names candidates directly and falls back to
 * routing the caller to that same search when the harvest comes back empty. Never
 * auto-selects a candidate: the hint lists terms and the caller picks the
 * intended one.
 */
function categoryRecoveryHint(
  mode: BrowseMode,
  value: string,
  term: TermDescription,
  objectTypes: string[],
): string {
  const neighbors = term.neighbors;
  switch (mode) {
    case 'museum':
      if (term.indexed) {
        return `"${value}" is an indexed Smithsonian unit code, but it currently matches no retrievable objects — resolving it again returns the same value. Browse a different unit (smithsonian_list_terms { field: "unit_code" } lists all 48 codes with their museum names), or search the collection directly with smithsonian_search_objects.`;
      }
      // `contains` matches each code's museum name as well as the code itself
      // (issue #37), so a museum name typed in place of a code resolves here too
      // — no separate branch for a spaced value.
      return `"${value}" is not an exact Smithsonian unit code. Resolve it to a real code with smithsonian_list_terms { field: "unit_code", contains: "${value}" }, which matches museum names as well as codes, then browse again with the exact value.`;
    case 'culture':
      if (term.indexed) {
        return neighbors
          ? `"${value}" is an indexed culture term, but it currently matches no retrievable objects — resolving it again returns the same value. Browse ${neighbors.count === 1 ? 'the one other culture term' : `one of the ${neighbors.count} other culture terms`} from smithsonian_list_terms { field: "culture", contains: "${neighbors.contains}" }, or search the collection directly with smithsonian_search_objects.`
          : `"${value}" is an indexed culture term, but it currently matches no retrievable objects — resolving it again returns the same value, and a bounded search of its fragments found no narrow set of other culture terms to browse. Search the collection directly with smithsonian_search_objects.`;
      }
      return `"${value}" is not an exact culture term. Resolve it with smithsonian_list_terms { field: "culture", contains: "${value}" }, then browse again with the exact value.`;
    case 'period':
      if (term.indexed) {
        return `"${value}" is an indexed date term, but it currently matches no retrievable objects — resolving it again returns the same value. Browse a different term from smithsonian_list_terms { field: "date" }, or search the collection directly with smithsonian_search_objects.`;
      }
      return `"${value}" matched no indexed date term. Resolve an indexed value with smithsonian_list_terms { field: "date", contains: "${value}" }, then browse again with the exact value.`;
    case 'topic':
      if (term.indexed) {
        return neighbors
          ? `"${value}" is an indexed topic term, but it currently matches no retrievable objects — resolving it again returns the same value. Browse ${neighbors.count === 1 ? 'the one other topic term' : `one of the ${neighbors.count} other topic terms`} from smithsonian_list_terms { field: "topic", contains: "${neighbors.contains}" }, or search the collection directly with smithsonian_search_objects.`
          : `"${value}" is an indexed topic term, but it currently matches no retrievable objects — resolving it again returns the same value, and a bounded search of its fragments found no narrow set of other topic terms to browse. Search the collection directly with smithsonian_search_objects.`;
      }
      return `"${value}" is not an exact topic term. Resolve it with smithsonian_list_terms { field: "topic", contains: "${value}" }, then browse again with the exact value.`;
    case 'medium':
      if (objectTypes.length > 0) {
        return `"${value}" is not an exact object_type term. Object types present for a free-text search of "${value}" — ${objectTypes.join(', ')}. Browse again with one of these exact terms (object_type is commonly plural, e.g. "Paintings"). Casing variants are separate categories with separate totals, so if the one you pick comes back thin, browse its other casings too.`;
      }
      return `"${value}" is not an exact object_type term, and object_type is not enumerable through smithsonian_list_terms. Run smithsonian_search_objects { query: "${value}" } and inspect the object_type values in the results (commonly plural, e.g. "Paintings") to find the exact term, then browse again with mode "medium". A sampled result set can show several casings of one concept and each is its own category, so browse the variants rather than assuming one covers it.`;
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

/**
 * Where the failed value sits in the mode's term vocabulary — the branch
 * `categoryRecoveryHint` needs to tell an unresolvable value from a resolvable
 * one, plus the substring that lists neighbors when one exists. medium's
 * object_type is not enumerable upstream, so it is never checked. Best-effort and
 * failure-path only, like `harvestObjectTypes`: a throwing lookup yields the
 * unindexed answer and the resolve-it hint stands, which is the behavior that
 * predates the check.
 */
async function describeCategoryValue(
  svc: SmithsonianService,
  mode: BrowseMode,
  value: string,
  ctx: RequestContextLike,
): Promise<TermDescription> {
  if (mode === 'medium') return { indexed: false };
  try {
    return await svc.describeTerm(MODE_FIELD[mode], value, ctx);
  } catch {
    return { indexed: false };
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
    is_cc0: z
      .boolean()
      .describe(
        'True when the object metadata is CC0 (open access). The Smithsonian Open Access corpus is CC0 throughout, so this flag rarely varies and cannot gate an image download — read thumbnail_url for that.',
      ),
  })
  .describe('A sample object from the requested page of category matches.');

export const smithsonianBrowseCategory = tool('smithsonian_browse_category', {
  title: 'Browse Smithsonian by Category',
  description:
    'Browse Smithsonian objects within one exact category — a single museum (mode "museum"), culture, indexed date term (mode "period"), object type (mode "medium"), or subject term (mode "topic"). The value must be an exact indexed category term, not free text: resolve museum, culture, period, and topic vocabulary with smithsonian_list_terms first (object_type is not enumerable there — harvest it from smithsonian_search_objects results, and treat each casing as its own category, since a harvested object_type covers only the casing it was written in). Returns the category total count, a page of matching objects, and a museum breakdown of that page; page the full category with start and rows. For open-ended or topic discovery, start with smithsonian_search_objects instead.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    mode: z
      .enum(['museum', 'culture', 'period', 'medium', 'topic'])
      .describe(
        'Browse dimension: "museum" (by unit code), "culture" (by culture term), "period" (by indexed date term like "1940s" or "500-1500"), "medium" (by object type like "Paintings"), "topic" (by subject term like "Quilts").',
      ),
    value: z
      .string()
      .describe(
        'Category value appropriate to the mode. museum: a unit code like "NASM", "SAAM", or "NMNHBIRDS", matched literally and case-sensitively — not a museum name. culture: term, often plural or qualified ("Aztecs", "Plains Indian"). period: an indexed date term — commonly a decade ("1940s", "1860s"), but year ranges ("500-1500"), century terms ("21st century"), and BCE forms ("-2500", "BCE 1000s") are indexed too. medium: object type, usually plural ("Paintings", "Aircraft"). topic: subject term ("Quilts", "Aviation"). Smithsonian uses a controlled vocabulary — for museum (unit_code), culture, period (date), and topic, call smithsonian_list_terms to find exact terms; medium (object_type) is not enumerable there, so harvest it from smithsonian_search_objects results. Every mode matches its value exactly and case-sensitively, and for medium that split is load-bearing: casing variants are indexed as SEPARATE categories, each reporting its own total_count ("button" and "Button" are different categories, and neither casing is reliably the larger), so browse the variants of a harvested value rather than assuming one covers the concept.',
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
  }),

  output: z.object({
    mode: z
      .string()
      .describe(
        'Browse dimension used for this request (one of "museum", "culture", "period", "medium", "topic").',
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
      when: 'The category value matched no objects — a browse category is an exact indexed facet, so a zero match means the value did not resolve to retrievable objects.',
      recovery:
        'Read the hint: it says whether the value is outside the vocabulary, which smithsonian_list_terms resolves, or is an indexed term with no retrievable objects, which needs a different term or a smithsonian_search_objects free-text query instead.',
    },
  ],

  async handler(input, ctx) {
    const svc = getSmithsonianService();

    // The category IS the query: the mode's field constraint is embedded in q as a
    // Lucene field:value term (EDAN has no fq param) with no free-text base query.
    // luceneField's quoting and escaping are load-bearing — an unquoted value ends
    // the field term at the first space and leaks its trailing words back out as free
    // text, and an unquoted single-token `*` becomes a wildcard over the whole field.
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
      const [objectTypes, term] = await Promise.all([
        input.mode === 'medium' ? harvestObjectTypes(svc, input.value, ctx) : [],
        describeCategoryValue(svc, input.mode, input.value, ctx),
      ]);
      throw ctx.fail(
        'invalid_category',
        `No Smithsonian objects match ${input.mode} category "${input.value}".`,
        {
          recovery: { hint: categoryRecoveryHint(input.mode, input.value, term, objectTypes) },
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
        `- **${obj.title}** (${obj.unit_code}) — ID: \`${obj.record_id}\` · **CC0:** ${obj.is_cc0 ? 'Yes' : 'No'}`,
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
