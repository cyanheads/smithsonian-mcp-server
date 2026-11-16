/**
 * @fileoverview Tests for the mirror as the running server holds it: startup checks (cron, store),
 * the HTTP-only refresh job, the refresh child it spawns, and `stop()`. Stores are real SQLite
 * files; the refresh child runs `fixtures/fake-mirror-cli.mjs` in place of the mirror CLI.
 * @module tests/mirror/server-mirror.test
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { MirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import { logger, schedulerService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { getMirrorConfig } from '@/config/server-config.js';
import {
  MIRROR_REFRESH_JOB,
  type ServerMirrorOptions,
  startServerMirror,
} from '@/mirror/server-mirror.js';

/** Every store `startServerMirror` opens, so a test can reach its connection and close it. */
const stores = vi.hoisted((): MirrorStore[] => []);

vi.mock('@/services/smithsonian/oa-mirror.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/smithsonian/oa-mirror.js')>();
  return {
    ...actual,
    oaMirrorStore(path: string): MirrorStore {
      const store = actual.oaMirrorStore(path);
      stores.push(store);
      return store;
    },
  };
});

const CLI = fileURLToPath(new URL('./fixtures/fake-mirror-cli.mjs', import.meta.url));
const CRON = '0 12 * * *';

/** What the fake CLI wrote about itself. */
interface ChildRecord {
  argv: string[];
  bun?: string;
  execArgv: string[];
  execPath: string;
  mirrorPath?: string;
  pid: number;
  signals: string[];
}

