#!/usr/bin/env node
/**
 * @fileoverview smithsonian-mcp-server MCP server entry point.
 * @module index
 */

import { fileURLToPath } from 'node:url';
import { createApp } from '@cyanheads/mcp-ts-core';
import { getMirrorConfig, loadClampSwitch } from './config/server-config.js';
import { smithsonianBrowseCategory } from './mcp-server/tools/definitions/smithsonian-browse-category.tool.js';
import { smithsonianFindRelated } from './mcp-server/tools/definitions/smithsonian-find-related.tool.js';
import { smithsonianGetMedia } from './mcp-server/tools/definitions/smithsonian-get-media.tool.js';
import { smithsonianGetObject } from './mcp-server/tools/definitions/smithsonian-get-object.tool.js';
import { smithsonianListTerms } from './mcp-server/tools/definitions/smithsonian-list-terms.tool.js';
import { smithsonianSearchObjects } from './mcp-server/tools/definitions/smithsonian-search-objects.tool.js';
import { type ServerMirror, startServerMirror } from './mirror/server-mirror.js';
import { initSmithsonianService } from './services/smithsonian/smithsonian-service.js';

/** The Open Access mirror `setup()` opened, when SMITHSONIAN_MIRROR_PATH names one. */
let mirror: ServerMirror | undefined;

await createApp({
  name: 'smithsonian-mcp-server',
  title: 'smithsonian-mcp-server',
  /**
   * No tool suspends for caller input via `ctx.requestInput`, so HTTP sessions
   * carry nothing between calls. Declared here rather than left to
   * `MCP_SESSION_MODE` so every deployment that does not set the variable — the
   * npx/stdio install included — resolves the same way the Dockerfile does.
   */
  sessionMode: 'stateless',
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
  skills: 'skills',
  instructions:
    'Smithsonian Open Access API — 14.5M objects across 20+ museums; 5.2M of them carry CC0 media.\nRecommended workflow:\n1. Start with smithsonian_search_objects for free-text or open-ended discovery.\n2. Use smithsonian_list_terms to resolve exact museum (unit_code), culture, place, date, topic, or online_media_type vocabulary — terms are a controlled vocabulary, often plural (e.g. "Paintings", not "Painting"). Media types feed search only and do not guarantee downloadable images; scientific_name values come from smithsonian_get_object.scientific_names.\n3. Use smithsonian_browse_category to page objects within one known exact category (a single museum, culture, date term, object type, or topic).\n4. Continue with smithsonian_get_object (catalog metadata), smithsonian_get_media (CC0 image URLs), or smithsonian_find_related (cross-collection discovery) by record_id.\n- Requires SMITHSONIAN_API_KEY (free from https://api.data.gov/signup). The key allows 1,000 requests per hour, shared by every caller of one deployment.\n- The smithsonian-guide skill (skill://smithsonian-guide/SKILL.md) carries the gates for query syntax (OR never widens a search), counting a museum\'s or a place\'s holdings, a person\'s indexed name, and mirror-served pages.',
  async setup(core) {
    loadClampSwitch();
    const { mirrorPath, refreshCron } = getMirrorConfig();
    if (mirrorPath) {
      mirror = await startServerMirror({
        path: mirrorPath,
        refreshCron,
        transport: core.config.mcpTransportType,
        cliPath: fileURLToPath(new URL('./mirror/cli.js', import.meta.url)),
      });
    }
    initSmithsonianService(core.config, core.storage, mirror?.reader);
  },
  async teardown() {
    await mirror?.stop();
  },
});
