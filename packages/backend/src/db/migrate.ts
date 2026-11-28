/**
 * Apply the SQL migrations in `drizzle/` to `DATABASE_URL`.
 *
 * This is the ONE migration mechanism for the Postgres side of this package.
 * `bun run db:migrate` runs it, the vitest harness (`src/db/testDatabase.ts`)
 * shells out to that same script, CI runs the same script, and production runs
 * its COMPILED form (`dist/src/db/migrate.js`) as a one-shot ECS task. Nothing
 * applies a migration by any other route.
 *
 * WHY NOT `drizzle-kit migrate`
 *
 * drizzle-kit is a CLI that cannot reach production: it is a devDependency and
 * the shipped image installs production dependencies only. `drizzle-orm` — a
 * runtime dependency — ships the migrator itself, so the migrator compiles into
 * the SAME image the service runs, adds no dependency at all, and the one-shot
 * ECS task can reuse the LIVE task definition with only `command` overridden
 * (the pattern `recomputeFederatedEngagement.ts` already established for
 * Mention's Fargate one-shots).
 *
 * drizzle-kit stays a devDependency for `db:generate`, which only ever runs on a
 * developer's machine and never opens a database.
 *
 * BOTH TOOLS SHARE ONE LEDGER. `drizzle-kit migrate` and `drizzle-orm`'s
 * `migrate()` read the same `meta/_journal.json`, write the same
 * `drizzle.__drizzle_migrations` rows, and apply the same "everything newer than
 * the newest recorded `created_at`" rule — so a database migrated by either is
 * understood by the other.
 *
 * THIS IS THE ONLY MIGRATION MECHANISM. A schema change goes through `drizzle/`
 * and this file and nothing else.
 *
 * DRY RUN. `DRY_RUN=true` reports which migrations WOULD be applied and writes
 * nothing — not even the ledger table.
 *
 * TARGET DATABASE. `--target-database=<name>` is REQUIRED, on every run
 * including `DRY_RUN`, and is checked against `current_database()` before any
 * other statement. See `@oxy.so/db/migrate`'s `targetDatabase.ts` for why this
 * step needs the guard more than the copy does: aimed at the wrong database the
 * copy dies on a missing table, while this one applies the whole journal to
 * whatever it reached, prints `Applied N` and exits 0.
 *
 * ONE TRANSACTION PER MIGRATION, UNDER A LOCK TIMEOUT. The apply itself is
 * `runMigrations` from `@oxy.so/db/migrate` (>= 1.2.0): each pending migration
 * commits on its own, every statement runs under `lock_timeout` = 3 s and
 * `statement_timeout` = 120 s, and a migration that loses a lock race (or a
 * deadlock) is rolled back and retried with backoff. drizzle's own `migrate()`
 * wraps the WHOLE batch in one transaction, so the first migration's locks were
 * held until the last one committed — the 2026-10-16 shared-database outage
 * (`@oxy.so/db/migrate`'s `locks.ts`). Every Mention table lives on that same
 * Postgres. A migration that genuinely needs longer than 120 s per statement
 * says so in its own file: `-- oxy:statement-timeout=600s`.
 *
 * EVERY MIGRATION DECLARES A DEPLOY PHASE (`-- oxy:deploy-phase=pre|post`, see
 * `@oxy.so/db/migrate`'s `phases.ts`), because the shared runner refuses a file
 * without one. Mention's deploy applies every pending migration BEFORE the
 * rollout, and the readiness check (`assertPostgresMigrationsCurrent`) refuses
 * a task while any migration is pending, so this run is always `all`: a `post`
 * migration is still applied while the previous image serves. Destructive
 * changes therefore ship in a release AFTER the one that stops reading what they
 * remove — the marker records the migration's shape, it does not defer it.
 *
 * UNREACHABLE MIGRATIONS. The shared apply rule is a HIGH-WATER filter, not a
 * per-migration set difference, so a journal entry generated before another
 * branch's migration landed is stepped over in silence — `No pending Postgres
 * migrations`, exit 0, a constraint that never got applied. The rule itself is
 * kept (it is drizzle's, and diverging would make this report disagree with
 * what `drizzle-kit migrate` does to the same database); what changes is that
 * `planLedgerRun` REFUSES rather than reporting a clean run. See
 * `@oxy.so/db/migrate`'s `ledger.ts` for the mechanism and for the two entries
 * already in this journal that have the shape.
 */

import { readTargetDatabase, runMigrations } from '@oxy.so/db/migrate';
import { logger } from '../utils/logger';
import { REQUIRED_EXTENSIONS } from './extensions';
import { MIGRATIONS_FOLDER } from './migrationsFolder';

/** Whether `DRY_RUN` asks for a report instead of an apply. */
function isDryRun(): boolean {
  const value = (process.env.DRY_RUN ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

async function main(): Promise<void> {
  // Before DATABASE_URL, and before anything opens a socket: an operator who
  // forgot the flag should learn it instantly rather than after a connection.
  const expectedDatabase = readTargetDatabase(process.argv.slice(2));

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Start a local Postgres with: ' +
        'docker compose -f docker-compose.postgres.yml up -d postgres',
    );
  }

  // `runMigrations` asserts the target as the FIRST statement on its
  // connection, refuses an unreachable journal entry (`planLedgerRun`) before a
  // dry run could report "nothing to do" over it, ensures the extensions only
  // once there is work, applies one migration per transaction, and re-reads the
  // ledger afterwards rather than trusting the apply.
  await runMigrations({
    databaseUrl,
    migrationsFolder: MIGRATIONS_FOLDER,
    extensions: REQUIRED_EXTENSIONS,
    run: 'all',
    expectedDatabase,
    dryRun: isDryRun(),
    logger: {
      info: (message) => logger.info(message),
      debug: (message) => logger.debug(message),
    },
  });
}

main().catch((error: unknown) => {
  logger.error('Postgres migration failed', error);
  // Not `process.exit`: the pino transport used in development writes from a
  // worker thread, and exiting here would truncate the very message that says
  // what went wrong. The event loop is already free once the pool is closed.
  process.exitCode = 1;
});