let dir: string;
let path: string;
let recordPath: string;
/** Every message logged at `info`, in order. */
let infoLines: string[];
let waiting: Map<string, () => void>;
let info: MockInstance<typeof logger.info>;
let notice: MockInstance<typeof logger.notice>;
let warning: MockInstance<typeof logger.warning>;
let error: MockInstance<typeof logger.error>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'server-mirror-test-'));
  path = join(dir, 'oa.db');
  recordPath = join(dir, 'child.json');
  vi.stubEnv('FAKE_MIRROR_CLI_RECORD', recordPath);
  infoLines = [];
  waiting = new Map();
  info = vi.spyOn(logger, 'info').mockImplementation((message) => {
    infoLines.push(message);
    waiting.get(message)?.();
  });
  notice = vi.spyOn(logger, 'notice').mockImplementation(() => {});
  warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});
  error = vi.spyOn(logger, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.useRealTimers();
  for (const job of schedulerService.listJobs()) schedulerService.remove(job.id);
  await Promise.all(stores.splice(0).map((store) => store.close()));
  if (existsSync(recordPath)) {
    const { pid } = readRecord();
    if (alive(pid)) process.kill(pid, 'SIGKILL');
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function start(options: Partial<ServerMirrorOptions> = {}) {
  return startServerMirror({
    path,
    refreshCron: CRON,
    transport: 'http',
    cliPath: CLI,
    ...options,
  });
}

function refreshJob() {
  const job = schedulerService.listJobs().find((j) => j.id === MIRROR_REFRESH_JOB);
  if (!job) throw new Error('The refresh job is not scheduled.');
  return job;
}

function onlyStore(): MirrorStore {
  expect(stores).toHaveLength(1);
  return stores[0] as MirrorStore;
}

function readRecord(): ChildRecord {
  return JSON.parse(readFileSync(recordPath, 'utf8')) as ChildRecord;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw err;
  }
}

/** Resolves once `message` has been logged at `info`. */
function logged(message: string): Promise<void> {
  if (infoLines.includes(message)) return Promise.resolve();
  return new Promise((resolve) => waiting.set(message, resolve));
}

/** Resolves once the server has relayed the refresh child's stderr `line` at `info`. */
function relayed(line: string): Promise<void> {
  return logged(`Mirror refresh: ${line}`);
}

/**
 * Build a completed store at `path` holding one shard applied at `etag`. A null ETag is a shard
 * awaiting its re-read, as opening a version-1 store under version 2 leaves every shard.
 */
async function seedStore(etag: string | null): Promise<void> {
  const { oaMirrorStore } = await import('@/services/smithsonian/oa-mirror.js');
  const seeded = oaMirrorStore(path);
  (await seeded.raw())
    .prepare('INSERT INTO shards(key, etag) VALUES (?, ?)')
    .run('metadata/edan/aaa/00.txt', etag);
  await seeded.writeState({ status: 'complete', completedAt: '2026-10-26T07:25:06.000Z' });
  await seeded.close();
  stores.splice(0);
}

const STARTING = `Starting job '${MIRROR_REFRESH_JOB}'...`;

describe('startServerMirror', () => {
  it('schedules the refresh on HTTP; a run spawns the CLI under the server runtime with the mirror path', async () => {
    vi.stubEnv('FAKE_MIRROR_CLI_MODE', 'exit');
    // The server's own value must not reach the child: the job names the store it opened.
    vi.stubEnv('SMITHSONIAN_MIRROR_PATH', join(dir, 'other.db'));
    const mirror = await start();

    expect(schedulerService.listJobs().map(({ id, schedule }) => ({ id, schedule }))).toEqual([
      { id: MIRROR_REFRESH_JOB, schedule: CRON },
    ]);

    // Resolves once the run has finished, which waits on the child's exit.
    await refreshJob().task.execute();
    const child = readRecord();
    expect(child.execPath).toBe(process.execPath);
    expect(child.bun).toBe(process.versions.bun);
    expect(child.execArgv).toEqual(process.execArgv);
    expect(child.argv.slice(1)).toEqual([CLI, 'refresh']);
    expect(child.mirrorPath).toBe(path);
    expect(alive(child.pid)).toBe(false);
    expect(infoLines).toContain('Mirror refresh: ready');
    expect(info).toHaveBeenCalledWith(
      'Mirror refresh complete.',
      expect.objectContaining({ extra: expect.objectContaining({ status: '{"shards":0}' }) }),
    );
    expect(error).not.toHaveBeenCalled();

    await mirror.stop();
  });

  it('reports a refresh child that exits non-zero as a failed run', async () => {
    vi.stubEnv('FAKE_MIRROR_CLI_MODE', 'fail');
    const mirror = await start();
    const job = refreshJob();

    await job.task.execute();

    expect(error).toHaveBeenCalledWith(
      `Job '${MIRROR_REFRESH_JOB}' failed.`,
      expect.objectContaining({ message: 'The mirror refresh child exited with code 3.' }),
      expect.anything(),
    );
    expect(infoLines).not.toContain('Mirror refresh complete.');
    expect(job.isRunning).toBe(false);

    await mirror.stop();
  });

  it('skips a tick whose refresh child found another sync holding the store, logging no failure', async () => {
    vi.stubEnv('FAKE_MIRROR_CLI_MODE', 'locked');
    const mirror = await start();
    const job = refreshJob();

    await job.task.execute();

    expect(readRecord().argv.slice(2)).toEqual(['refresh']);
    expect(notice).toHaveBeenCalledWith(
      'Mirror refresh skipped: another sync of the store is in progress.',
      expect.anything(),
    );
    expect(error).not.toHaveBeenCalled();
    expect(infoLines).not.toContain('Mirror refresh complete.');
    expect(job.isRunning).toBe(false);

    await mirror.stop();
  });

  it('schedules nothing on stdio', async () => {
    const mirror = await start({ transport: 'stdio' });

    expect(schedulerService.listJobs()).toEqual([]);
    expect(existsSync(path)).toBe(true);

    await expect(mirror.stop()).resolves.toBeUndefined();
  });

  it('schedules nothing when SMITHSONIAN_MIRROR_REFRESH_CRON is set empty', async () => {
    vi.stubEnv('SMITHSONIAN_MIRROR_REFRESH_CRON', '');
    const mirror = await start({ refreshCron: getMirrorConfig().refreshCron });

    expect(schedulerService.listJobs()).toEqual([]);

    await mirror.stop();
  });

  it.each(['http', 'stdio'] as const)(
    'rejects an invalid cron with ConfigurationError on %s, before creating the store',
    async (transport) => {
      await expect(start({ transport, refreshCron: '61 * * * *' })).rejects.toMatchObject({
        code: JsonRpcErrorCode.ConfigurationError,
        message: expect.stringContaining('"61 * * * *"'),
      });

      expect(schedulerService.listJobs()).toEqual([]);
      expect(existsSync(path)).toBe(false);
    },
  );

  it('rejects a file that is not a SQLite database as ConfigurationError naming the variable, leaving no job scheduled', async () => {
    writeFileSync(path, 'not a SQLite database\n'.repeat(100));

    const err = await start().catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message: expect.stringContaining(`SMITHSONIAN_MIRROR_PATH "${path}"`),
      cause: expect.objectContaining({ code: JsonRpcErrorCode.DatabaseError }),
    });
    expect(schedulerService.listJobs()).toEqual([]);
  });

  it('warns once at startup when the store holds no completed build', async () => {
    const mirror = await start({ transport: 'stdio' });

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      expect.stringMatching(/SMITHSONIAN_MIRROR_PATH ".*oa\.db".*live API.*mirror:init/),
      expect.anything(),
    );

    await mirror.stop();
  });

  it('starts without a warning on a store a sync has completed', async () => {
    const { oaMirrorStore } = await import('@/services/smithsonian/oa-mirror.js');
    const built = oaMirrorStore(path);
    await built.writeState({ status: 'complete', completedAt: '2026-10-26T07:25:06.000Z' });
    await built.close();
    stores.splice(0);

    const mirror = await start({ transport: 'stdio' });

    expect(warning).not.toHaveBeenCalled();

    await mirror.stop();
  });
});

