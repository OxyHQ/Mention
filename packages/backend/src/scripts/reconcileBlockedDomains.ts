/**
 * Purge the content of any domain the committed blocklist policy has newly
 * blocked, so blocking is ONE action with a complete effect.
 *
 * ## Why this is its own entry point
 *
 * It used to be the tail of `runMigrationTask` — the MONGO migration one-shot —
 * and it is Postgres-only. That pairing is what made the coupling invisible: the
 * deploy step that carried this work was named after a store it no longer
 * touches, so removing Mongo from the deploy would have removed the purge with
 * it, silently and for a reason nothing in the diff would name.
 *
 * The placement rationale is unchanged and still belongs to a DEPLOY step rather
 * than a scheduled job or a startup hook: it runs once per deploy, on the exact
 * image being rolled out, at the only moment a committed policy file can have
 * changed. A startup reconciliation would run N times on a scale-out; a
 * scheduled job would leave a window where a domain is blocked but its content
 * is still served. See `BlockedDomainPurgeReconciler`.
 *
 * ## It must open the pool itself, and that is not boilerplate
 *
 * A one-shot gets none of `server.ts`'s startup. `purgeBlockedDomainContent`
 * connects inside its own `require.main === module` block, which does NOT run
 * for an importer — so without `connectPostgres()` here the first `getDb()`
 * throws `PostgreSQL is not connected`, `reconcile` catches it as fail-soft, and
 * blocking a domain silently stops purging its content while the deploy reports
 * success. That happened once already (2026-08-02, `cd122151`, when the purge was
 * ported): nothing went red, because the link between an entry point and the
 * store its callee reads is a RUNTIME CONNECTION, not a symbol. `tsc` cannot see
 * it, and neither can a test that only imports this file.
 *
 * That is why `__tests__/scripts/reconcileBlockedDomains.test.ts` runs the whole
 * path against a real database and asserts the ROWS are gone, rather than
 * asserting that a mock was called.
 *
 * ## Fail-soft, deliberately
 *
 * A cleanup problem must never block shipping. Failures are recorded per domain
 * by the reconciler and logged at error level here, and the content stays until
 * the next reconciliation — failing to delete is the safe direction, and it is
 * the direction a bug here should always fall in. The process still exits 0, so
 * `deploy-ecs-image.sh` does not roll a healthy release back over a purge.
 */

import { closePostgres, connectPostgres } from '../db/postgres';
import { loadBlockedDomainPolicy } from '../services/federation/blockedDomainPolicySource';
import { reconcileBlockedDomainPurges } from '../services/federation/BlockedDomainPurgeReconciler';
import purgeBlockedDomainContent from './purgeBlockedDomainContent';
import { logger } from '../utils/logger';

/**
 * Exported so the test can drive the real path with a pool it opened itself.
 * Takes no arguments: the policy is a committed file and the purge is the one
 * implementation, so there is nothing here a caller should be able to substitute.
 */
export async function reconcileBlockedDomains(): Promise<void> {
  const policyEntries = loadBlockedDomainPolicy();
  if (policyEntries.length === 0) return;

  try {
    await reconcileBlockedDomainPurges({
      policyEntries,
      runPurge: (domains, options) => purgeBlockedDomainContent(domains, options),
    });
  } catch (error) {
    logger.error('[reconcileBlockedDomains] reconciliation failed; deploy continues', error);
  }
}

if (require.main === module) {
  void (async () => {
    try {
      await connectPostgres();
      await reconcileBlockedDomains();
    } catch (error) {
      // Reaching here means the POOL could not be opened, which the fail-soft
      // above cannot absorb because it never ran. Still exit 0: a deploy must not
      // be rolled back over a cleanup step.
      logger.error('[reconcileBlockedDomains] could not open the database', error);
    } finally {
      await closePostgres().catch(() => undefined);
      // Imported singletons (BullMQ Redis handles, the media cache worker) keep
      // the event loop alive, so a Fargate one-shot would sit RUNNING after the
      // work completed. Mirrors the other one-shots.
      process.exit(0);
    }
  })();
}
