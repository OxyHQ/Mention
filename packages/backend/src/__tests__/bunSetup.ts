/**
 * `bun test` preload — the counterpart of `setup.ts` for the files that have
 * moved to `bun test` (see `testRunnerSplit.ts`).
 *
 * `runBunTests.ts` runs with `--isolate`, so this file is evaluated once per
 * TEST FILE in a fresh global, before that file's own imports — the same window
 * `setup.ts` gets from Vitest — and `Bun.main` is that test file's path.
 *
 * What it does NOT do yet is `setup.ts`'s per-file isolated database:
 * `runBunTests.ts` refuses any file listed in `isolatedDatabaseFiles.ts` until
 * that block is ported, so such a file can never run against the shared
 * database by accident.
 */
import { mock } from 'bun:test';

/**
 * Name every Postgres connection after the test file that opened it — the
 * same diagnostic as `setup.ts`, and for the same reason. Strip-then-append is
 * kept although each file gets a fresh global: `process.env` is still shared
 * by every file in the process.
 */
const testPath = Bun.main;
if (testPath && process.env.DATABASE_URL) {
  try {
    const url = new URL(process.env.DATABASE_URL);
    url.searchParams.delete('application_name');
    url.searchParams.set('application_name', testPath.split('/').pop() ?? 'unknown.test.ts');
    process.env.DATABASE_URL = url.toString();
  } catch {
    // A url this cannot parse is one `connectPostgres` would fail on anyway.
  }
}

// The three module mocks below are `setup.ts`'s, one for one. `mock.module`
// is not hoisted, which is why they live in a preload: they are registered
// before the test file imports anything.

// --- Redis ---
mock.module('../utils/redis', () => ({
  getRedisClient: mock().mockReturnValue({
    isReady: false,
    get: mock(),
    set: mock(),
    del: mock(),
  }),
  closeRedisConnection: mock(async () => undefined),
  reportRedisConnectionFailure: mock(),
}));

// --- Logger (suppress output during tests) ---
mock.module('../utils/logger', () => ({
  logger: {
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
    fatal: mock(),
    child: mock().mockReturnThis(),
  },
}));

// --- Pino (direct imports) ---
mock.module('pino', () => ({
  default: mock(() => ({
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
    fatal: mock(),
    child: mock().mockReturnThis(),
  })),
}));
