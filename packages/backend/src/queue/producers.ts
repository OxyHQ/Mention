import { createHash } from 'crypto';
import { getInboxQueue, getDeliveryQueue, getSharingCleanupQueue } from './queues';
import {
  DELIVERY_JOB_ATTEMPTS,
  DELIVERY_BACKOFF_STRATEGY,
  INBOX_JOB_ATTEMPTS,
  INBOX_BACKOFF_BASE_MS,
  SHARING_CLEANUP_JOB_ATTEMPTS,
  SHARING_CLEANUP_BACKOFF_BASE_MS,
} from './constants';
import type { InboxJobData, DeliveryJobData, SharingCleanupJobData } from './types';

/**
 * Producer helpers — the single place that enqueues federation jobs with the
 * correct dedupe `jobId`s. Callers must already hold a usable queue (these
 * return a boolean indicating whether the job was enqueued; `false` means the
 * queue is unavailable and the caller should use its inline/Mongo fallback).
 */

/**
 * Hex characters of the SHA-256 digest kept for a jobId. 40 hex chars = 160
 * bits, collision-safe while keeping Redis keys short.
 */
const JOB_ID_HASH_LENGTH = 40;

/**
 * Stable short hash used to build collision-safe, length-bounded jobIds. Output
 * is lowercase hex, so a `<prefix>-<hash>` jobId never contains a `:` — BullMQ
 * rejects any custom jobId containing a colon (unless it splits into exactly 3
 * parts, a deprecated repeatable-job compat path we must not rely on), which
 * previously made every enqueue throw and silently fall back to the Mongo queue.
 */
function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, JOB_ID_HASH_LENGTH);
}

/**
 * Enqueue an inbound activity for asynchronous processing. Dedupes on the
 * verified actor URI and activity `id` so redelivery from the same actor is
 * idempotent without letting another actor suppress a reused activity id. Returns
 * false when no queue is available (caller should process inline) — that
 * includes the case where the activity has no stable `id` to dedupe on.
 */
export async function enqueueInboxActivity(data: InboxJobData): Promise<boolean> {
  const queue = getInboxQueue();
  if (!queue) return false;

  const activityId = typeof data.activity.id === 'string' ? data.activity.id : undefined;
  if (!activityId) return false;

  // Bounded retry: inbound processing is mostly local DB work, but it can DEFER
  // when a federated post's actor is not yet resolved to an Oxy user
  // (`ActorResolutionPendingError`) — e.g. Oxy was unreachable. Retrying with
  // exponential backoff lets a later attempt insert the post with a real author
  // instead of an orphan. A permanently-unresolvable actor (dead remote
  // instance) exhausts the attempts and the activity is dropped — never stored
  // as an orphan. Without these options the inbox job would run only ONCE
  // (BullMQ's default), so a transient defer would lose the activity.
  await queue.add('inbox', data, {
    jobId: `inbox-${shortHash(`${data.verifiedActorUri}|${activityId}`)}`,
    attempts: INBOX_JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: INBOX_BACKOFF_BASE_MS },
  });
  return true;
}

/**
 * Enqueue a single outbound delivery. Dedupes on (targetInbox + activity id) so
 * the same activity to the same inbox is not double-queued. Returns false when
 * no queue is available (caller should fall back to the Mongo delivery queue).
 */
export async function enqueueDelivery(data: DeliveryJobData): Promise<boolean> {
  const queue = getDeliveryQueue();
  if (!queue) return false;

  const activityId =
    typeof data.activityJson.id === 'string' ? data.activityJson.id : undefined;
  // Without a stable activity id we cannot safely dedupe; fall back to letting
  // BullMQ assign a fresh id (every enqueue is a distinct delivery attempt).
  const jobId = activityId
    ? `delivery-${shortHash(`${data.targetInbox}|${activityId}`)}`
    : undefined;

  await queue.add('delivery', data, {
    ...(jobId ? { jobId } : {}),
    attempts: DELIVERY_JOB_ATTEMPTS,
    backoff: { type: DELIVERY_BACKOFF_STRATEGY },
  });
  return true;
}

/**
 * Enqueue a delivery with an explicit jobId. Used by the startup drain of the
 * Mongo `FederationDeliveryQueue` so re-running the drain is idempotent (the
 * same Mongo row maps to the same BullMQ jobId and won't double-deliver).
 */
export async function enqueueDeliveryWithJobId(
  data: DeliveryJobData,
  jobId: string,
): Promise<boolean> {
  const queue = getDeliveryQueue();
  if (!queue) return false;

  await queue.add('delivery', data, {
    jobId,
    attempts: DELIVERY_JOB_ATTEMPTS,
    backoff: { type: DELIVERY_BACKOFF_STRATEGY },
  });
  return true;
}

/**
 * Enqueue a sharing-cleanup job. Dedupes on (oxyUserId + nonce) so the same
 * toggle-off event is never double-queued; a distinct nonce per toggle (the
 * route mints `String(Date.now())`) lets a user who flips sharing off, on,
 * then off again enqueue a fresh cleanup each time. Returns false when no
 * queue is available (caller should run `runSharingCleanup` inline).
 */
export async function enqueueSharingCleanup(data: SharingCleanupJobData): Promise<boolean> {
  const queue = getSharingCleanupQueue();
  if (!queue) return false;

  await queue.add('sharing-cleanup', data, {
    jobId: `sharingcleanup-${shortHash(`${data.oxyUserId}|${data.nonce}`)}`,
    attempts: SHARING_CLEANUP_JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: SHARING_CLEANUP_BACKOFF_BASE_MS },
  });
  return true;
}
