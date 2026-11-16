/**
 * @fileoverview Tests for the heading and notice encoders: exact renderings, CommonMark
 * read-back, and scan time.
 * @module tests/mcp-server/tools/markdown-encoders.test
 */

import { describe, expect, it } from 'vitest';
import { headingText, noticeTrailer } from '@/mcp-server/tools/markdown-encoders.js';
import { headings, quotes } from './markdown-read-back.js';

/** Values a reader must get back whole: markup, edge whitespace, and every line-break shape. */
const HOSTILE = [
  'Tables of functions with formulae and curves <Funktionentafeln mit Formeln und Kurven> by Dr. Eugene Jahnke ... and Fritz Emde ..',
  'M*A*S*H Television Series',
  'Samuel Peck & Co. ',
  'Trees and Flowers in Washington, \nDC',
  '  indented and trailing\t',
  'C #',
  '#',
  ' #',
  '# not a heading\n- not a list\n> not a quote\n1. not ordered\n---',
  '<em>raw</em> <U+309A> `code` [link](https://x.y) ![img](https://x.y/i.png) _under_ ~strike~ a|b',
  '&amp; &#10; &copy; AT&T',
  'ends with a backslash \\',
  'blank\n\nlines',
  '\nleading break',
  'trailing break\n',
  '',
];

describe('headingText', () => {
  it.each([
    ['Samuel Peck & Co. ', 'Samuel Peck & Co.&#32;'],
    ['Trees and Flowers in Washington, \nDC', 'Trees and Flowers in Washington,&#32;&#10;DC'],
    [
      'Tables of functions with formulae and curves <Funktionentafeln mit Formeln und Kurven> by Dr. Eugene Jahnke ... and Fritz Emde ..',
      'Tables of functions with formulae and curves \\<Funktionentafeln mit Formeln und Kurven> by Dr. Eugene Jahnke ... and Fritz Emde ..',
    ],
    ['carriage\r\nreturn\rline', 'carriage&#10;return&#10;line'],
    ['plain title', 'plain title'],
  ])('renders %j as %j', (value, rendered) => {
    expect(headingText(value)).toBe(rendered);
  });

  it.each(HOSTILE)('reads back as the value under CommonMark: %j', (value) => {
    expect(headings(`### ${headingText(value)}\nnext line`)).toEqual([value]);
  });

  it('reads CR and CRLF back as LF', () => {
    expect(headings(`# ${headingText('a\r\nb\rc')}`)).toEqual(['a\nb\nc']);
  });
});

describe('noticeTrailer', () => {
  it('escapes the raw notice and quotes every line', () => {
    expect(
      noticeTrailer.render(
        'Partial results: signal searches failed for culture: M*A*S*H (timeout).',
      ),
    ).toBe('> Partial results: signal searches failed for culture: M\\*A\\*S\\*H (timeout).');
    expect(noticeTrailer.render('first\n\nthird')).toBe('> first\\\n> \\\n> third');
  });

  it.each(HOSTILE)('reads back as the raw notice in one block quote: %j', (value) => {
    const rendered = noticeTrailer.render(value);
    expect(quotes(`${rendered}\n\n**after:** the next trailer field`)).toEqual([value]);
  });

  it('keeps authored call syntax readable', () => {
    const notice =
      'No object other than the anchor matches a signal within unit_code "NMAH". smithsonian_list_terms { field: "unit_code" } lists them.';
    expect(noticeTrailer.render(notice)).toBe(`> ${notice}`);
  });
});

/**
 * Least CPU time per call of `run`, in microseconds, over three measurements. Each measurement
 * repeats `run` until this thread has spent 10 ms, so a 5k input is timed over a batch; keeping
 * the least drops garbage-collection pauses, which only ever add time.
 */
function cpuPerCall(run: () => void): number {
  let least = Number.POSITIVE_INFINITY;
  for (let measurement = 0; measurement < 3; measurement++) {
    const start = process.threadCpuUsage();
    let runs = 0;
    let spent = 0;
    do {
      run();
      runs++;
      const elapsed = process.threadCpuUsage(start);
      spent = elapsed.user + elapsed.system;
    } while (spent < 10_000);
    least = Math.min(least, spent / runs);
  }
  return least;
}

describe('encoder scan time', () => {
  const ENCODERS: Array<[name: string, encode: (text: string) => string]> = [
    ['headingText', headingText],
    ['noticeTrailer.render', noticeTrailer.render],
  ];
  /** The two line-break shapes: one long line ending in a break, and breaks throughout. */
  const SHAPES: Array<[shape: string, make: (size: number) => string]> = [
    ['one long line ending in a break', (n) => `${'§1 x'.repeat(Math.ceil(n / 4))}\ny`],
    ['breaks throughout', (n) => '  \r\n'.repeat(Math.ceil(n / 4))],
  ];
  const CASES = ENCODERS.flatMap(([name, encode]) =>
    SHAPES.map(([shape, make]) => [name, shape, encode, make] as const),
  );

  it.each(CASES)(
    '%s stays linear on %s',
    (_name, _shape, encode, make) => {
      const sizes = Array.from({ length: 7 }, (_, i) => 5_000 * 2 ** i);
      // Bounded before the next doubling, so a super-linear scan fails in seconds at a small
      // size instead of hanging the suite on the largest one.
      for (const size of sizes) {
        const input = make(size);
        expect(cpuPerCall(() => encode(input))).toBeLessThan(size * 0.25);
      }
      // Full-span growth from pairs timed back to back, the least of three: a baseline timed
      // once can land on a faster core than the size it is compared with.
      const smallest = make(sizes[0] as number);
      const largest = make(sizes.at(-1) as number);
      let growth = Number.POSITIVE_INFINITY;
      for (let pair = 0; pair < 3; pair++) {
        const small = cpuPerCall(() => encode(smallest));
        growth = Math.min(growth, cpuPerCall(() => encode(largest)) / small);
      }
      expect(growth).toBeLessThan(256);
    },
    0,
  );
});
