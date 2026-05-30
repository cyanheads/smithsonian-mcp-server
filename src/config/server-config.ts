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
  maxRows: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Default page size for search results (default 20, max 100 per API spec).'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'SMITHSONIAN_API_KEY',
    baseUrl: 'SMITHSONIAN_BASE_URL',
    maxRows: 'SMITHSONIAN_MAX_ROWS',
  });
  return _config;
}
