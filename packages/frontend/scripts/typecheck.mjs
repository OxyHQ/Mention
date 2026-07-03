#!/usr/bin/env node
/**
 * Frontend type-check gate (CI + local).
 *
 * Runs `tsc --noEmit` and fails on ANY frontend (app/source) type error.
 *
 * The `@syra.fm/live` package (Mention's live-rooms engine) ships a
 * `react-native` export condition pointing at its SOURCE (`src/index.ts`), so
 * — combined with the Expo base's `customConditions: ["react-native"]` — tsc
 * resolves and type-checks that source. It imports `livekit-client`, whose
 * package `exports` map omits a `react-native` condition, so tsc cannot resolve
 * livekit-client's value exports (`Participant`, `ConnectionState`) and the
 * call-arity check on the unresolved symbol fails.
 *
 * These are pre-existing, EXTERNAL (livekit-client packaging) errors that are
 * out of scope for the frontend type-check and are owned by the @syra.fm/live /
 * livekit upstream, not this app. They are allow-listed below by their exact
 * file+code signature. Every OTHER error — including any NEW @syra.fm/live error
 * that is not one of these — fails the gate.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Resolve the `tsc` binary from the nearest node_modules/.bin (frontend, then
// the hoisted monorepo root) so we never depend on a shell or global install.
function resolveTscBin() {
  const candidates = [
    resolve(frontendDir, 'node_modules/.bin/tsc'),
    resolve(frontendDir, '../../node_modules/.bin/tsc'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    console.error('Unable to locate the `tsc` binary in node_modules/.bin.');
    process.exit(1);
  }
  return found;
}

// Exact, narrowly-scoped allow-list of known-external livekit-client errors
// surfaced through @syra.fm/live source. Matched as substrings against each
// tsc diagnostic line.
const ALLOWED_EXTERNAL = [
  `../../node_modules/@syra.fm/live/src/hooks/useActiveSpeakers.ts(2,27): error TS2305: Module '"livekit-client"' has no exported member 'Participant'.`,
  `../../node_modules/@syra.fm/live/src/hooks/useRoomAudio.ts(3,34): error TS2305: Module '"livekit-client"' has no exported member 'ConnectionState'.`,
  `../../node_modules/@syra.fm/live/src/hooks/useRoomAudio.ts(49,27): error TS2554: Expected 0 arguments, but got 1.`,
];

const result = spawnSync(resolveTscBin(), ['--noEmit'], {
  cwd: frontendDir,
  encoding: 'utf8',
});

const output = `${result.stdout || ''}${result.stderr || ''}`;
const errorLines = output
  .split('\n')
  .filter((line) => /error TS\d+:/.test(line));

const unexpected = errorLines.filter(
  (line) => !ALLOWED_EXTERNAL.some((allowed) => line.includes(allowed)),
);

if (unexpected.length > 0) {
  console.error('Frontend type-check failed with the following errors:\n');
  console.error(unexpected.join('\n'));
  console.error(`\n${unexpected.length} unexpected type error(s).`);
  process.exit(1);
}

const allowedSeen = errorLines.length - unexpected.length;
if (allowedSeen > 0) {
  console.log(
    `Frontend type-check passed (${allowedSeen} allow-listed external livekit-client error(s) ignored).`,
  );
} else {
  console.log('Frontend type-check passed with 0 errors.');
}
