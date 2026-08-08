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
 * THIS IS THE ONLY MIGRATION MECHANISM. A separate data-migration runner used to
 * sit beside it for the Mongo store, with its own ledger; both are gone, and a
 * schema change now goes through `drizzle/` and this file and nothing else.
 *
 * DRY RUN. `DRY_RUN=true` reports which migrations WOULD be applied and writes
 * nothing — not even the ledger table.
 *
 * TARGET DATABASE. `--target-database=<name>` is REQUIRED, on every run
 * including `DRY_RUN`, and is checked against `current_database()` before any
 * other statement. See `db/targetDatabase.ts` for why this step needs the guard
 * more than the copy does: aimed at the wrong database the copy dies on a
 * missing table, while this one applies the whole journal to whatever it
 * reached, prints `Applied N` and exits 0.
 *
 * UNREACHABLE MIGRATIONS. The shared apply rule is a HIGH-WATER filter, not a
 * per-migration set difference, so a journal entry generated before another
 * branch's migration landed is stepped over in silence — `No pending Postgres
 * migrations`, exit 0, a constraint that never got applied. The rule itself is
 * kept (it is drizzle's, and diverging would make this report disagree with
 * what `drizzle-kit migrate` does to the same database); what changes is that
 * `planMigrationRun` REFUSES rather than reporting a clean run. See
 * `migrationLedger.ts` for the mechanism and for the two entries already in
 * this journal that have the shape.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { ensureExtensions } from './extensions';
import { logger } from '../utils/logger';
import {
  MIGRATIONS_FOLDER,
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE,
  planMigrationRun,
  readAppliedMillis,
  readJournal,
} from './migrationLedger';
import { assertMigrationTarget, readTargetDatabase } from './targetDatabase';

/** Seconds to wait for in-flight queries before forcing the socket shut. */
const CLOSE_TIMEOUT_SECONDS = 5;

/** Whether `DRY_RUN` asks for a report instead of an apply. */
function isDryRun(): boolean {
  const value = (process.env.DRY_RUN ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

async function main(): Promise<void> {
  // Before DATABASE_URL, and before anything opens a socket: an operator who
  // forgot the flag should learn it instantly rather than after a connection.
  const target = readTargetDatabase(process.argv.slice(2));

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Start a local Postgres with: ' +
      'docker compose -f docker-compose.postgres.yml up -d postgres'
    );
  }

  const entries = readJournal();
  const dryRun = isDryRun();

  // `max: 1` — migrations are one serial stream of DDL; a pool would buy nothing
  // and would let statements interleave across connections.
  const client = postgres(url, {
    max: 1,
    onnotice: (notice) => logger.debug('Postgres notice', { notice: notice.message }),
  });

  try {
    // FIRST statement on this connection, before the ledger read, before
    // `ensureExtensions`, before any DDL. Everything below either writes or is
    // a precondition for a write, so an assertion placed after any of them is
    // checking a database it has already started changing.
    await assertMigrationTarget(client, target);

    // `planMigrationRun` and not `pendingEntries`: it REFUSES when the journal
    // holds an entry the apply rule can never reach, before the `pending.length
    // === 0` branch below — which is the branch that would otherwise print
    // `No pending Postgres migrations` over a migration that never ran. The
    // refusal has to sit ahead of the dry run too: a dry run answering "nothing
    // to do" about an unreachable migration tells the same lie for free.
    const pending = planMigrationRun(entries, await readAppliedMillis(client));

    if (pending.length === 0) {
      logger.info('No pending Postgres migrations', { journalEntries: entries.length });
      return;
    }

    const tags = pending.map((entry) => entry.tag);

    if (dryRun) {
      logger.info(
        `DRY RUN — ${pending.length} migration(s) would be applied; nothing was written`,
        { pending: tags, journalEntries: entries.length }
      );
      return;
    }

    // Extensions first, and inside this script rather than chained in the
    // `db:migrate` npm script: production applies migrations by running the
    // COMPILED form of this file directly as a one-shot ECS task, so anything
    // chained in package.json would silently not run there. A migration that
    // creates a `geography` column fails partway through without it.
    await ensureExtensions(url);

    logger.info(`Applying ${pending.length} Postgres migration(s)`, { pending: tags });

    // No `schema`/`casing` here on purpose: `migrate()` only executes the raw
    // SQL text of the migration files, so it never builds a query from the
    // schema definitions and the compiled migrator stays independent of them.
    await migrate(drizzle(client), {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsSchema: MIGRATIONS_SCHEMA,
      migrationsTable: MIGRATIONS_TABLE,
    });

    // A migrator that reports success while leaving work pending is worse than
    // one that fails, so re-read the ledger rather than trusting the call.
    const remaining = planMigrationRun(entries, await readAppliedMillis(client));
    if (remaining.length > 0) {
      throw new Error(
        `Migration reported success but ${remaining.length} migration(s) are still ` +
        `pending: ${remaining.map((entry) => entry.tag).join(', ')}`
      );
    }

    logger.info(`Applied ${pending.length} Postgres migration(s)`, { applied: tags });
  } finally {
    await client.end({ timeout: CLOSE_TIMEOUT_SECONDS });
  }
}

main().catch((error: unknown) => {
  logger.error('Postgres migration failed', error);
  // Not `process.exit`: the pino transport used in development writes from a
  // worker thread, and exiting here would truncate the very message that says
  // what went wrong. The event loop is already free once the pool is closed.
  process.exitCode = 1;
});
