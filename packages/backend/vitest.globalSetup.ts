/**
 * Vitest global setup — Postgres.
 *
 * Creates ONE throwaway, fully-migrated database for the whole run and points
 * `DATABASE_URL` at it. Vitest forks its workers after `setup` resolves, so
 * every test file inherits that env var and `connectPostgres()` opens against
 * the throwaway database rather than a developer's real one.
 *
 * This runs for EVERY `bun run test`, so a reachable Postgres is a hard
 * prerequisite of the suite — deliberately, since the alternative (skipping
 * silently when the database is absent) is a check that cannot tell success from
 * failure. Start one with:
 *
 *   docker compose -f docker-compose.postgres.yml up -d postgres
 */

import { dropTestDatabase } from '@oxyhq/db/testing';
import { createTestDatabase } from './src/db/testDatabase';

/**
 * The per-worker connection pool, capped for the test run.
 *
 * `PG_MAX_POOL_SIZE` defaults to 20, which is a SERVER-sized budget: one process
 * serving concurrent HTTP requests. Vitest runs one worker per core and each
 * worker opens its own pool, so on a 32-core machine the suite's demand is
 * `workers × 20` against a Postgres whose `max_connections` is typically 100 —
 * and the failure is `FATAL: sorry, too many clients already`, raised in
 * whichever suites happened to be running, not in whichever one is at fault. It
 * is therefore invisible until enough database-backed files exist to cross the
 * line, and then it reads as a flake in someone else's file.
 *
 * A worker runs its test files one at a time, so a large pool buys nothing here:
 * the widest fan-out in the suite is `assemblePostRecords`' child-row load, and
 * postgres.js queues anything beyond the cap rather than failing. Set this
 * explicitly in the environment to override.
 */
const TEST_MAX_POOL_SIZE = '4';

export async function setup(): Promise<void> {
  process.env.PG_MAX_POOL_SIZE ??= TEST_MAX_POOL_SIZE;
  await createTestDatabase();
}

export async function teardown(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  await dropTestDatabase(url);
}
