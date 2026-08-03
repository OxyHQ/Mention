/**
 * Which `Notification.recipientId` values a signed-in person may read.
 *
 * For almost everybody the answer is "just their own id" and this module costs
 * one Redis GET. It exists for the one case where the answer is bigger: a
 * CHANNEL.
 *
 * THE PROBLEM IT SOLVES. A channel is an Oxy account (`kind: 'channel'`) that
 * authors its own posts, so every engagement notification for a channel post is
 * addressed to the channel — `createPostAuthorNotifications` derives the
 * recipient from `post.authorship`, whose owner IS the channel. But
 * `isActAsEligibleKind` refuses `channel`, so no session can ever be minted whose
 * subject is a channel, and `GET /notifications` filters on `req.user.id`. Those
 * rows were therefore written, indexed, TTL-reaped 90 days later, and read by
 * nobody. This module is the read-side expansion that makes them reachable.
 *
 * WHY THE EXPANSION HAPPENS AT READ TIME, AND NOT AS A WRITE-TIME FAN-OUT. Four
 * properties fall out of it, and each one is a bug avoided rather than a
 * preference:
 *
 *  1. **Authorization is never stale by more than this cache's TTL.** The
 *     recipient set is recomputed from the READER's own bearer at the moment
 *     they read. A fan-out would have to pick recipients when the event
 *     happened, from a roster captured earlier still — and a person removed from
 *     the channel in between would keep receiving its inbox with no mechanism
 *     that ever notices.
 *  2. **The write path is untouched, so it cannot be broken.** No new stage runs
 *     while a post/like/boost is being committed; there is nothing new to fail,
 *     and nothing to make fail softly.
 *  3. **No double-notify race.** `Notification` is unique on
 *     `{recipientId, actorId, type, entityId}` and `createNotification` is
 *     check-then-act, so two concurrent stages writing the same tuple is a real
 *     collision. Adding no stage adds no racer.
 *  4. **One row per event, not one per operator.** A channel with ten operators
 *     writes exactly what a person does.
 *
 * WHO RECEIVES, AND WHY IT IS NEVER THE WRITER. Every operator of the channel
 * receives every one of its notifications — the recipient set is a function of
 * the CHANNEL alone and never of the post. That is not a convenience: routing by
 * `Post.writtenByOxyUserId` would make the set of notifications each operator
 * receives a per-post partition that ENCODES authorship. On a two-operator
 * channel it is total — every post you were not notified about was written by
 * the other person — and `UserSettings.channel.signPosts` exists precisely to
 * make that disclosure a deliberate server-side decision. Nothing here reads
 * `writtenByOxyUserId`, and nothing here should.
 *
 * WHY MEMBERSHIP IS THE WHOLE RIGHT. A channel cannot be acted as, so there is
 * no stronger permission to ask for — `services/publishAsAccount` says the same
 * thing about publishing, and answers both questions through one shared
 * predicate so they cannot drift apart. The people who may speak as the channel
 * are the people who hear what is said back to it.
 */

import { config } from '../config';
import { getRedisClient } from '../utils/redis';
import { withRedisFallback } from '../utils/redisHelpers';
import { logger } from '../utils/logger';
import { listOperatedChannelIds, type OperatedAccountReader } from './publishAsAccount';

/**
 * Redis key prefix for a viewer's operated-channel set. Versioned so a change to
 * the stored VALUE shape can never be read back through the old assumptions.
 */
const INBOX_PREFIX = 'notifinbox:v1:';

/**
 * How long a resolved operated-channel set is trusted.
 *
 * This is an AUTHORIZATION answer, so the TTL is not a performance knob — it is
 * the exact window during which somebody removed from a channel in Oxy keeps
 * reading its notifications. Sixty seconds is the shortest value that still
 * collapses the burst of calls a single screen makes (the list and the badge are
 * separate endpoints, and both refetch on reconnect), and it is deliberately the
 * shortest TTL in `config.cache`.
 */
const INBOX_TTL_SECONDS = config.cache.notificationInboxTtlSeconds;

function keyFor(viewerId: string): string {
  return `${INBOX_PREFIX}${viewerId}`;
}

/**
 * The channel ids this viewer operates, cached.
 *
 * The cache stores ONLY the channel ids, never the finished recipient list — the
 * viewer's own id is re-prepended by {@link resolveNotificationInboxIds} on every
 * call, so no cache miss, corrupt entry, or Redis outage can cost somebody the
 * notifications addressed to them personally.
 *
 * A cache MISS resolves from Oxy; a resolve failure yields `[]` (see
 * {@link listOperatedChannelIds} on why fail-soft is the safe direction) and is
 * NOT written to the cache — an outage must not be pinned in for a TTL.
 */
async function loadOperatedChannelIds(
  viewerId: string,
  reader: OperatedAccountReader | undefined,
): Promise<string[]> {
  const redis = getRedisClient();
  const cached = await withRedisFallback(
    redis,
    async () => redis.get(keyFor(viewerId)),
    null,
    'notificationInboxGet',
  );

  if (typeof cached === 'string') {
    try {
      const parsed: unknown = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.every((id): id is string => typeof id === 'string')) {
        return parsed;
      }
    } catch {
      // A corrupt entry is a miss: fall through and re-resolve. Never throw —
      // this sits under every notification read.
    }
  }

  const resolved = await listOperatedChannelIds(reader);

  // `listOperatedChannelIds` fails soft to `[]`, which is indistinguishable here
  // from "operates no channels". Caching it either way is correct: an empty set
  // is the common truth, and a transient outage costs at most one TTL of the
  // channel rows — never access the reader should not have.
  await withRedisFallback(
    redis,
    async () => {
      await redis.setEx(keyFor(viewerId), INBOX_TTL_SECONDS, JSON.stringify(resolved));
    },
    undefined,
    'notificationInboxSet',
  ).catch((error: unknown) => {
    logger.debug('[NotificationInbox] cache store failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  });

  return resolved;
}

/**
 * Every `recipientId` this viewer's notification inbox covers: themselves, plus
 * each channel they operate.
 *
 * The viewer's own id is ALWAYS first and always present — an Oxy outage, a cold
 * Redis, or a caller with no bearer degrades a channel operator to exactly the
 * inbox they had before any of this existed, and degrades nobody else at all.
 *
 * Use the returned array with `recipientId: { $in: ... }`. Callers must not
 * re-derive it or add ids of their own: this is the only place that decides what
 * a person may read.
 */
export async function resolveNotificationInboxIds(
  viewerId: string,
  reader: OperatedAccountReader | undefined,
): Promise<string[]> {
  const channelIds = await loadOperatedChannelIds(viewerId, reader);
  // De-duplicated against the viewer defensively: an id can never be both a
  // person's own account and a channel they operate, but `$in` with a repeat
  // would be a silently odd query to debug.
  return [viewerId, ...channelIds.filter((id) => id !== viewerId)];
}
