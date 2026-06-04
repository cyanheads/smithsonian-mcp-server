#!/usr/bin/env node
/**
 * @fileoverview smithsonian-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { smithsonianExplore } from './mcp-server/tools/definitions/smithsonian-explore.tool.js';
import { smithsonianFindRelated } from './mcp-server/tools/definitions/smithsonian-find-related.tool.js';
import { smithsonianGetMedia } from './mcp-server/tools/definitions/smithsonian-get-media.tool.js';
import { smithsonianGetObject } from './mcp-server/tools/definitions/smithsonian-get-object.tool.js';
import { smithsonianListTerms } from './mcp-server/tools/definitions/smithsonian-list-terms.tool.js';
import { smithsonianSearch } from './mcp-server/tools/definitions/smithsonian-search.tool.js';
import { initSmithsonianService } from './services/smithsonian/smithsonian-service.js';

await createApp({
  tools: [
    smithsonianSearch,
    smithsonianListTerms,
    smithsonianGetObject,
    smithsonianGetMedia,
    smithsonianExplore,
    smithsonianFindRelated,
  ],
  resources: [],
  prompts: [],
  instructions:
    'Smithsonian Open Access API — 19.4M objects across 20+ museums.\n' +
    '- Start with smithsonian_search or smithsonian_explore for discovery.\n' +
    '- Use smithsonian_list_terms to enumerate valid filter values before filtering (unit_code, object_type, culture, place, date).\n' +
    '- Use smithsonian_get_object for full provenance metadata.\n' +
    '- Use smithsonian_get_media for CC0 image URLs.\n' +
    '- Use smithsonian_find_related for cross-collection discovery.\n' +
    '- Requires SMITHSONIAN_API_KEY (free from https://api.data.gov/signup).',
  setup(core) {
    initSmithsonianService(core.config, core.storage);
  },
});
