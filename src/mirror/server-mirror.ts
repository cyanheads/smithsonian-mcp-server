/**
 * @fileoverview The Open Access bulk mirror as the running server holds it. Startup checks the
 * refresh cron and opens the store, so an invalid schedule, a missing SQLite driver, or an
 * unreadable file fails startup rather than the first read. On the HTTP transport a cron job
 * refreshes the store by running the mirror CLI in a child process: a refresh commits one
 * transaction per changed shard, and running those off the serving thread keeps every request,
 * `/healthz` included, from stalling behind them.
 * @module mirror/server-mirror
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { configurationError, JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { MirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import {
  logger,
  type RequestContext,
  requestContextService,
  schedulerService,
  withExtra,
} from '@cyanheads/mcp-ts-core/utils';
import { OaMirror, oaMirrorStore } from '@/services/smithsonian/oa-mirror.js';

/** The scheduler job that refreshes the mirror. */
export const MIRROR_REFRESH_JOB = 'smithsonian-oa-mirror-refresh';

/**
 * Exit status of a mirror CLI run that synced nothing because another process holds the store's
 * sync lease (a `mirror:init` or `mirror:refresh` an operator started, or another instance's
 * refresh): sysexits `EX_TEMPFAIL`. The refresh job reads it as a skipped tick, not a failure.
 */
export const SYNC_LOCKED_EXIT_CODE = 75;

/** How long a refresh child has to exit after SIGTERM before it is killed. */
const STOP_GRACE_MS = 5_000;

export interface ServerMirrorOptions {
  /** The compiled mirror CLI each scheduled refresh runs (`dist/mirror/cli.js`). */
  cliPath: string;
  /** The SQLite file of the mirror. */
  path: string;
  /** Cron expression for the in-server refresh; undefined turns it off. */
  refreshCron: string | undefined;
  transport: 'http' | 'stdio';
}

/** A mirror the server has opened. */
export interface ServerMirror {
  /** Read access for the service. */
  readonly reader: OaMirror;
  /** Stop the refresh schedule, end a refresh in progress, and close the store. */
  stop(): Promise<void>;
}

/**
 * Open the mirror at `options.path` and, on the HTTP transport, schedule its refresh. A store
 * with no completed build is opened (created when absent) and logged as a warning: reads go to
 * the live API until `mirror:init` finishes, and a scheduled refresh never starts that build.
 *
 * Opening a store built under an older schema migrates it, which leaves every shard to be
 * re-read ({@link OaMirror.hasStaleShards}). A scheduled refresh then starts at once rather than
 * at its next tick; without one, startup logs a notice naming `mirror:refresh`.
 *
 * @throws McpError `ConfigurationError` when the refresh cron is not a valid expression, when
 *   the SQLite driver is missing, or when the file cannot be opened as a SQLite store.
 */
export async function startServerMirror(options: ServerMirrorOptions): Promise<ServerMirror> {
  if (options.refreshCron !== undefined) await assertValidCron(options.refreshCron);
  const store = oaMirrorStore(options.path);
  // Opening now, rather than on the first read, makes an unusable store a startup failure.
  await openStore(store, options.path);
  const reader = new OaMirror(store);
  const context = requestContextService.createRequestContext({ operation: 'startServerMirror' });
  if (!(await reader.ready())) {
    logger.warning(
      `The mirror at SMITHSONIAN_MIRROR_PATH "${options.path}" holds no completed build, so every read goes to the live API. Build it with \`mirror:init\`.`,
      context,
    );
  }
  const stale = await reader.hasStaleShards();
  const refresh =
    options.transport === 'http' && options.refreshCron !== undefined
      ? await scheduleRefresh(options.refreshCron, options.cliPath, options.path, stale)
      : undefined;
  if (stale) {
    const subject = `The mirror at SMITHSONIAN_MIRROR_PATH "${options.path}" has shards to re-read after a schema upgrade`;
    const effect =
      'Until each is re-read, its records and every on_view search are answered from the live API.';
    logger.notice(
      refresh
        ? `${subject}; refreshing it now rather than at the next scheduled run. ${effect}`
        : `${subject}. ${effect} This server schedules no refresh: run \`mirror:refresh\`.`,
      context,
    );
  }
  return {
    reader,
    async stop() {
      await refresh?.stop();
      await store.close();
    },
  };
}

