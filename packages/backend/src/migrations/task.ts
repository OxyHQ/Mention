import {
  connectToDatabase,
  type DatabaseConnectionOptions,
} from '../utils/database';
import { assertMongoTransactionalTopology } from '../utils/mongoTopology';
import { logger } from '../utils/logger';
import { runMigrations } from './runner';
import { loadBlockedDomainPolicy } from '../services/federation/blockedDomainPolicySource';
import { reconcileBlockedDomainPurges } from '../services/federation/BlockedDomainPurgeReconciler';
import purgeBlockedDomainContent from '../scripts/purgeBlockedDomainContent';

/**
 * A minute, not fifteen — and the reduction is a CUTOVER risk control rather
 * than tidying.
 *
 * The 15 minutes existed because index builds and bounded backfills legitimately
 * outlive the web runtime's 45-second socket timeout. That is no longer what
 * this task does: all 25 Mongo migrations are recorded applied and skip, and the
 * only live payload (`reconcileBlockedDomains`) is Postgres-only. The entire
 * remaining Mongo surface here is a connect, one `hello`, a ledger read, and the
 * lease `findOneAndUpdate` — none of which legitimately takes a minute.
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
 * Purge the content of any domain the committed blocklist policy has newly
 * blocked, so blocking is one action with a complete effect.
 *
 * Runs AFTER the schema migrations, in the same deploy one-shot: once per
 * deploy, on the exact image being rolled out, at the only moment a committed
 * policy file can have changed. See `BlockedDomainPurgeReconciler` for why that
 * beats a startup reconciliation (N tasks on a scale-out) or a scheduled job (a
 * window where the domain is blocked but its content is still served).
 *
 * Deliberately fail-soft: a cleanup problem must never block shipping. The
 * failure is recorded per domain and logged at error level, and the content
 * stays until the next reconciliation — failing to delete is the safe direction,
 * and it is the direction a bug here should always fall in.
 */
async function reconcileBlockedDomains(): Promise<void> {
  const policyEntries = loadBlockedDomainPolicy();
  if (policyEntries.length === 0) return;

  try {
    await reconcileBlockedDomainPurges({
      policyEntries,
      runPurge: (domains, options) => purgeBlockedDomainContent(domains, options),
    });
  } catch (error) {
    logger.error('[migration] blocked-domain reconciliation failed; deploy continues', error);
  }
}

export async function runMigrationTask(): Promise<void> {
  await connectToDatabase(MIGRATION_DATABASE_CONNECTION_OPTIONS);
  await assertMongoTransactionalTopology();
  await runMigrations();
  await reconcileBlockedDomains();
}
