/**
 * @fileoverview The `content[]` encoders for the two Markdown slots the framework's escapers do
 * not cover on their own: an ATX heading, which ends at its line break, and the quoted `notice`
 * enrichment trailer, whose text composes authored guidance around upstream and caller strings.
 * @module mcp-server/tools/markdown-encoders
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

/**
 * `value` as ATX heading text that a CommonMark parse reads back exactly. Each line goes through
 * `escapeMarkdownInline`, which turns its edge whitespace into references (`&#32;`) the heading's
 * own trim cannot drop, and the lines are joined by `&#10;`, since a hard break would end the
 * heading. CR and CRLF read back as LF.
 */
export function headingText(value: string): string {
  return value
    .split(/\r\n?|\n/)
    .map((line) => escapeMarkdownInline(line))
    .join('&#10;');
}

/**
 * The trailer render of an enrichment `notice`: the text through `escapeMarkdownInline`, every
 * line quoted. `structuredContent.notice` carries signal labels, a scoped `unit_code`, and a
 * `contains` substring raw, so they are escaped here, never where the notice is composed, and the
 * block quote reads back to that raw value.
 */
export const noticeTrailer = {
  render: (notice = '') =>
    escapeMarkdownInline(notice)
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n'),
};
