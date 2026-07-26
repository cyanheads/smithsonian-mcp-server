#!/usr/bin/env node
/**
 * @fileoverview smithsonian-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { smithsonianBrowseCategory } from './mcp-server/tools/definitions/smithsonian-browse-category.tool.js';
import { smithsonianFindRelated } from './mcp-server/tools/definitions/smithsonian-find-related.tool.js';
import { smithsonianGetMedia } from './mcp-server/tools/definitions/smithsonian-get-media.tool.js';
import { smithsonianGetObject } from './mcp-server/tools/definitions/smithsonian-get-object.tool.js';
import { smithsonianListTerms } from './mcp-server/tools/definitions/smithsonian-list-terms.tool.js';
import { smithsonianSearchObjects } from './mcp-server/tools/definitions/smithsonian-search-objects.tool.js';
import { initSmithsonianService } from './services/smithsonian/smithsonian-service.js';

await createApp({
  name: 'smithsonian-mcp-server',
  title: 'smithsonian-mcp-server',
  tools: [
    smithsonianSearchObjects,
    smithsonianListTerms,
    smithsonianGetObject,
    smithsonianGetMedia,
    smithsonianBrowseCategory,
    smithsonianFindRelated,
  ],
  resources: [],
  prompts: [],
  instructions:
    'Smithsonian Open Access API — 14.5M objects across 20+ museums; 5.2M of them carry CC0 media.\n' +
    'Recommended workflow:\n' +
    '1. Start with smithsonian_search_objects for free-text or open-ended discovery.\n' +
    '2. Use smithsonian_list_terms to resolve exact museum (unit_code), culture, place, date, or topic vocabulary — terms are a controlled vocabulary, often plural (e.g. "Paintings", not "Painting").\n' +
    '3. Use smithsonian_browse_category to page objects within one known exact category (a single museum, culture, date term, object type, or topic).\n' +
    '4. Continue with smithsonian_get_object (catalog metadata), smithsonian_get_media (CC0 image URLs), or smithsonian_find_related (cross-collection discovery) by record_id.\n' +
    '- Requires SMITHSONIAN_API_KEY (free from https://api.data.gov/signup).',
  setup(core) {
    initSmithsonianService(core.config, core.storage);
  },
});
