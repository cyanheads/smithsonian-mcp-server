/**
 * @fileoverview Page-size inputs served at their cap: the shared input schema, its advertised
 * metadata, and the clamp that discloses an over-cap request.
 * @module mcp-server/tools/page-size
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';
import { clampLimitsActive } from '@/config/server-config.js';

/**
 * The largest page each tool serves. Search, browse, and related pages match EDAN's own
 * `/search` maximum of 1,000 rows. `list_terms` slices a vocabulary EDAN returns whole, so its cap
 * is a response-size choice: 40,000 terms stays near 1 MB per output surface.
 */
export const PAGE_CAPS = {
  smithsonian_search_objects: 1000,
  smithsonian_browse_category: 1000,
  smithsonian_find_related: 1000,
  smithsonian_list_terms: 40_000,
} as const;

export type PagedTool = keyof typeof PAGE_CAPS;

/**
 * A whole-number page size served at its cap. Clamping, the default, accepts any larger value,
 * so the integer check is `multipleOf(1)` plus a refinement (`multipleOf` tolerates float noise
 * such as 20.000000000000004) rather than `.int()`, which advertises 9007199254740991. Under
 * SMITHSONIAN_CLAMP_LIMITS=false the cap is enforced with Zod's own `too_big` issue. The mode is
 * read at parse time, never when the schema is built: `tool()` emits every input schema when its
 * module is imported, before `setup()` parses the environment.
 */
export function pageSizeInput(tool: PagedTool, field: 'rows' | 'limit') {
  const cap = PAGE_CAPS[tool];
  const whole = `Use a whole number for ${field}.`;
  return z
    .number()
    .multipleOf(1, whole)
    .min(1)
    .refine(Number.isInteger, { message: whole, when: ({ issues }) => issues.length === 0 })
    .check((payload) => {
      if (payload.issues.length || clampLimitsActive() || payload.value <= cap) return;
      payload.issues.push({
        code: 'too_big',
        origin: 'number',
        maximum: cap,
        inclusive: true,
        input: payload.value,
      });
    });
}

/**
 * The JSON Schema metadata of a {@link pageSizeInput}, applied last with `.meta()`. Its
 * description and `maximum` are getters, read on every `tools/list` emission, so they follow the
 * switch `setup()` parsed rather than the default in force at import.
 */
export function pageSizeMeta(tool: PagedTool, describe: (clamped: boolean, cap: number) => string) {
  const cap = PAGE_CAPS[tool];
  return {
    type: 'integer',
    get description() {
      return describe(clampLimitsActive(), cap);
    },
    get maximum() {
      return clampLimitsActive() ? undefined : cap;
    },
  };
}

/** A served page size and, when the request exceeded its cap, the sentence disclosing it. */
export interface ServedPageSize {
  notice?: string;
  value: number;
}

/** Created on first use: a counter made at import binds to the no-op meter OTel starts with. */
let clampCounter: ReturnType<typeof createCounter> | undefined;

/**
 * Serve an over-cap page size at its cap, before any upstream request. Each clamp writes one log
 * line and one count labelled by tool and input; the requested value is caller-chosen, so it
 * goes on the log line only. The notice is one sentence: callers compose it with their own
 * truncation guidance into a single `notice`, since enrichment `notice` is last-wins.
 */
export function servePageSize(
  tool: PagedTool,
  field: 'rows' | 'limit',
  requested: number,
  ctx: Context,
): ServedPageSize {
  const cap = PAGE_CAPS[tool];
  if (requested <= cap) return { value: requested };
  ctx.log.info(`Served ${field} at its cap`, { tool, input: field, requested, served: cap });
  clampCounter ??= createCounter(
    'smithsonian.input.clamps',
    'Over-cap page sizes served at their cap',
    '{clamps}',
  );
  clampCounter.add(1, { [ATTR_MCP_TOOL_NAME]: tool, 'smithsonian.input.name': field });
  return {
    value: cap,
    // Names the size the page was served with, not a row count: a last page holds fewer.
    notice: `${field} ${requested} exceeds the cap of ${cap}; the page was served with ${field} ${cap}.`,
  };
}

/**
 * Write a page's one enrichment `notice`: the `leading` sentences (the clamp, partial-failure
 * and empty-result guidance), then the paging `guidance` when the page is truncated, then the
 * `trailing` sentence. Enrichment `notice` is last-wins, so everything for the call composes
 * into one string; a truncated page carries it through `ctx.enrich.truncated`.
 */
export function enrichPageNotice(
  ctx: Context,
  parts: {
    leading: ReadonlyArray<string | undefined>;
    trailing?: string | undefined;
    truncation?: { shown: number; cap: number; ceiling: number; guidance: string } | undefined;
  },
): void {
  const { leading, trailing, truncation } = parts;
  if (truncation) {
    ctx.enrich.truncated({
      ...truncation,
      guidance: [...leading, truncation.guidance, trailing].filter(Boolean).join(' '),
    });
    return;
  }
  const notice = [...leading, trailing].filter(Boolean).join(' ');
  if (notice) ctx.enrich.notice(notice);
}
