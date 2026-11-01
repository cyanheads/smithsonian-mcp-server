/**
 * @fileoverview Provenance enrichment for the tools that read Smithsonian objects: which stores
 * answered a call (`sources`), the Open Access snapshot a mirror-served answer came from
 * (`mirror_snapshot`), and the sentence a mirror-served page adds to its notice. A server
 * without a mirror sets none of it, so its responses carry neither field.
 * @module mcp-server/tools/provenance
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { DATA_SOURCES, type DataSource, type Provenance } from '@/services/smithsonian/types.js';

/** The enrichment fields each object-reading tool declares. */
export const provenanceEnrichment = {
  sources: z
    .array(
      z
        .enum(DATA_SOURCES)
        .describe(
          "oa_mirror: the server's local copy of the Smithsonian Open Access bulk metadata. edan_api: the live Smithsonian API.",
        ),
    )
    .optional()
    .describe(
      "Where this answer came from. A page served from oa_mirror lists its rows in mirror order, not the live API's, and its notice names the snapshot date. Present only on a server that keeps a mirror.",
    ),
  mirror_snapshot: z
    .string()
    .optional()
    .describe(
      'Publication time (ISO 8601) of the Open Access snapshot the mirror held; what came from oa_mirror reflects the catalog as of then. Present when part of this answer came from oa_mirror.',
    ),
};

/** The `content[]` trailer lines of {@link provenanceEnrichment}. */
export const provenanceTrailer = {
  sources: {
    render: (sources: DataSource[] = []) =>
      `**Sources:** ${sources.map((source) => `\`${source}\``).join(', ')}`,
  },
  mirror_snapshot: { label: 'Mirror snapshot' },
};

/**
 * Record where a call's reads were answered: `sources` in {@link DATA_SOURCES} order, and
 * `mirror_snapshot` when any read came from the mirror. Sets nothing when every read is
 * undefined, which is every read on a server without a mirror.
 */
export function enrichProvenance(ctx: Context, reads: ReadonlyArray<Provenance | undefined>): void {
  const known = reads.filter((read) => read !== undefined);
  if (known.length === 0) return;
  const sources = DATA_SOURCES.filter((source) => known.some((read) => read.source === source));
  const snapshot = known.find((read) => read.source === 'oa_mirror')?.snapshot;
  ctx.enrich({ sources, ...(snapshot && { mirror_snapshot: snapshot }) });
}

/**
 * The sentence a page's notice carries when any of its rows came from the mirror, which
 * orders them differently than the live API: undefined when none did.
 */
export function mirrorOrderNotice(
  pages: ReadonlyArray<Provenance | undefined>,
): string | undefined {
  const mirrored = pages.find((page) => page?.source === 'oa_mirror');
  if (mirrored?.source !== 'oa_mirror') return undefined;
  const date = mirrored.snapshot
    ? ` (snapshot of ${escapeMarkdownInline(mirrored.snapshot.slice(0, 10))})`
    : '';
  return `Rows served from the Smithsonian Open Access mirror${date} are in mirror order, not the live API's.`;
}
