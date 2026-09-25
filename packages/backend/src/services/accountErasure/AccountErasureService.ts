/**
 * ERASE EVERYTHING MENTION HOLDS FOR ONE OXY ACCOUNT (OxyHQ/Mention#1169).
 *
 * The trigger is Oxy's signed `account.deleted` event: pushed to the webhook, or
 * read from the pull feed by the reconciliation sweep, or recorded by an operator
 * for an account deleted before this shipped. All three write a row in
 * `account_erasures` and end up in {@link processAccountErasure}.
 *
 * NEVER inferred. A 404 from Oxy, a missing profile or a failed lookup is NOT a
 * deletion: only a signed event (or an operator who has checked Oxy) starts this.
 *
 * WHAT IT DOES, in order (each phase's reason is on `ErasurePhase`):
 *   drain → posts (with Delete(Note)s) → actor Delete → engagement → account →
 *   federation → caches.
 * Exactly what each table gets is `erasureMap.ts`, with the reason per row.
 *
 * IDEMPOTENT AND RESUMABLE. Every step is keyed on the account id and converges:
 * a second run finds nothing and changes nothing. A crash mid-run leaves the
 * ledger row `running` with a lease that lapses; the sweep reclaims it and the
 * re-run walks whatever survived. An unknown account, or one already erased, is a
 * successful no-op.
 *
 * LOGGED with counts per category, never content: the ledger row keeps the same
 * counts for "how do I verify".
 */

import { logger } from '../../utils/logger';
import { metrics } from '../../utils/metrics';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import {
  claimAccountErasure,
  completeAccountErasure,
  failAccountErasure,
  findAccountErasure,
  renewAccountErasureLease,
  setAccountErasureUsername,
  type AccountErasureRow,
} from '../../db/accountErasures/accountErasureRepository';
import { ACCOUNT_ERASURE_MAP, erasureKey, type ErasurePhase } from './erasureMap';
import { ERASURE_STEPS, type ErasureStep } from './erasureSteps';
import { countAccountPosts, eraseAccountPosts, type OwnPostRow } from './erasePosts';
import { broadcastActorDelete, broadcastPostDeletes } from './erasureFederation';
import { dropAccountCaches } from './erasureCaches';
import { normalizeUsername } from './oxyAccountEvents';

const LOG_PREFIX = '[AccountErasure]';

/** How long a run's lease lasts before another task may reclaim it. Renewed while running. */
export const ERASURE_LEASE_MS = 10 * 60 * 1000;
const LEASE_RENEW_MS = 2 * 60 * 1000;

export const ACCOUNT_ERASURE_COMPLETED_METRIC = 'account_erasure_completed_total';
export const ACCOUNT_ERASURE_FAILED_METRIC = 'account_erasure_failed_total';

/** Map entries a step performs, in phase order then declaration order. */
function scheduledSteps(phase: ErasurePhase): Array<{ key: string; step: ErasureStep }> {
  const scheduled: Array<{ key: string; step: ErasureStep; index: number }> = [];
  ACCOUNT_ERASURE_MAP.forEach((entry, index) => {
    if (entry.phase !== phase) return;
    const step = ERASURE_STEPS[erasureKey(entry)];
    if (step) scheduled.push({ key: erasureKey(entry), step, index });
  });
  return scheduled
    .sort((left, right) => (left.step.order ?? 0) - (right.step.order ?? 0) || left.index - right.index)
    .map(({ key, step }) => ({ key, step }));
}

async function runPhase(
  phase: ErasurePhase,
  oxyUserId: string,
  counts: Record<string, number>,
): Promise<void> {
  for (const { key, step } of scheduledSteps(phase)) {
    try {
      counts[key] = (counts[key] ?? 0) + (await step.apply({ oxyUserId }));
    } catch (error) {
      // Name the step; the driver message never carries row content.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`erasure step ${key} failed: ${message}`);
    }
  }
}

/**
 * The handle, from the event, else the ledger, else Oxy (an operator erasing an
 * archived account Oxy still resolves). A lookup failure is "unknown", never a
 * reason to stop: without a handle the local erasure still runs, only the
 * fediverse cannot be told.
 */
async function resolveUsername(row: AccountErasureRow): Promise<string | null> {
  if (row.username) return row.username;
  try {
    const user = await getServiceOxyClient().getUserById(row.oxyUserId);
    return normalizeUsername(user?.username);
  } catch {
    return null;
  }
}

