/**
 * @fileoverview Stand-in for `dist/mirror/cli.js` that the refresh job spawns in tests. Writes what
 * it was started with (pid, runtime, argv, execArgv, `SMITHSONIAN_MIRROR_PATH`, signals received)
 * as JSON to the file `FAKE_MIRROR_CLI_RECORD` names, then `ready` to stderr, then acts on
 * `FAKE_MIRROR_CLI_MODE`:
 *
 * | Mode | Behavior |
 * |:--|:--|
 * | `exit` | writes a status line to stdout and exits 0 |
 * | `fail` | exits 3 |
 * | `wait` | runs until SIGTERM, then exits 0 |
 * | `ignore-term` | records SIGTERM, writes `term ignored` to stderr, and keeps running |
 *
 * `wait` and `ignore-term` exit on their own after 30 s, so a failed test leaves no process behind.
 * @module tests/mirror/fixtures/fake-mirror-cli
 */

import { writeFileSync } from 'node:fs';

const mode = process.env.FAKE_MIRROR_CLI_MODE;
const recordPath = process.env.FAKE_MIRROR_CLI_RECORD;
const record = {
  pid: process.pid,
  execPath: process.execPath,
  bun: process.versions.bun,
  argv: process.argv,
  execArgv: process.execArgv,
  mirrorPath: process.env.SMITHSONIAN_MIRROR_PATH,
  signals: [],
};
const save = () => writeFileSync(recordPath, JSON.stringify(record));

process.on('SIGTERM', () => {
  record.signals.push('SIGTERM');
  save();
  if (mode === 'ignore-term') process.stderr.write('term ignored\n');
  else process.exit(0);
});
save();
process.stderr.write('ready\n');

if (mode === 'exit') {
  process.stdout.write('{"shards":0}\n');
} else if (mode === 'fail') {
  process.exitCode = 3;
} else {
  setTimeout(() => process.exit(2), 30_000);
}
