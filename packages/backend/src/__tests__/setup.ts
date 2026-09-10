/**
 * Global test setup for the backend package.
 *
 * Mocks heavy external dependencies so unit tests run fast without
 * requiring a live Redis or Oxy API connection.
 *
 * Also gives the handful of files listed in `isolatedDatabaseFiles.ts` their own
 * throwaway Postgres — see the block below, which must stay FIRST in this file.
 */
import { afterAll, beforeAll, expect, vi } from 'vitest';
import { dropTestDatabase } from '@oxy.so/db/testing';
import { createTestDatabase } from '../db/testDatabase';
import { needsIsolatedDatabase } from './isolatedDatabaseFiles';

/**
 * How long the per-file teardown below may take to drop its throwaway database.
 *
 * Sized from what that teardown actually does rather than left at vitest's 10s
 * default — see the hook's own comment for the arithmetic and for the run this
 * was measured on.
 */
const DROP_DATABASE_TIMEOUT_MS = 60_000;

/**
 * Per-file database isolation for the job-invoking test files.
 *
 * A setup file is evaluated once per TEST FILE, inside the worker, before that
 * file's own imports — which is the only window in which this can work.
 * `src/config/index.ts` snapshots `process.env` at MODULE scope
 * (`const environment = parseRuntimeEnvironment(process.env)`), and
 * `connectPostgres()` reads `config.postgres.url` from that snapshot, so
 * `DATABASE_URL` has to be rewritten before anything at all imports `src/config`.
 *
 * That is also why the import above is `../db/testDatabase` specifically: it
 * pulls in `node:crypto`, `node:child_process`, `node:path` and `postgres`, and
 * nothing else. Reaching the same helper through any module that transitively
 * imports `src/config` would freeze the SHARED url into the snapshot and leave
 * the isolated database created, paid for, and never used — with every test
 * still passing.
 *
 * Vitest SUPPRESSES stdout written from a setup file, so nothing here can be
 * debugged with a `console.log`; probe to a file instead. (Measured: a
 * `console.log` at the top of this file produces zero lines in the reporter's
 * output while the same statement's side effects are observable.)
 *
 * A THROW at this level would take down all ~490 files rather than one, so a
 * failure is captured and re-raised from a `beforeAll` — every test in the
 * affected file then fails loudly with the real cause, and no test runs against
 * the wrong database.
 */
const { testPath } = expect.getState();
if (testPath && needsIsolatedDatabase(testPath)) {
  /**
   * The run-wide database from `vitest.globalSetup.ts`. Restored on teardown
   * because `process.env` is process-global and a worker is reused across test
   * files: leaving a dropped database's url behind would break whichever file
   * this worker picks up next.
   */
  const sharedDatabaseUrl = process.env.DATABASE_URL;
  let isolatedDatabaseUrl: string | undefined;
  let setupError: unknown;

  try {
    isolatedDatabaseUrl = await createTestDatabase();
  } catch (error) {
    setupError = error;
    if (sharedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = sharedDatabaseUrl;
  }

  beforeAll(() => {
    if (setupError === undefined) return;
    throw new Error(
      `Could not create the isolated test database this file requires ` +
      `(${testPath}). It invokes an unscoped background job, so running it ` +
      `against the shared database would corrupt other files' rows: ` +
      `${setupError instanceof Error ? setupError.message : String(setupError)}`,
      { cause: setupError },
    );
  });

  /**
   * The timeout is EXPLICIT because vitest's default does not fit this hook.
   *
   * `dropTestDatabase` opens its own admin connection, issues
   * `DROP DATABASE … WITH (FORCE)`, and then closes with
   * `end({ timeout: ADMIN_CLOSE_TIMEOUT_SECONDS })` — five seconds, spent on the
   * close alone, by that function's own design. Inside vitest's default 10s hook
   * budget that leaves under five for the connect and the DROP, on a run where
   * ten workers hold eighty connections against a `max_connections` of 100.
   *
   * It is not a hypothetical margin. It failed on `main` at `c19ebc1`
   * (`engagementWritePath.test.ts`, "Hook timed out in 10000ms" pointing at this
   * line) on a run whose 527 files took 279s wall — with all 6380 tests PASSING.
   * The whole of CI, and therefore the frontend deployment behind it, was
   * blocked by a teardown that was merely slow.
   *
   * A generous budget here cannot hide a hang, which is what would make raising
   * it a cheat: every step above is individually bounded — `WITH (FORCE)`
   * terminates any session a suite leaked rather than waiting on it, and the
   * close has its own five-second cap. The worst case is bounded and simply
   * larger than 10s under load, so this states the real bound instead of
   * inheriting a default that was never measured against this work.
   */
  afterAll(async () => {
    if (sharedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = sharedDatabaseUrl;
    if (isolatedDatabaseUrl !== undefined) await dropTestDatabase(isolatedDatabaseUrl);
  }, DROP_DATABASE_TIMEOUT_MS);
}

/**
 * Name every Postgres connection after the TEST FILE that opened it.
 *
 * `application_name` reaches `pg_stat_activity`, `log_line_prefix` and any audit
 * trigger calling `current_setting('application_name')` — so a row written or
 * deleted during the run can be attributed to a file instead of inferred. That
 * matters because the obvious substitute does NOT work: grouping by
 * `pg_backend_pid()` groups by CONNECTION, and `PG_MAX_POOL_SIZE` gives each
 * worker several, so one file appears as N backends and N files sharing a worker
 * are indistinguishable. Measured while hunting a cross-file `posts` delete: a
 * single file's fixture cleanup showed up as four pids and read exactly like
 * four files racing.
 *
 * Carried as a URL PARAMETER rather than a `postgres()` option because this file
 * must not import anything that reaches `src/config` — see the isolation block
 * above, which is load-bearing for the same reason. It therefore composes with
 * that block by construction: this runs after it, so it decorates whichever
 * database that block settled on (isolated or shared), and the pristine url it
 * captured for teardown was taken before this ran.
 *
 * The strip-then-append is not defensive tidiness. A worker is REUSED across
 * files and a non-isolated file restores nothing, so the next file would
 * otherwise append to an already-decorated url and connect as
 * `application_name=fileA&application_name=fileB`.
 */
if (testPath && process.env.DATABASE_URL) {
  try {
    const url = new URL(process.env.DATABASE_URL);
    url.searchParams.delete('application_name');
    url.searchParams.set('application_name', testPath.split('/').pop() ?? 'unknown.test.ts');
    process.env.DATABASE_URL = url.toString();
  } catch {
    // A url this cannot parse is one `connectPostgres` would fail on anyway, and
    // naming connections is a diagnostic: it must never be the reason a run dies.
  }
}

// --- Redis ---
vi.mock('../utils/redis', () => ({
  getRedisClient: vi.fn().mockReturnValue({
    isReady: false,
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  }),
  closeRedisConnection: vi.fn(async () => undefined),
  reportRedisConnectionFailure: vi.fn(),
}));

// --- Logger (suppress output during tests) ---
vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

// --- Pino (direct imports) ---
vi.mock('pino', () => ({
  default: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));
