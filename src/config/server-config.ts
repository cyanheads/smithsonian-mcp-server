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
  searchCacheTtlSeconds: z.coerce
    .number()
    .int()
    .min(0)
    .default(3600)
    .describe(
      'Seconds to cache each normalized /search page, keyed by its request URL, so a repeated identical search costs no request against the shared hourly key budget. 0 disables the cache and the sharing of concurrent identical requests.',
    ),
  contentCacheTtlSeconds: z.coerce
    .number()
    .int()
    .min(0)
    .default(86_400)
    .describe(
      'Seconds to cache each /content record, keyed by its request URL, so the get-object, get-media, and find-related reads of one record cost one request. 0 disables the cache and the sharing of concurrent identical requests.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'SMITHSONIAN_API_KEY',
    baseUrl: 'SMITHSONIAN_BASE_URL',
    termsCacheTtlSeconds: 'SMITHSONIAN_TERMS_CACHE_TTL_SECONDS',
    searchCacheTtlSeconds: 'SMITHSONIAN_SEARCH_CACHE_TTL_SECONDS',
    contentCacheTtlSeconds: 'SMITHSONIAN_CONTENT_CACHE_TTL_SECONDS',
  });
  return _config;
}

/**
 * The page-size switch, parsed apart from {@link ServerConfigSchema} so startup can read it
 * without requiring the API key: tools/list must answer on an install that has not set one.
 */
const ClampSwitchSchema = z.object({
  clampLimits: z
    .stringbool()
    .default(true)
    .describe(
      'Serve an over-cap page size (rows or limit) at its cap with a notice; false rejects it and advertises each cap as the schema maximum.',
    ),
});

let _clampLimits: boolean | undefined;

/**
 * Parse SMITHSONIAN_CLAMP_LIMITS. Called from `setup()`, after the framework has loaded `.env`,
 * so an invalid value stops startup with the variable named. Tests call it again after
 * stubbing the variable.
 */
export function loadClampSwitch(): void {
  _clampLimits = parseEnvConfig(ClampSwitchSchema, {
    clampLimits: 'SMITHSONIAN_CLAMP_LIMITS',
  }).clampLimits;
}

/**
 * Whether over-cap page sizes are served at their cap: what {@link loadClampSwitch} parsed, or
 * the default before it runs. Never parses the environment itself, because `tool()` emits every
 * input schema when its definition module is imported, before Node has loaded `.env`.
 */
export function clampLimitsActive(): boolean {
  return _clampLimits ?? true;
}

/** The in-server mirror refresh schedule when SMITHSONIAN_MIRROR_REFRESH_CRON is unset: daily at 12:00. */
export const DEFAULT_MIRROR_REFRESH_CRON = '0 12 * * *';

/**
 * The Open Access bulk mirror settings, parsed apart from {@link ServerConfigSchema} because the
 * mirror CLI (`src/mirror/cli.ts`) reads them in a process that has no API key.
 */
const MirrorConfigSchema = z.object({
  mirrorPath: z
    .string()
    .optional()
    .describe(
      'SQLite file path of the Open Access bulk mirror, built with the mirror CLI. Empty or unset turns the mirror off.',
    ),
  refreshCron: z
    .string()
    .optional()
    .describe(
      `Cron expression (server local time) on which an HTTP server refreshes the mirror from the bucket. Unset runs ${DEFAULT_MIRROR_REFRESH_CRON}; empty turns the in-server refresh off. Checked at startup when the mirror is on.`,
    ),
});

export type MirrorConfig = z.infer<typeof MirrorConfigSchema>;

/**
 * Parse SMITHSONIAN_MIRROR_PATH and SMITHSONIAN_MIRROR_REFRESH_CRON. Not memoized, so a caller
 * that loads `.env` first and a test that stubs a variable each read the current value.
 * `refreshCron` is undefined when the in-server refresh is off.
 */
export function getMirrorConfig(): MirrorConfig {
  const config = parseEnvConfig(MirrorConfigSchema, {
    mirrorPath: 'SMITHSONIAN_MIRROR_PATH',
    refreshCron: 'SMITHSONIAN_MIRROR_REFRESH_CRON',
  });
  // parseEnvConfig reads an empty value as unset; for the cron, empty is the off switch.
  const off = process.env.SMITHSONIAN_MIRROR_REFRESH_CRON === '';
  return {
    ...config,
    refreshCron: off ? undefined : (config.refreshCron ?? DEFAULT_MIRROR_REFRESH_CRON),
  };
}
