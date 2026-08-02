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
 * Index builds and bounded backfills legitimately outlive the web runtime's
 * 45-second socket timeout. Keep the override local to the ECS one-shot and
 * below the deploy helper's 20-minute task deadline. Canonical branch selection
 * must read the primary, never a lagging secondary.
 */
export const MIGRATION_DATABASE_CONNECTION_OPTIONS = Object.freeze({
  socketTimeoutMS: 15 * 60 * 1_000,
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
