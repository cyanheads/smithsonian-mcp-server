/**
 * @fileoverview Server-specific configuration for smithsonian-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiKey: z
    .string()
    .min(1)
    .describe(
      'API key from https://api.data.gov/signup. Required — server fails to start without it.',
    ),
  baseUrl: z
    .string()
    .default('https://api.si.edu/openaccess/api/v1.0')
    .describe('Smithsonian Open Access API base URL.'),
  termsCacheTtlSeconds: z.coerce
    .number()
    .int()
    .min(0)
    .default(3600)
    .describe(
      "Seconds to cache each indexed field's term vocabulary. The upstream /terms endpoint ignores paging and always returns the full set (place is ~114k terms / 3.2 MB), so every uncached call re-downloads it. Terms are a controlled vocabulary with no session-scale freshness requirement. 0 disables caching.",
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'SMITHSONIAN_API_KEY',
    baseUrl: 'SMITHSONIAN_BASE_URL',
    termsCacheTtlSeconds: 'SMITHSONIAN_TERMS_CACHE_TTL_SECONDS',
  });
  return _config;
}
