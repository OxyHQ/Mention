/**
 * "Somebody you subscribed to posted" — the one fan-out whose size is the
 * author's popularity.
 *
 * It runs as a BullMQ job, so a task that stops mid-way (every deploy stops
 * some) leaves the rest to be retried instead of losing it with the process.
 * Redelivery is safe: `notifications_dedup_key` makes a repeated recipient a
 * timestamp refresh, never a second notification or push.
 *
 * Without a usable queue — no Redis, or one that does not answer — it runs in
 * process as before: a notice that might be lost to a restart is better than one
 * that is never written.
 */

import { and, asc, eq, gt } from 'drizzle-orm';
import { PostVisibility } from '@mention/shared-types';
import { getDb } from '../../db/postgres';
import { postSubscriptions } from '../../db/schema/engagement';
import { loadPostRecord } from '../../db/posts/postRepository';
import type { PostRecord } from '../../db/posts/postRecord';
import { enqueueSubscriberNotifications } from '../../queue/producers';
import type { SubscriberNotificationJobData } from '../../queue/types';
import {
  createBatchNotifications,
  createBatchNotificationsStrict,
} from '../../utils/notificationUtils';
import { logger } from '../../utils/logger';

/** Subscribers read, and notified, at a time. */
export const SUBSCRIBER_NOTIFICATION_BATCH = 500;
/** How long an enqueue may take before the fan-out runs in process instead. */
export const SUBSCRIBER_ENQUEUE_TIMEOUT_MS = 5_000;

/**
 * Account subscriptions are an opt-in to PUBLIC publication announcements,
 * not permission to read an author's unpublished or restricted posts.
 */
export function isSubscriberNotificationEligible(
  post: Pick<PostRecord, 'status' | 'visibility'>,
): boolean {
  return post.status === 'published' && post.visibility === PostVisibility.PUBLIC;
}

/**
 * Notify every subscriber of `authorId` about `postId`, one keyset page at a
 * time so an author's audience is never held in memory at once. With `strict`, a
 * failed write rejects so the job retries.
 */
export async function deliverSubscriberNotifications(
  { postId, authorId }: SubscriberNotificationJobData,
  { strict = false }: { strict?: boolean } = {},
): Promise<void> {
  let after: string | undefined;
  for (;;) {
    const page = await getDb()
      .select({ subscriberId: postSubscriptions.subscriberId })
      .from(postSubscriptions)
      .where(
        and(
          eq(postSubscriptions.authorId, authorId),
          after === undefined ? undefined : gt(postSubscriptions.subscriberId, after),
        ),
      )
      .orderBy(asc(postSubscriptions.subscriberId))
      .limit(SUBSCRIBER_NOTIFICATION_BATCH);

    // The author never notifies themselves.
    const notifications = page
      .filter(({ subscriberId }) => subscriberId !== authorId)
      .map(({ subscriberId }) => ({
        recipientId: subscriberId,
        actorId: authorId,
        type: 'post' as const,
        entityId: postId,
        entityType: 'post' as const,
      }));
    if (notifications.length > 0) {
      if (strict) await createBatchNotificationsStrict(notifications);
      else await createBatchNotifications(notifications, true);
    }

    if (page.length < SUBSCRIBER_NOTIFICATION_BATCH) return;
    after = page[page.length - 1].subscriberId;
  }
}

/** Hand a newly published post's fan-out to the queue, or run it here. */
export async function announcePostToSubscribers(job: SubscriberNotificationJobData): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queued = await Promise.race([
    enqueueSubscriberNotifications(job),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), SUBSCRIBER_ENQUEUE_TIMEOUT_MS);
    }),
  ])
    .catch((error: unknown) => {
      logger.warn('Subscriber notifications could not be queued', { error });
      return false;
    })
    .finally(() => clearTimeout(timer));
  if (!queued) await deliverSubscriberNotifications(job);
}

/**
 * The queued job. The post is read again: one deleted, restricted or made
 * private while the job waited is no longer announced.
 */
export async function runSubscriberNotificationJob(
  job: SubscriberNotificationJobData,
): Promise<void> {
  const post = await loadPostRecord(job.postId);
  if (!post || !isSubscriberNotificationEligible(post)) return;
  await deliverSubscriberNotifications(job, { strict: true });
}
