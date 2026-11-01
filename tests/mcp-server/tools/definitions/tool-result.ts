/**
 * @fileoverview Readers over a tool call's result and its recorded service calls, shared by the
 * tool definition tests.
 * @module tests/mcp-server/tools/definitions/tool-result
 */

import type { vi } from 'vitest';
import type { FacetFilter } from '@/services/smithsonian/oa-mirror.js';
import { luceneFilter } from '@/services/smithsonian/smithsonian-service.js';

/** The facet filters one search call received, as the Lucene terms the live API matches. */
export function luceneTermsOf(search: ReturnType<typeof vi.fn>, call = 0): string[] {
  const params = search.mock.calls[call]?.[0] as { filters: FacetFilter[] };
  return params.filters.map(luceneFilter);
}

/** The joined text of a contract result's `content[]` blocks. */
export function textOf(result: { content?: unknown }): string {
  return ((result.content ?? []) as Array<{ type: string; text?: string }>)
    .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
    .join('\n');
}
