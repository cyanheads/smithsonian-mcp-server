/**
 * @fileoverview Tests for the mirror CLI's exit status. The CLI runs its command when imported, so
 * each test sets `process.argv` and imports a fresh copy against a real SQLite store; the import
 * resolves once the command has finished. Neither run reaches the bucket: a refresh of an unbuilt
 * store fails before any request, and a refused lease stops the run before its sync starts.
 * @module tests/mirror/cli.test
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { oaMirrorStore } from '@/services/smithsonian/oa-mirror.js';

let dir: string;
let path: string;
let argv: string[];
let exitCode: typeof process.exitCode;
let stderr: string[];
let held: MirrorStore | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mirror-cli-test-'));
  path = join(dir, 'oa.db');
  vi.stubEnv('SMITHSONIAN_MIRROR_PATH', path);
  argv = process.argv;
  exitCode = process.exitCode;
  stderr = [];
  // The checkout's own .env must not reach the test process.
  vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  process.argv = argv;
  process.exitCode = exitCode;
  await held?.close();
  held = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** Run `mirror <command>` to completion and return the exit status it set. */
async function runCli(command: string): Promise<typeof process.exitCode> {
  process.argv = [...argv.slice(0, 2), command];
  process.exitCode = undefined;
  vi.resetModules();
  await import('@/mirror/cli.js');
  return process.exitCode;
}

describe('mirror CLI exit status', () => {
  it('exits 1 with the error on stderr when a refresh fails', async () => {
    const status = await runCli('refresh');

    expect(status).toBe(1);
    expect(stderr.join('')).toMatch(/error\s+The mirror holds no shards/);
  });

  it('exits 75 with a notice when another sync holds the store, and syncs nothing', async () => {
    held = oaMirrorStore(path);
    const lease = await held.syncLease?.claim('another-process', 60_000);
    expect(lease).toBeDefined();

    const status = await runCli('refresh');

    expect(status).toBe(75);
    expect(stderr.join('')).toMatch(/notice\s+Mirror sync is already in progress/);
    expect(stderr.join('')).not.toMatch(/\berror\b/);
    // No run state was written: the refused run never started.
    expect((await held.readState()).status).toBe('pending');
  });
});
