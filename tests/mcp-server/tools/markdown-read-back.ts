/**
 * @fileoverview CommonMark read-back for the `content[]` tests: parses rendered text with
 * micromark (`mdast-util-from-markdown`) and returns what a reader takes from each block, so a
 * test can assert that the Markdown reads back to its `structuredContent` value. commonmark.js is
 * not the reader here: it drops a numeric reference to a space (`&#32;`) that ends a line before a
 * soft break, where micromark, markdown-it, and cmark keep it, and `escapeMarkdownInline` writes
 * a value's edge spaces exactly that way.
 * @module tests/mcp-server/tools/markdown-read-back
 */

import { fromMarkdown } from 'mdast-util-from-markdown';

/** The mdast fields these readers use. */
interface MdNode {
  alt?: string | null;
  children?: MdNode[];
  type: string;
  url?: string;
  value?: string;
}

const parse = (markdown: string): MdNode => fromMarkdown(markdown);

/**
 * What a reader takes from `node`'s inline content: text with references decoded and soft breaks
 * as LF, a code span's content, LF for a hard break, a link's label, and an image's alt text. Raw
 * HTML reads as `⟦html …⟧`, so a value that parsed as markup never reads back as itself.
 */
export function inlineText(node: MdNode): string {
  return (node.children ?? []).map(readInline).join('');
}

/** What a reader takes from one inline node, as {@link inlineText} reads it. */
function readInline(node: MdNode): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? '';
  if (node.type === 'break') return '\n';
  if (node.type === 'html') return `⟦html ${node.value}⟧`;
  if (node.type === 'image') return node.alt ?? '';
  return inlineText(node);
}

/**
 * The text of a container block: each paragraph's inline text, joined by LF. Any other child
 * block reads as `⟦<type>⟧`, so a value that opened a block of its own fails to read back.
 */
function blockText(node: MdNode): string {
  return (node.children ?? [])
    .map((child) => (child.type === 'paragraph' ? inlineText(child) : `⟦${child.type}⟧`))
    .join('\n');
}

/** Every node of `type` in `markdown`, in document order. */
function nodesOf(markdown: string, type: string): MdNode[] {
  const found: MdNode[] = [];
  const visit = (node: MdNode) => {
    if (node.type === type) found.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  visit(parse(markdown));
  return found;
}

/** The text of every heading. */
export const headings = (markdown: string) => nodesOf(markdown, 'heading').map(inlineText);

/** The text of every top-level paragraph. */
export const paragraphs = (markdown: string) =>
  (parse(markdown).children ?? []).filter((node) => node.type === 'paragraph').map(inlineText);

/** The text of every list item. A line that lazy continuation pulled into an item reads back with it. */
export const items = (markdown: string) => nodesOf(markdown, 'listItem').map(blockText);

/** The text of every block quote. */
export const quotes = (markdown: string) => nodesOf(markdown, 'blockquote').map(blockText);

/** The content of every code span. */
export const codeSpans = (markdown: string) =>
  nodesOf(markdown, 'inlineCode').map((node) => node.value ?? '');

/** Every link's label and destination. */
export const links = (markdown: string) =>
  nodesOf(markdown, 'link').map((node) => ({ text: inlineText(node), url: node.url }));

/** Every image's alt text and destination. */
export const images = (markdown: string) =>
  nodesOf(markdown, 'image').map((node) => ({ alt: node.alt ?? '', url: node.url }));

/**
 * The value after each `**<label>:**`: the inline text from the bold label to the next bold label
 * or soft line break, its one separating space dropped. A hard break inside the value reads back
 * as LF; a value ending in a line break (`&#10;`) reads back without it, since mdast decodes that
 * reference to the LF a soft break is.
 */
export function labelValues(markdown: string, label: string): string[] {
  const values: string[] = [];
  const visit = (node: MdNode) => {
    const children = node.children ?? [];
    children.forEach((child, index) => {
      if (child.type === 'strong' && inlineText(child) === `${label}:`) {
        values.push(valueAfter(children.slice(index + 1)));
      }
      visit(child);
    });
  };
  visit(parse(markdown));
  return values;
}

/** The inline text of `siblings` up to the next bold label or soft line break. */
function valueAfter(siblings: MdNode[]): string {
  let value = '';
  for (const node of siblings) {
    if (node.type === 'strong') break;
    const text = readInline(node);
    const softBreak = node.type === 'text' ? text.indexOf('\n') : -1;
    if (softBreak !== -1) {
      value += text.slice(0, softBreak);
      break;
    }
    value += text;
  }
  return value.replace(/^ /, '');
}
