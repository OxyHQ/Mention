#!/usr/bin/env bun
/**
 * Runs the backend test files that have moved to `bun test`.
 *
 * Which files those are is decided by `testRunnerSplit.ts` (a file that imports
 * from `'bun:test'`), and this script passes exactly that list — `bun test`'s
 * own discovery would also pick up every Vitest file. Any extra arguments
 * (`--shard=1/3`, `--coverage`, `--reporter=junit …`) are forwarded.
 *
 * It does for `bun test` what `vitest.config.ts` + `vitest.globalSetup.ts` do
 * for Vitest, and deliberately the same way:
 *
 * - ONE throwaway, fully-migrated database per run, created before any test
 *   file starts and dropped after the last one. A reachable Postgres is a hard
 *   prerequisite, exactly as it is for Vitest.
 * - Only `TEST_DATABASE_URL` / `DATABASE_URL` are taken from `.env` files. The
 *   package script runs this with `--no-env-file`, and `bun test` is spawned
 *   with it too, because Bun otherwise loads the WHOLE `.env` — the very thing
 *   `vitest.config.ts` documents breaking 47 tests (`FEDERATION_DOMAIN` and the
 *   `*_ENABLED` gates going live). A value already in the environment wins.
 * - `PG_MAX_POOL_SIZE` defaults to 8, the value `vitest.config.ts` sets.
 * - `--isolate`: every file gets a fresh global and module registry, which is
 *   Vitest's per-file isolation, and is what keeps one file's `mock.module`
 *   from leaking into the next.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { dropTestDatabase } from '@oxy.so/db/testing';
import { needsIsolatedDatabase } from './src/__tests__/isolatedDatabaseFiles';
import { createTestDatabase } from './src/db/testDatabase';
import { splitTestFiles } from './testRunnerSplit';

const PACKAGE_ROOT = __dirname;
const POSTGRES_ENV_KEYS = ['TEST_DATABASE_URL', 'DATABASE_URL'] as const;

/** Vite's `loadEnv('test')` precedence: a later file overrides an earlier one. */
const ENV_FILES = ['.env', '.env.local', '.env.test', '.env.test.local'];

function readPostgresKeysFromEnvFiles(): Partial<
  Record<(typeof POSTGRES_ENV_KEYS)[number], string>
> {
  const found: Partial<Record<(typeof POSTGRES_ENV_KEYS)[number], string>> = {};
  for (const name of ENV_FILES) {
    const path = join(PACKAGE_ROOT, name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      const key = match[1] as (typeof POSTGRES_ENV_KEYS)[number];
      if (!POSTGRES_ENV_KEYS.includes(key)) continue;
      found[key] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return found;
}

const files = splitTestFiles().bun;
if (files.length === 0) {
  console.error('No backend test file imports from bun:test; nothing for `bun test` to run.');
  process.exit(1);
}

// `setup.ts` gives these files a private database; `bunSetup.ts` cannot yet.
// Refused rather than run, because against the shared database their jobs
// sweep other files' rows — and the damage is reported by the victim.
const needIsolation = files.filter((file) => needsIsolatedDatabase(file));
if (needIsolation.length > 0) {
  console.error(
    'These files need their own database (isolatedDatabaseFiles.ts), which bunSetup.ts does not provide yet. ' +
      `Keep them on Vitest until it does:\n  ${needIsolation.join('\n  ')}`,
  );
  process.exit(1);
}

const fileEnv = readPostgresKeysFromEnvFiles();
for (const key of POSTGRES_ENV_KEYS) {
  const value = fileEnv[key];
  if (value && !process.env[key]) process.env[key] = value;
}
process.env.PG_MAX_POOL_SIZE ??= '8';

// `bun test` does not create the JUnit report's directory: it reports
// `JUnitReportFailed … ENOENT` after the run and writes nothing, which CI would
// only notice one job later as a missing report.
const forwarded = process.argv.slice(2);
forwarded.forEach((arg, index) => {
  const outfile = arg.startsWith('--reporter-outfile=')
    ? arg.slice('--reporter-outfile='.length)
    : arg === '--reporter-outfile'
      ? forwarded[index + 1]
      : undefined;
  if (outfile) mkdirSync(dirname(resolve(PACKAGE_ROOT, outfile)), { recursive: true });
});

const databaseUrl = await createTestDatabase();
let exitCode = 1;
try {
  const child = Bun.spawn(
    [
      process.execPath,
      'test',
      '--no-env-file',
      '--isolate',
      '--preload',
      './src/__tests__/bunSetup.ts',
      ...forwarded,
      ...files.map((file) => `./${relative(PACKAGE_ROOT, file)}`),
    ],
    { cwd: PACKAGE_ROOT, env: process.env, stdio: ['inherit', 'inherit', 'inherit'] },
  );
  exitCode = await child.exited;
} finally {
  await dropTestDatabase(databaseUrl);
}
process.exit(exitCode);
