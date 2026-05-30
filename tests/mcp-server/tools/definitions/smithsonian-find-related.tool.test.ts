/**
 * @fileoverview Tests for smithsonian_find_related tool.
 * @module tests/mcp-server/tools/definitions/smithsonian-find-related.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { smithsonianFindRelated } from '@/mcp-server/tools/definitions/smithsonian-find-related.tool.js';
import * as svcModule from '@/services/smithsonian/smithsonian-service.js';
import type { ObjectSummary, RawEDAN } from '@/services/smithsonian/types.js';

function makeAnchorRaw(id = 'nasm_TEST001'): RawEDAN {
  return {
    id: 'ld1-anchor',
    title: 'Anchor Object',
    unitCode: 'NASM',
    url: `edanmdm:${id}`,
    content: {
      descriptiveNonRepeating: {
        record_ID: id,
        unit_code: 'NASM',
        metadata_usage: { access: 'CC0' },
      },
      indexedStructured: {
        culture: ['American'],
        object_type: ['Aircraft'],
        date: ['1960s'],
        topic: ['Aviation'],
      },
      freetext: {
        name: [{ label: 'Manufacturer', content: 'Lockheed' }],
      },
    },
  };
}

function makeRelatedRows(): ObjectSummary[] {
  return [
    {
      record_id: 'nasm_RELATED001',
      title: 'Related Aircraft 1',
      unit_code: 'NASM',
      museum_name: 'National Air and Space Museum',
      is_cc0: true,
      has_media: true,
    },
    {
      record_id: 'nmah_RELATED002',
      title: 'Related Object 2',
      unit_code: 'NMAH',
      museum_name: 'National Museum of American History',
      is_cc0: false,
      has_media: false,
    },
  ];
}

describe('smithsonianFindRelated', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns related objects for a valid anchor ID', async () => {
    const anchorRaw = makeAnchorRaw();
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue(anchorRaw),
      toSummary: vi.fn().mockReturnValue({
        record_id: 'nasm_TEST001',
        title: 'Anchor Object',
        unit_code: 'NASM',
        museum_name: 'National Air and Space Museum',
        is_cc0: true,
        has_media: true,
      }),
      search: vi.fn().mockResolvedValue({ rows: makeRelatedRows(), rowCount: 2 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    const input = smithsonianFindRelated.input.parse({ id: 'nasm_TEST001' });
    const result = await smithsonianFindRelated.handler(input, ctx);

    expect(result.anchor.record_id).toBe('nasm_TEST001');
    expect(result.anchor.title).toBe('Anchor Object');
    expect(result.related.length).toBeGreaterThan(0);
    expect(result.search_signals_used.length).toBeGreaterThan(0);
    // Anchor should not appear in related
    for (const rel of result.related) {
      expect(rel.record_id).not.toBe('nasm_TEST001');
    }
  });

  it('throws invalid_id for empty ID', async () => {
    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    const input = smithsonianFindRelated.input.parse({ id: '   ' });
    await expect(smithsonianFindRelated.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id' },
    });
  });

  it('deduplicates results — no duplicate record_ids', async () => {
    const anchorRaw = makeAnchorRaw();
    // Fan-out returns overlapping results
    const duplicated = [...makeRelatedRows(), makeRelatedRows()[0]!];
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue(anchorRaw),
      toSummary: vi.fn().mockReturnValue({
        record_id: 'nasm_TEST001',
        title: 'Anchor Object',
        unit_code: 'NASM',
        museum_name: 'National Air and Space Museum',
        is_cc0: true,
        has_media: true,
      }),
      search: vi.fn().mockResolvedValue({ rows: duplicated, rowCount: duplicated.length }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    const input = smithsonianFindRelated.input.parse({ id: 'nasm_TEST001', limit: 20 });
    const result = await smithsonianFindRelated.handler(input, ctx);

    const ids = result.related.map((r) => r.record_id);
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });

  it('caps results at the limit', async () => {
    const anchorRaw = makeAnchorRaw();
    // 15 distinct related objects
    const manyRelated: ObjectSummary[] = Array.from({ length: 15 }, (_, i) => ({
      record_id: `nasm_MANY${i + 1}`,
      title: `Many ${i + 1}`,
      unit_code: 'NASM',
      museum_name: 'National Air and Space Museum',
      is_cc0: true,
      has_media: false,
    }));
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue(anchorRaw),
      toSummary: vi.fn().mockReturnValue({
        record_id: 'nasm_TEST001',
        title: 'Anchor',
        unit_code: 'NASM',
        museum_name: 'National Air and Space Museum',
        is_cc0: true,
        has_media: false,
      }),
      search: vi.fn().mockResolvedValue({ rows: manyRelated, rowCount: 15 }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    const input = smithsonianFindRelated.input.parse({ id: 'nasm_TEST001', limit: 5 });
    const result = await smithsonianFindRelated.handler(input, ctx);

    expect(result.related.length).toBeLessThanOrEqual(5);
  });

  it('returns empty related array when all fan-out searches return only the anchor or no hits', async () => {
    // Design spec: "Returns up to 20 related objects ... empty when no related objects were found."
    // If every fan-out search result only contains the anchor ID (already in seen set),
    // the deduplicated result must be an empty array — not an error.
    const anchorRaw = makeAnchorRaw();
    const anchorSummary = {
      record_id: 'nasm_TEST001',
      title: 'Anchor Object',
      unit_code: 'NASM',
      museum_name: 'National Air and Space Museum',
      is_cc0: true,
      has_media: true,
    };
    vi.spyOn(svcModule, 'getSmithsonianService').mockReturnValue({
      getContent: vi.fn().mockResolvedValue(anchorRaw),
      toSummary: vi.fn().mockReturnValue(anchorSummary),
      // Every search returns only the anchor itself — all deduplicated away
      search: vi.fn().mockResolvedValue({
        rows: [{ ...anchorSummary }],
        rowCount: 1,
      }),
    } as unknown as svcModule.SmithsonianService);

    const ctx = createMockContext({ errors: smithsonianFindRelated.errors });
    const input = smithsonianFindRelated.input.parse({ id: 'nasm_TEST001' });
    const result = await smithsonianFindRelated.handler(input, ctx);

    // Must not throw — empty related is a valid outcome, not an error
    expect(result.related).toHaveLength(0);
    expect(result.anchor.record_id).toBe('nasm_TEST001');
    expect(result.search_signals_used.length).toBeGreaterThan(0);
  });

  it('format renders anchor, related record_ids, and similarity signals', () => {
    const output = {
      anchor: { record_id: 'nasm_TEST001', title: 'Anchor Object', unit_code: 'NASM' },
      related: [
        {
          record_id: 'nasm_RELATED001',
          title: 'Related 1',
          unit_code: 'NASM',
          museum_name: 'National Air and Space Museum',
          is_cc0: true,
          similarity_signals: ['culture: American', 'period: 1960s'],
        },
      ],
      search_signals_used: ['culture: American', 'maker: Lockheed'],
    };
    const blocks = smithsonianFindRelated.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('nasm_TEST001');
    expect(text).toContain('nasm_RELATED001');
    expect(text).toContain('culture: American');
    expect(text).toContain('maker: Lockheed');
  });

  it('format renders cleanly when related is empty', () => {
    const output = {
      anchor: { record_id: 'nasm_TEST001', title: 'Anchor Object', unit_code: 'NASM' },
      related: [],
      search_signals_used: ['culture: American'],
    };
    const blocks = smithsonianFindRelated.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('nasm_TEST001');
    expect(text).toContain('0'); // related count
    expect(blocks).toHaveLength(1);
  });
});
