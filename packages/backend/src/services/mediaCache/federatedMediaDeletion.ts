import { config } from '../../config';
import { metrics } from '../../utils/metrics';
import {
  countStuckMediaDeletions,
  findDueMediaDeletions,
  pruneFederatedMediaHousekeeping,
  retryMediaDeletions,
  settleMediaDeletions,
  tombstoneUnreferenced,
} from '../../db/federation/mediaDeletionRepository';
import { logger } from '../../utils/logger';
import {
  deleteFederatedMedia,
  FEDERATED_MEDIA_DELETE_BATCH_MAX,
  OxyMediaStoreRequestError,
  OxyMediaStoreThrottledError,
} from './oxyMediaStore';

/**
 * Drain `federated_media_deletions`: delete from Oxy the re-hosted federated
 * files no post (or variant, or banner) references any more.
 *
 * DURABLE, not fire-and-forget: the rows are written in the same transaction
 * that deleted the posts, and a row leaves the live states only when Oxy has
 * ANSWERED for its file:
 *
 *  - `deleted` / `not_found` → done (the tombstone stays, so no later post can
 *    re-reference the id);
 *  - `forbidden` → not this app's federated media: logged and dropped;
 *  - `in_use` → Oxy keeps the file (another owner or app also holds it):
 *    settled, logged at info, no retry;
 *  - an answer this build does not know → treated as no answer: retried;
 *  - 429, a 5xx, a transport failure, or HTTP 404 on the ROUTE (an oxy-api that
 *    predates it) → retried with exponential backoff, never read as done.
 *
 * Runs on the periodic queue (one run across the fleet), with an in-process
 * interval when there is no queue. Always — not gated on the Instagram flag or
 * on media writes: a deletion at the source is a privacy obligation.
 */

const STUCK_METRIC = 'federated_media_delete_stuck';
const RETRY_BASE_MS = 60 * 1000;
const RETRY_MAX_MS = 6 * 60 * 60 * 1000;

/** Exported for tests. */
export function mediaDeletionBackoffMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts), RETRY_MAX_MS);
}

function describe(error: unknown): string {
  if (error instanceof OxyMediaStoreThrottledError) return 'throttled (429)';
  if (error instanceof OxyMediaStoreRequestError) return `HTTP ${error.statusCode}`;
  return error instanceof Error ? error.name : 'unknown';
}

export interface MediaDeletionDrainResult {
  checked: number;
  deleted: number;
  notFound: number;
  forbidden: number;
  /** Oxy kept the file: another owner or app also holds it. Settled, no retry. */
  keptByOxy: number;
  retried: number;
}