export interface AccountErasureReport {
  eventId: string;
  oxyUserId: string;
  counts: Record<string, number>;
  /** False when no handle was known, so no Delete could be addressed. */
  federated: boolean;
}

/**
 * Erase one account. Performs every step; does NOT touch the ledger (see
 * {@link processAccountErasure}). Exported for the operator script and tests.
 */
export async function eraseOxyUser(
  oxyUserId: string,
  options: { reason: string; eventId: string; username?: string | null },
): Promise<AccountErasureReport> {
  const counts: Record<string, number> = {};
  const username = options.username ?? null;
  logger.info(`${LOG_PREFIX} erasure started`, {
    eventId: options.eventId,
    reason: options.reason,
    federated: username !== null,
  });

  await runPhase('drain', oxyUserId, counts);

  const broadcast = username
    ? (batch: readonly OwnPostRow[]) => broadcastPostDeletes(oxyUserId, username, batch)
    : null;
  const walk = await eraseAccountPosts(oxyUserId, broadcast);
  counts['posts.oxyUserId'] = walk.posts;
  counts['posts.boostsByOthers'] = walk.boostsByOthers;
  counts['federation.postDeletes'] = walk.deletesSent;

  counts['federation.actorDelete'] = username && (await broadcastActorDelete(oxyUserId, username)) ? 1 : 0;

  await runPhase('engagement', oxyUserId, counts);
  await runPhase('account', oxyUserId, counts);
  await runPhase('federation', oxyUserId, counts);

  counts['caches.dropped'] = await dropAccountCaches(oxyUserId);

  logger.info(`${LOG_PREFIX} erasure completed`, { eventId: options.eventId, counts });
  return { eventId: options.eventId, oxyUserId, counts, federated: username !== null };
}

export type ProcessOutcome =
  | { outcome: 'completed'; report: AccountErasureReport }
  | { outcome: 'already-completed' }
  | { outcome: 'busy' }
  | { outcome: 'unknown-event' };

/**
 * Run the erasure recorded under `eventId`, holding its lease. Throws when the
 * erasure fails, after recording the failure, so a queue retries it.
 */
export async function processAccountErasure(eventId: string): Promise<ProcessOutcome> {
  const existing = await findAccountErasure(eventId);
  if (!existing) return { outcome: 'unknown-event' };
  if (existing.status === 'completed') return { outcome: 'already-completed' };

  const row = await claimAccountErasure(eventId, ERASURE_LEASE_MS);
  if (!row) {
    // Completed between the read and the claim, or another task holds the lease.
    const now = await findAccountErasure(eventId);
    return now?.status === 'completed' ? { outcome: 'already-completed' } : { outcome: 'busy' };
  }

  const renew = setInterval(() => {
    void renewAccountErasureLease(eventId, ERASURE_LEASE_MS).catch(() => undefined);
  }, LEASE_RENEW_MS);
  renew.unref?.();

  try {
    const username = await resolveUsername(row);
    if (username && !row.username) await setAccountErasureUsername(eventId, username);
    const report = await eraseOxyUser(row.oxyUserId, {
      reason: 'account.deleted',
      eventId,
      username,
    });
    await completeAccountErasure(eventId, report.counts);
    metrics.incrementCounter(ACCOUNT_ERASURE_COMPLETED_METRIC, 1, { source: row.source });
    return { outcome: 'completed', report };
  } catch (error) {
    await failAccountErasure(eventId, error);
    metrics.incrementCounter(ACCOUNT_ERASURE_FAILED_METRIC, 1, { source: row.source });
    logger.error(`${LOG_PREFIX} erasure failed; it will be retried`, {
      eventId,
      attempts: row.attempts,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    clearInterval(renew);
  }
}

/** What an erasure WOULD remove, per category. Strictly read-only. */
export async function previewAccountErasure(oxyUserId: string): Promise<Record<string, number>> {
  const preview: Record<string, number> = {};
  const postCounts = await countAccountPosts(oxyUserId);
  preview['posts.oxyUserId'] = postCounts.posts;
  preview['federation.postDeletes'] = postCounts.federated;
  for (const entry of ACCOUNT_ERASURE_MAP) {
    const step = ERASURE_STEPS[erasureKey(entry)];
    if (!step) continue;
    preview[erasureKey(entry)] = await step.count({ oxyUserId });
  }
  return preview;
}
