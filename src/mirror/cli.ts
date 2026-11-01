/**
 * @fileoverview Lifecycle CLI for the Open Access bulk mirror, at the SQLite file
 * SMITHSONIAN_MIRROR_PATH names. `init` builds it, `refresh` brings it up to date with the
 * bucket (both run the same shard-by-shard pass), and `status` prints its sync state. Runs from
 * `dist/` under Bun or Node: `bun run mirror:<command>` in a checkout or the Docker image, or
 * `node dist/mirror/cli.js <command>`. Progress goes to stderr; the result prints to stdout as
 * JSON. SIGINT or SIGTERM stops the run after the current shard, and the next run resumes.
 * @module mirror/cli
 */

import { defineMirror, type MirrorLogger, type SyncMode } from '@cyanheads/mcp-ts-core/mirror';
import { getMirrorConfig } from '@/config/server-config.js';
import { createOaSync } from '@/services/smithsonian/oa-ingest.js';
import { oaMirrorStore } from '@/services/smithsonian/oa-mirror.js';

const USAGE = 'Usage: mirror <init|refresh|status>   (SMITHSONIAN_MIRROR_PATH names the store)';

type Command = SyncMode | 'status';

function isCommand(value: string | undefined): value is Command {
  return value === 'init' || value === 'refresh' || value === 'status';
}

function line(level: string, message: string, meta?: Readonly<Record<string, unknown>>): void {
  const detail = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  process.stderr.write(`${new Date().toISOString()} ${level.padEnd(7)} ${message}${detail}\n`);
}

const logger: MirrorLogger = {
  info: (message, meta) => line('info', message, meta),
  notice: (message, meta) => line('notice', message, meta),
  warning: (message, meta) => line('warning', message, meta),
  error: (message, meta) => line('error', message, meta),
};

/** Load `./.env` the way the server does: set variables win, a missing file is fine. */
function loadEnvFile(): void {
  try {
    process.loadEnvFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

async function main(command: Command): Promise<void> {
  loadEnvFile();
  const { mirrorPath } = getMirrorConfig();
  if (!mirrorPath) {
    throw new Error(
      'SMITHSONIAN_MIRROR_PATH is not set. Set it to the SQLite file the mirror lives in (the Docker image provides /var/lib/smithsonian-mcp-server/ for it) and run again.',
    );
  }
  const store = oaMirrorStore(mirrorPath);
  const mirror = defineMirror({
    name: 'smithsonian-oa',
    store,
    logger,
    sync: createOaSync(store, logger),
  });
  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals) => {
    line('notice', `Received ${signal}; stopping after the current shard.`);
    controller.abort(new Error(`Interrupted by ${signal}`));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (command !== 'status') {
      // The framework clears the stored checkpoint (the snapshot date) for the length of an
      // `init` over a completed mirror; a refresh keeps it, and runs the same pass.
      const ready = await mirror.ready();
      const mode = command === 'init' && ready ? 'refresh' : command;
      if (mode !== command) line('notice', 'The mirror is already built; running a refresh.');
      await mirror.runSync({ mode, signal: controller.signal });
    }
    const { checkpoint, ...status } = await mirror.status();
    process.stdout.write(`${JSON.stringify({ ...status, snapshot: checkpoint }, null, 2)}\n`);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await store.close();
  }
}

const command = process.argv[2];
if (isCommand(command)) {
  await main(command).catch((err: unknown) => {
    line('error', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
} else {
  process.stderr.write(`${USAGE}\n`);
  process.exitCode = 2;
}