/** One batch: at most one Oxy call. Never throws. */
async function drainOneBatch(
  limit = FEDERATED_MEDIA_DELETE_BATCH_MAX,
): Promise<MediaDeletionDrainResult> {
  const result: MediaDeletionDrainResult = {
    checked: 0,
    deleted: 0,
    notFound: 0,
    forbidden: 0,
    keptByOxy: 0,
    retried: 0,
  };
  let due: Awaited<ReturnType<typeof findDueMediaDeletions>>;
  try {
    due = await findDueMediaDeletions(Math.min(limit, FEDERATED_MEDIA_DELETE_BATCH_MAX));
  } catch (err) {
    logger.warn('[MediaDelete] could not read the deletion outbox', { reason: describe(err) });
    return result;
  }
  if (due.length === 0) return result;
  result.checked = due.length;

  // Pending rows are reference-checked (and, if unused, tombstoned) first.
  const pending = due.filter((row) => row.state === 'pending').map((row) => row.oxyFileId);
  let tombstoned: string[] = [];
  try {
    tombstoned = await tombstoneUnreferenced(pending);
  } catch (err) {
    // BACK THEM OFF, and end this run: left as they are, the same oldest rows
    // would be re-selected on every batch of every run and jam the queue.
    const attempts = Math.max(
      0,
      ...due.filter((row) => row.state === 'pending').map((row) => row.attempts),
    );
    await retryMediaDeletions(
      pending,
      mediaDeletionBackoffMs(attempts),
      `reference check: ${describe(err)}`,
    ).catch(() => undefined);
    result.retried += pending.length;
    logger.warn('[MediaDelete] reference check failed; backed off', {
      reason: describe(err),
      files: pending.length,
    });
    return result;
  }
  const toDelete = [
    ...due.filter((row) => row.state === 'deleting').map((row) => row.oxyFileId),
    ...tombstoned,
  ];
  if (toDelete.length === 0) return result;

  const attempts = Math.max(
    0,
    ...due.filter((row) => toDelete.includes(row.oxyFileId)).map((row) => row.attempts),
  );
  try {
    const answers = await deleteFederatedMedia(toDelete);
    await settleMediaDeletions(
      answers.map((answer) => ({ oxyFileId: answer.id, result: answer.result })),
    );
    for (const answer of answers) {
      if (answer.result === 'deleted') result.deleted += 1;
      else if (answer.result === 'not_found') result.notFound += 1;
      else if (answer.result === 'in_use') result.keptByOxy += 1;
      else result.forbidden += 1;
    }
    if (result.keptByOxy > 0) {
      logger.info('[MediaDelete] Oxy kept files another owner or app also holds', {
        kept: result.keptByOxy,
      });
    }
    if (result.forbidden > 0) {
      logger.warn(
        "[MediaDelete] Oxy refused files that are not this app's federated media; dropped",
        {
          forbidden: result.forbidden,
        },
      );
    }
    // Anything Oxy did not answer for is still owed.
    const answered = new Set(answers.map((answer) => answer.id));
    const unanswered = toDelete.filter((id) => !answered.has(id));
    if (unanswered.length > 0) {
      await retryMediaDeletions(unanswered, mediaDeletionBackoffMs(attempts), 'no answer for id');
      result.retried += unanswered.length;
    }
  } catch (err) {
    // 429, 5xx, transport, or the route missing on an older oxy-api: owed, later.
    const reason = describe(err);
    // A 429 names when the budget returns; never retry sooner than that.
    const delay =
      err instanceof OxyMediaStoreThrottledError
        ? Math.max(mediaDeletionBackoffMs(attempts), err.retryAfterMs)
        : mediaDeletionBackoffMs(attempts);
    await retryMediaDeletions(toDelete, delay, reason).catch(() => undefined);
    result.retried += toDelete.length;
    logger.warn('[MediaDelete] Oxy delete failed; will retry', { reason, files: toDelete.length });
  }
  return result;
}

/** Oxy batch calls per drain run: ≤ 100 files a minute, far inside 240 requests/minute. */
const MAX_BATCHES_PER_RUN = 5;

/** Attempts after which a deletion counts as STUCK (≈ a day of backoff). */
export const STUCK_ATTEMPTS = 10;

/**
 * One drain run: batches of at most {@link FEDERATED_MEDIA_DELETE_BATCH_MAX}
 * files (the route's cap) until nothing is due or {@link MAX_BATCHES_PER_RUN}
 * calls were made. A batch that had to retry ends the run — the rest would hit
 * the same wall. Then bounded housekeeping, and the stuck-row gauge.
 *
 * `FEDERATED_MEDIA_DELETE_ENABLED=false` PAUSES this: nothing is sent and no
 * row changes, so every queued deletion resumes when it is switched back on.
 * Never throws.
 */
export async function drainFederatedMediaDeletions(
  limit = FEDERATED_MEDIA_DELETE_BATCH_MAX,
): Promise<MediaDeletionDrainResult> {
  const total: MediaDeletionDrainResult = {
    checked: 0,
    deleted: 0,
    notFound: 0,
    forbidden: 0,
    keptByOxy: 0,
    retried: 0,
  };
  if (!config.federatedMediaDeletion.enabled) {
    logger.debug('[MediaDelete] paused by FEDERATED_MEDIA_DELETE_ENABLED=false');
    return total;
  }
  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
    const result = await drainOneBatch(limit);
    for (const key of Object.keys(total) as Array<keyof MediaDeletionDrainResult>)
      total[key] += result[key];
    if (result.checked === 0 || result.retried > 0) break;
  }

  try {
    const pruned = await pruneFederatedMediaHousekeeping();
    if (pruned.forbidden > 0 || pruned.posterPairs > 0)
      logger.debug('[MediaDelete] housekeeping', pruned);
    const stuck = await countStuckMediaDeletions(STUCK_ATTEMPTS);
    metrics.setGauge(STUCK_METRIC, stuck);
    if (stuck > 0) {
      // Loud: a deletion Oxy has failed to answer for about a day is a privacy
      // obligation not being met, and nothing else will surface it.
      logger.error(
        '[MediaDelete] federated media deletions are stuck (Oxy keeps failing to answer)',
        {
          stuck,
          attemptsAtLeast: STUCK_ATTEMPTS,
        },
      );
    }
  } catch (err) {
    logger.warn('[MediaDelete] housekeeping failed', { reason: describe(err) });
  }
  return total;
}
