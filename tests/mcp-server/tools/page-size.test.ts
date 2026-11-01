/**
 * @fileoverview Tests for the shared page-size input: its parse rules in both clamp modes, the
 * advertised JSON Schema, and the clamp's notice, log line, and counter.
 * @module tests/mcp-server/tools/page-size.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { ATTR_MCP_TOOL_NAME } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadClampSwitch } from '@/config/server-config.js';
import {
  PAGE_CAPS,
  pageSizeInput,
  pageSizeMeta,
  servePageSize,
} from '@/mcp-server/tools/page-size.js';

const add = vi.hoisted(() => vi.fn());
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: vi.fn(() => ({ add })),
}));

function strictMode(): void {
  vi.stubEnv('SMITHSONIAN_CLAMP_LIMITS', 'false');
  loadClampSwitch();
}

afterEach(() => {
  vi.unstubAllEnvs();
  loadClampSwitch();
});

describe('pageSizeInput', () => {
  const rows = pageSizeInput('smithsonian_search_objects', 'rows');

  it.each([1, 20, 1000])('accepts %d', (value) => {
    expect(rows.parse(value)).toBe(value);
  });

  it.each([
    [0, 'too_small'],
    [-1, 'too_small'],
  ])('rejects %d as %s', (value, code) => {
    const result = rows.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe(code);
  });

  it.each([2.5, 20.000000000000004])(
    'rejects the non-integer %d with a whole-number message',
    (value) => {
      const result = rows.safeParse(value);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((i) => i.message)).toEqual(['Use a whole number for rows.']);
    },
  );

  it('accepts any whole number above the cap while clamping is on', () => {
    expect(rows.parse(5000)).toBe(5000);
    expect(pageSizeInput('smithsonian_list_terms', 'rows').parse(40_001)).toBe(40_001);
  });

  it.each([
    ['smithsonian_search_objects', 1000],
    ['smithsonian_browse_category', 1000],
    ['smithsonian_find_related', 1000],
    ['smithsonian_list_terms', 40_000],
  ] as const)(
    '%s rejects cap + 1 with too_big under the strict switch and accepts the cap',
    (tool, cap) => {
      expect(PAGE_CAPS[tool]).toBe(cap);
      strictMode();
      const schema = pageSizeInput(tool, 'rows');
      expect(schema.parse(cap)).toBe(cap);
      const result = schema.safeParse(cap + 1);
      expect(result.success).toBe(false);
      expect(result.error?.issues).toEqual([
        expect.objectContaining({ code: 'too_big', maximum: cap, inclusive: true }),
      ]);
    },
  );

  it('reads the switch at parse time, so a schema built before setup() follows it', () => {
    const built = pageSizeInput('smithsonian_search_objects', 'rows');
    expect(built.safeParse(1001).success).toBe(true);
    strictMode();
    expect(built.safeParse(1001).success).toBe(false);
  });

  it('reports a non-integer once, without a cap issue, under the strict switch', () => {
    strictMode();
    const result = rows.safeParse(1500.5);
    expect(result.error?.issues.map((i) => [i.code, i.message])).toEqual([
      ['not_multiple_of', 'Use a whole number for rows.'],
    ]);
  });
});

describe('pageSizeMeta', () => {
  const schema = pageSizeInput('smithsonian_browse_category', 'rows')
    .default(10)
    .meta(
      pageSizeMeta('smithsonian_browse_category', (clamped, cap) =>
        clamped ? `clamped at ${cap}` : `max ${cap}`,
      ),
    );
  const emit = () =>
    JSON.parse(JSON.stringify(z.toJSONSchema(schema, { io: 'input' }))) as Record<string, unknown>;

  it('advertises an integer with no maximum while clamping is on', () => {
    const json = emit();
    expect(json.type).toBe('integer');
    expect(json).not.toHaveProperty('maximum');
    expect(json.description).toBe('clamped at 1000');
  });

  it('advertises the cap as maximum under the strict switch, read at emission time', () => {
    strictMode();
    const json = emit();
    expect(json.maximum).toBe(1000);
    expect(json.description).toBe('max 1000');
  });
});

describe('servePageSize', () => {
  beforeEach(() => {
    add.mockClear();
  });

  it('serves a size at or under the cap unchanged, with no notice, log line, or count', () => {
    const ctx = createMockContext();
    expect(servePageSize('smithsonian_find_related', 'limit', 1000, ctx)).toEqual({ value: 1000 });
    expect(servePageSize('smithsonian_find_related', 'limit', 1, ctx)).toEqual({ value: 1 });
    const calls = (ctx.log as unknown as { calls: Array<{ msg: string }> }).calls;
    expect(calls.filter((c) => c.msg.startsWith('Served'))).toHaveLength(0);
    expect(add).not.toHaveBeenCalled();
  });

  it('serves an over-cap size at the cap with one notice sentence, one log line, and one count', () => {
    const ctx = createMockContext();
    expect(servePageSize('smithsonian_list_terms', 'rows', 40_001, ctx)).toEqual({
      value: 40_000,
      notice: 'rows 40001 exceeds the cap of 40000; the page was served with rows 40000.',
    });
    const calls = (ctx.log as unknown as { calls: Array<{ msg: string; data?: unknown }> }).calls;
    const clampLogs = calls.filter((c) => c.msg === 'Served rows at its cap');
    expect(clampLogs).toHaveLength(1);
    expect(clampLogs[0]!.data).toMatchObject({
      tool: 'smithsonian_list_terms',
      input: 'rows',
      requested: 40_001,
      served: 40_000,
    });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(1, {
      [ATTR_MCP_TOOL_NAME]: 'smithsonian_list_terms',
      'smithsonian.input.name': 'rows',
    });
  });

  it('names the field it served in the notice and the count', () => {
    const ctx = createMockContext();
    expect(servePageSize('smithsonian_find_related', 'limit', 2000, ctx).notice).toBe(
      'limit 2000 exceeds the cap of 1000; the page was served with limit 1000.',
    );
    expect(add).toHaveBeenCalledWith(1, {
      [ATTR_MCP_TOOL_NAME]: 'smithsonian_find_related',
      'smithsonian.input.name': 'limit',
    });
  });
});
