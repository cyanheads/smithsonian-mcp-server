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
 * @throws McpError `ConfigurationError` when the refresh cron is not a valid expression, when
 *   the SQLite driver is missing, or when the file cannot be opened as a SQLite store.
 */
export async function startServerMirror(options: ServerMirrorOptions): Promise<ServerMirror> {
  if (options.refreshCron !== undefined) await assertValidCron(options.refreshCron);
  const store = oaMirrorStore(options.path);
  // Opening now, rather than on the first read, makes an unusable store a startup failure.
  await openStore(store, options.path);
  const reader = new OaMirror(store);
  if (!(await reader.ready())) {
    logger.warning(
      `The mirror at SMITHSONIAN_MIRROR_PATH "${options.path}" holds no completed build, so every read goes to the live API. Build it with \`mirror:init\`.`,
      requestContextService.createRequestContext({ operation: 'startServerMirror' }),
    );
  }
  const refresh =
    options.transport === 'http' && options.refreshCron !== undefined
      ? await scheduleRefresh(options.refreshCron, options.cliPath, options.path)
      : undefined;
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
 * previous run is still going.
 */
async function scheduleRefresh(
  cron: string,
  cliPath: string,
  path: string,
): Promise<{ stop(): Promise<void> }> {
  let running: RunningRefresh | undefined;
  let stopping = false;

  const run = async (context: RequestContext): Promise<void> => {
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

  await schedulerService.schedule(
    MIRROR_REFRESH_JOB,
    cron,
    run,
    'Refresh the Open Access mirror from the smithsonian-open-access bucket',
  );
  schedulerService.start(MIRROR_REFRESH_JOB);

  return {
    async stop() {
      stopping = true;
      schedulerService.remove(MIRROR_REFRESH_JOB);
      if (running) await terminate(running);
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