describe('ServerMirror.stop', () => {
  it('SIGTERMs a running refresh child, removes the job, closes the store, and resolves after the child exits', async () => {
    vi.stubEnv('FAKE_MIRROR_CLI_MODE', 'wait');
    const mirror = await start();
    const handle = await onlyStore().raw();
    const run = refreshJob().task.execute();
    await relayed('ready');
    const { pid } = readRecord();
    expect(alive(pid)).toBe(true);

    await mirror.stop();

    expect(readRecord().signals).toEqual(['SIGTERM']);
    expect(alive(pid)).toBe(false);
    expect(schedulerService.listJobs()).toEqual([]);
    expect(() => handle.prepare('SELECT 1').get()).toThrow();
    await run;
    expect(notice).toHaveBeenCalledWith(
      'Mirror refresh stopped for server shutdown.',
      expect.anything(),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it('kills a refresh child still running when the SIGTERM grace period ends', async () => {
    vi.stubEnv('FAKE_MIRROR_CLI_MODE', 'ignore-term');
    const mirror = await start();
    const run = refreshJob().task.execute();
    await relayed('ready');
    const { pid } = readRecord();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true });

    const stopped = mirror.stop();
    await relayed('term ignored');
    expect(alive(pid)).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    await stopped;

    expect(readRecord().signals).toEqual(['SIGTERM']);
    expect(alive(pid)).toBe(false);
    await run;
    expect(notice).toHaveBeenCalledWith(
      'Mirror refresh stopped for server shutdown.',
      expect.anything(),
    );
  });

  it('resolves with no refresh child running, removing the job and closing the store', async () => {
    const mirror = await start();
    const handle = await onlyStore().raw();

    await expect(mirror.stop()).resolves.toBeUndefined();

    expect(schedulerService.listJobs()).toEqual([]);
    expect(() => handle.prepare('SELECT 1').get()).toThrow();
    expect(notice).not.toHaveBeenCalled();
  });

  it('spawns no refresh child for a run the scheduler starts once stop() has begun', async () => {
    vi.stubEnv('FAKE_MIRROR_CLI_MODE', 'exit');
    const mirror = await start();
    const job = refreshJob();
    let stopped: Promise<void> | undefined;
    // The scheduler logs this just before it calls the job, so stop() begins between the two.
    waiting.set(STARTING, () => {
      stopped = mirror.stop();
    });

    await job.task.execute();
    await stopped;

    expect(stopped).toBeDefined();
    expect(existsSync(recordPath)).toBe(false);
    expect(schedulerService.listJobs()).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });
});

describe('a store with shards to re-read after a schema upgrade (issue #74)', () => {
  it('starts the scheduled refresh at startup on HTTP, without waiting for a tick', async () => {
    vi.stubEnv('FAKE_MIRROR_CLI_MODE', 'exit');
    await seedStore(null);
    const complete = logged('Mirror refresh complete.');

    const mirror = await start();
    await complete;

    const child = readRecord();
    expect(child.argv.slice(1)).toEqual([CLI, 'refresh']);
    expect(child.mirrorPath).toBe(path);
    expect(infoLines).toContain(STARTING);
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith(
      expect.stringMatching(
        /SMITHSONIAN_MIRROR_PATH ".*oa\.db" has shards to re-read after a schema upgrade; refreshing it now/,
      ),
      expect.anything(),
    );
    expect(schedulerService.listJobs().map(({ schedule }) => schedule)).toEqual([CRON]);
    expect(warning).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    await mirror.stop();
  });

  it('runs that refresh as the job: a tick during it is skipped, and stop() ends it and awaits it', async () => {
    vi.stubEnv('FAKE_MIRROR_CLI_MODE', 'wait');
    await seedStore(null);
    const ready = relayed('ready');
    const mirror = await start();
    await ready;
    const job = refreshJob();
    const { pid } = readRecord();
    expect(job.isRunning).toBe(true);

    await job.task.execute();

    expect(warning).toHaveBeenCalledWith(
      `Job '${MIRROR_REFRESH_JOB}' is already running. Skipping this execution.`,
      expect.anything(),
    );
    expect(readRecord().pid).toBe(pid);

    await mirror.stop();

    expect(readRecord().signals).toEqual(['SIGTERM']);
    expect(alive(pid)).toBe(false);
    expect(notice).toHaveBeenCalledWith(
      'Mirror refresh stopped for server shutdown.',
      expect.anything(),
    );
    expect(infoLines).toContain(`Job '${MIRROR_REFRESH_JOB}' completed successfully.`);
    expect(job.isRunning).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });

  it('runs nothing at startup on a store with every shard current; only the cron starts a refresh', async () => {
    vi.stubEnv('FAKE_MIRROR_CLI_MODE', 'exit');
    await seedStore('0123456789abcdef0123456789abcdef');

    const mirror = await start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(refreshJob().isRunning).toBe(false);
    expect(infoLines).not.toContain(STARTING);
    expect(existsSync(recordPath)).toBe(false);
    expect(notice).not.toHaveBeenCalled();

    await mirror.stop();
  });

  it.each([
    ['on stdio', { transport: 'stdio' }],
    ['on HTTP with the refresh turned off', { refreshCron: undefined }],
  ] as const)('logs one notice naming mirror:refresh %s, and runs nothing', async (_, options) => {
    await seedStore(null);

    const mirror = await start(options);
    await new Promise((resolve) => setImmediate(resolve));

    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith(
      expect.stringMatching(
        /SMITHSONIAN_MIRROR_PATH ".*oa\.db" has shards to re-read after a schema upgrade\. Until each is re-read, its records and every on_view search are answered from the live API\. This server schedules no refresh: run `mirror:refresh`\./,
      ),
      expect.anything(),
    );
    expect(schedulerService.listJobs()).toEqual([]);
    expect(existsSync(recordPath)).toBe(false);

    await mirror.stop();
  });

  it('logs no upgrade notice on stdio when every shard is current', async () => {
    await seedStore('0123456789abcdef0123456789abcdef');

    const mirror = await start({ transport: 'stdio' });

    expect(notice).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();

    await mirror.stop();
  });
});