/**
 * Open the store's connection. The store's own open failure names the file for a tool caller;
 * at startup the reader is the operator, so it becomes a `ConfigurationError` naming the
 * variable. A missing SQLite driver is already a `ConfigurationError` with its install hint.
 */
async function openStore(store: MirrorStore, path: string): Promise<void> {
  try {
    await store.raw();
  } catch (err) {
    if (err instanceof McpError && err.code === JsonRpcErrorCode.ConfigurationError) throw err;
    throw configurationError(
      `SMITHSONIAN_MIRROR_PATH "${path}" could not be opened as a SQLite mirror store. Point it at the file \`mirror:init\` builds, or set it empty to turn the mirror off.`,
      undefined,
      { cause: err },
    );
  }
}

async function assertValidCron(expression: string): Promise<void> {
  const { validate } = await import('node-cron');
  if (validate(expression)) return;
  throw configurationError(
    `SMITHSONIAN_MIRROR_REFRESH_CRON "${expression}" is not a valid cron expression. Use five or six cron fields (e.g. "0 12 * * *"), or set it empty to turn the in-server refresh off.`,
  );
}

/** A refresh child the job started, and the promise its exit settles. */
interface RunningRefresh {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Register and start the refresh job. Each tick runs `mirror/cli.js refresh` in a child process
 * under the runtime and flags the server runs under; the scheduler skips a tick while the
 * previous run is still going, and a child that exits {@link SYNC_LOCKED_EXIT_CODE} skips its
 * tick because a sync in another process holds the store. `runNow` also runs the job once at
 * once, through the scheduler so a tick during it is skipped like any other.
 */
async function scheduleRefresh(
  cron: string,
  cliPath: string,
  path: string,
  runNow: boolean,
): Promise<{ stop(): Promise<void> }> {
  let running: RunningRefresh | undefined;
  let stopping = false;

  const run = async (context: RequestContext): Promise<void> => {
    // A run the scheduler started as shutdown began would outlive stop().
    if (stopping) return;
    const child = spawn(process.execPath, [...process.execArgv, cliPath, 'refresh'], {
      env: { ...process.env, SMITHSONIAN_MIRROR_PATH: path },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      },
    );
    running = { child, exited };
    // The CLI writes progress to stderr and its final status as JSON to stdout.
    createInterface({ input: child.stderr }).on('line', (line) => {
      logger.info(`Mirror refresh: ${line}`, context);
    });
    let status = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      status += chunk;
    });
    try {
      const { code, signal } = await exited;
      if (stopping) {
        logger.notice('Mirror refresh stopped for server shutdown.', context);
        return;
      }
      if (code === SYNC_LOCKED_EXIT_CODE) {
        logger.notice('Mirror refresh skipped: another sync of the store is in progress.', context);
        return;
      }
      if (code !== 0) {
        throw new Error(
          `The mirror refresh child exited with ${signal ? `signal ${signal}` : `code ${code}`}.`,
        );
      }
      logger.info('Mirror refresh complete.', withExtra(context, { status: status.trim() }));
    } finally {
      running = undefined;
    }
  };

  const job = await schedulerService.schedule(
    MIRROR_REFRESH_JOB,
    cron,
    run,
    'Refresh the Open Access mirror from the smithsonian-open-access bucket',
  );
  schedulerService.start(MIRROR_REFRESH_JOB);
  let immediate: Promise<unknown> | undefined;
  if (runNow) {
    // The scheduler's wrapper logs a failed run rather than rejecting; stop() awaits the run.
    immediate = job.task.execute();
  }

  return {
    async stop() {
      stopping = true;
      schedulerService.remove(MIRROR_REFRESH_JOB);
      if (running) await terminate(running);
      await immediate;
    },
  };
}

/** SIGTERM the child, then SIGKILL it if it has not exited within {@link STOP_GRACE_MS}. */
async function terminate({ child, exited }: RunningRefresh): Promise<void> {
  child.kill('SIGTERM');
  const kill = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
  try {
    await exited;
  } finally {
    clearTimeout(kill);
  }
}
