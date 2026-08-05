import {
  connectToDatabase,
  type DatabaseConnectionOptions,
} from '../utils/database';
import { assertMongoTransactionalTopology } from '../utils/mongoTopology';
import { runMigrations } from './runner';

/**
 * A minute, not fifteen — and the reduction is a CUTOVER risk control rather
 * than tidying.
 *
 * The 15 minutes existed because index builds and bounded backfills legitimately
 * outlive the web runtime's 45-second socket timeout. That is no longer what
 * this task does: every Mongo migration is recorded applied and skips, and the
 * one live payload it used to carry (`reconcileBlockedDomains`) has moved to its
 * own entry point. The entire remaining Mongo surface here is a connect, one
 * `hello`, a ledger read, and the lease `findOneAndUpdate` — none of which
 * legitimately takes a minute.
 *
 * Why it matters at all: this task runs inside the Mongo→Postgres cutover
 * window, in the deploy that follows the copy, with the service already stopped.
 * `socketTimeoutMS` bounds ONE operation's inactivity, so a connection that
 * succeeds and then stalls burned up to 15 minutes of a window against the
 * deploy helper's 20-minute deadline. At 60 seconds that becomes a minute.
 *
 * It does NOT truncate the lease wait: `MIGRATION_LEASE_WAIT_MS` is 60 seconds
 * of 500 ms polls, and each poll is its own short operation rather than one long
 * one, so the wait is unaffected.
 *
 * The constraint this imposes on anyone adding migration 0026: a single Mongo
 * operation must complete within 60 seconds. That is what `MigrationContext.
 * assertLease()` and chunked batches already require for the fencing lease
 * (30 s, renewed every 10 s), so it adds no rule that was not already there —
 * but a migration written as one unchunked `updateMany` over a large collection
 * would now fail here, and should have been chunked regardless.
 *
 * Canonical branch selection must read the primary, never a lagging secondary.
 */
export const MIGRATION_DATABASE_CONNECTION_OPTIONS = Object.freeze({
  socketTimeoutMS: 60 * 1_000,
  minPoolSize: 0,
  maxPoolSize: 10,
  readPreference: 'primary',
}) satisfies DatabaseConnectionOptions;

/**
 * The Mongo half of the deploy, and ONLY the Mongo half.
 *
 * `reconcileBlockedDomains` used to run here as a fourth step. It is
 * Postgres-only, so carrying it inside the MONGO migration one-shot meant the
 * deploy step that performed it was named after a store it does not touch —
 * which would have made removing Mongo from the deploy remove the purge with it,
 * silently. It is now its own entry point, `scripts/reconcileBlockedDomains.ts`,
 * invoked as its own step by `deploy-ecs-image.sh`.
 */
export async function runMigrationTask(): Promise<void> {
  await connectToDatabase(MIGRATION_DATABASE_CONNECTION_OPTIONS);
  await assertMongoTransactionalTopology();
  await runMigrations();
}
