/**
 * Mention's own migrated throwaway test database.
 *
 * `@oxyhq/db/testing`'s `createTestDatabase` creates the throwaway database
 * itself and returns its connection string; MIGRATING it is a caller-supplied
 * hook (see that module's doc comment for why: a shared package ships no
 * migration files of its own to apply). This file supplies that hook —
 * spawning `bun run db:migrate` (`src/db/migrate.ts`), the single Postgres
 * migration mechanism in this package — and publishes the result as
 * `DATABASE_URL` so the suite's own `connectPostgres()` opens against the
 * throwaway database rather than a developer's real one.
 *
 * `dropTestDatabase` needs no Mention-specific wrapping, so callers import it
 * straight from `@oxyhq/db/testing` rather than through here.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createTestDatabase as createMigratedTestDatabase } from '@oxyhq/db/testing';

/** Milliseconds `bun run db:migrate` may take before the run is abandoned. */
const MIGRATE_TIMEOUT_MS = 120_000;

/**
 * `packages/backend` — the working directory `bun run db:migrate` must run from.
 * `src/db/` and `dist/src/db/` sit two and three levels below it respectively;
 * this module is only ever loaded from source by vitest, so two is correct.
 */
const PACKAGE_ROOT = join(__dirname, '..', '..');

/**
 * Run `bun run db:migrate` against `databaseUrl`.
 *
 * @throws {Error} Carrying the migrator's own output when it fails — a silent
 *   migration failure would leave every test querying an empty database and
 *   failing for the wrong reason.
 */
function runMigrations(databaseUrl: string, databaseName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // `--target-database` is required by the migrator and is not a formality
    // here: the harness (`@oxyhq/db/testing`) generated this name and built
    // `databaseUrl` from it, so passing it asserts that the URL still points
    // where the harness thinks it does. A test run that silently migrated the
    // DEVELOPER's database instead of its throwaway one is exactly the
    // accident the flag exists to refuse.
    const child = spawn('bun', ['run', 'db:migrate', `--target-database=${databaseName}`], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: MIGRATE_TIMEOUT_MS,
    });

    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.on('error', (error) => {
      reject(new Error(`Failed to run \`bun run db:migrate\`: ${error.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`\`bun run db:migrate\` exited with code ${code}:\n${output}`));
    });
  });
}

/**
 * Create a migrated throwaway database and point `DATABASE_URL` at it.
 *
 * @returns The throwaway database's connection string.
 * @throws {Error} When neither `TEST_DATABASE_URL` nor `DATABASE_URL` is set —
 *   there is no server to create the database on.
 */
export async function createTestDatabase(): Promise<string> {
  const baseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!baseUrl) {
    throw new Error(
      'TEST_DATABASE_URL (or DATABASE_URL) must point at a Postgres server so ' +
      'a throwaway test database can be created on it. Start one with: ' +
      'docker compose -f docker-compose.postgres.yml up -d postgres'
    );
  }

  const url = await createMigratedTestDatabase({
    adminUrl: baseUrl,
    migrate: async (databaseUrl) => {
      const name = new URL(databaseUrl).pathname.replace(/^\//, '');
      await runMigrations(databaseUrl, name);
    },
  });

  process.env.DATABASE_URL = url;
  return url;
}
