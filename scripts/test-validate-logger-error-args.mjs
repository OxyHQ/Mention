#!/usr/bin/env bun

/**
 * Mutation-tests `validate-logger-error-args.mjs`.
 *
 * A validator that passes on a clean tree proves nothing on its own — it would
 * also pass if its traversal found no files, if its import matcher were broken,
 * or if it never looked at arguments at all. Each case below breaks exactly one
 * thing and requires the validator to fail, and to fail for the right reason.
 *
 * The `backendForm` case is the one that matters most: it pins the SCOPE. The
 * backend's pino wrapper takes a context object as its second argument
 * deliberately, so a version of this check that fired there would be wrong, and
 * would be turned off by the first person it inconvenienced.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = resolve(repositoryRoot, "scripts/validate-logger-error-args.mjs");

/** Run the validator against a scratch checkout, returning its outcome. */
async function runAgainst(files) {
  const root = await mkdtemp(join(tmpdir(), "logger-validator-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents);
    }

    // Run the REAL validator from this repo (so it resolves `typescript`),
    // pointed at the scratch tree.
    const proc = Bun.spawnSync({
      cmd: ["bun", validator],
      cwd: repositoryRoot,
      env: { ...process.env, LOGGER_VALIDATOR_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: proc.exitCode,
      output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Enough clean files to clear both vacuity floors. */
function filler() {
  const files = {};
  for (let index = 0; index < 460; index += 1) {
    const usesLogger = index < 40;
    files[`packages/frontend/generated/file-${index}.ts`] = usesLogger
      ? `import { logger } from '@oxyhq/core/logger';\n`
        + `export function run(error: unknown) { logger.error('failed', error); }\n`
      : `export const value${index} = ${index};\n`;
  }
  return files;
}

const cases = [
  {
    name: "clean tree passes",
    files: filler(),
    expectFailure: false,
  },
  {
    name: "an object-literal second argument is rejected",
    files: {
      ...filler(),
      "packages/frontend/offender.ts":
        `import { logger } from '@oxyhq/core/logger';\n`
        + `export function run(error: unknown) { logger.error('failed', { error }); }\n`,
    },
    expectFailure: true,
    expectOutput: "takes the error SECOND",
  },
  {
    name: "a logger from createLogger is checked too",
    files: {
      ...filler(),
      "packages/frontend/offender.ts":
        `import { createLogger } from '@oxyhq/core/logger';\n`
        + `const log = createLogger('Scope');\n`
        + `export function run(error: unknown) { log.error('failed', { error }); }\n`,
    },
    expectFailure: true,
    expectOutput: "takes the error SECOND",
  },
  {
    name: "a child logger is checked too",
    files: {
      ...filler(),
      "packages/frontend/offender.ts":
        `import { logger } from '@oxyhq/core/logger';\n`
        + `const child = logger.child('Scope');\n`
        + `export function run(error: unknown) { child.error('failed', { error }); }\n`,
    },
    expectFailure: true,
    expectOutput: "takes the error SECOND",
  },
  {
    name: "the backend's pino form is NOT rejected (this is the scope)",
    files: {
      ...filler(),
      "packages/backend/src/routes/mute.routes.ts":
        `import { logger } from '../utils/logger';\n`
        + `export function run(error: unknown, userId: string) {\n`
        + `  logger.error('Error muting user:', { userId, error });\n`
        + `}\n`,
    },
    expectFailure: false,
  },
  {
    name: "debug/info/warn with a context object are NOT rejected",
    files: {
      ...filler(),
      "packages/frontend/contextual.ts":
        `import { logger } from '@oxyhq/core/logger';\n`
        + `export function run(error: unknown) {\n`
        + `  logger.debug('rollback did not apply', { error });\n`
        + `  logger.warn('degraded', { error });\n`
        + `  logger.info('note', { error });\n`
        + `}\n`,
    },
    expectFailure: false,
  },
  {
    name: "a third-argument context object is NOT rejected",
    files: {
      ...filler(),
      "packages/frontend/contextual.ts":
        `import { logger } from '@oxyhq/core/logger';\n`
        + `export function run(error: unknown, postId: string) {\n`
        + `  logger.error('failed', error, { postId });\n`
        + `}\n`,
    },
    expectFailure: false,
  },
  {
    name: "a broken traversal cannot pass silently (scanned-file floor)",
    files: {
      "packages/frontend/only.ts":
        `import { logger } from '@oxyhq/core/logger';\n`
        + `export function run(error: unknown) { logger.error('failed', error); }\n`,
    },
    expectFailure: true,
    expectOutput: "below the 400 floor",
  },
  {
    name: "a broken import matcher cannot pass silently (logger-file floor)",
    files: (() => {
      const files = {};
      for (let index = 0; index < 460; index += 1) {
        files[`packages/frontend/generated/file-${index}.ts`] = `export const value${index} = ${index};\n`;
      }
      return files;
    })(),
    expectFailure: true,
    expectOutput: "below the 20 floor",
  },
];

let failed = 0;
for (const testCase of cases) {
  const { exitCode, output } = await runAgainst(testCase.files);
  const didFail = exitCode !== 0;

  if (didFail !== testCase.expectFailure) {
    console.error(
      `FAIL ${testCase.name}: expected ${testCase.expectFailure ? "a failure" : "a pass"}, `
      + `got exit ${exitCode}\n${output}`,
    );
    failed += 1;
    continue;
  }
  if (testCase.expectOutput && !output.includes(testCase.expectOutput)) {
    console.error(
      `FAIL ${testCase.name}: failed as expected, but the message never said `
      + `"${testCase.expectOutput}"\n${output}`,
    );
    failed += 1;
    continue;
  }
  console.log(`ok   ${testCase.name}`);
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length} validator cases failed.`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} validator cases passed.`);
