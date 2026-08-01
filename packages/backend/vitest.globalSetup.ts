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
 *
 * The Mongo side is untouched: `src/__tests__/setup.ts` still mocks mongoose
 * wholesale, and every existing suite keeps running against that mock.
 */

import { createTestDatabase, dropTestDatabase } from './src/db/testDatabase';

export async function setup(): Promise<void> {
  await createTestDatabase();
}

export async function teardown(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  await dropTestDatabase(url);
}
