/**
 * List Subscription Service
 *
 * Owns the "follow a list" (subscribe) domain boundary. Following a list is a
 * SUBSCRIPTION: the subscriber sees posts from the list's members in their main
 * feed WITHOUT establishing any follow relationship with those members. It never
 * touches follower/following counts.
 *
 * Two responsibilities:
 *  1. Maintain `account_lists.subscriber_count` atomically when a 'list'
 *     `entity_follows` row is created/removed.
 *  2. Resolve the deduplicated set of member oxyUserIds across all lists a user
 *     subscribes to, for merging into the main feed's author candidate set.
 */

import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { accountListMembers, accountLists } from '../db/schema/lists';
import { entityFollows } from '../db/schema/engagement';
import { canViewList } from './listAccess';
import { logger } from '../utils/logger';

/** `entity_follows.entity_type` value for list subscriptions. */
export const LIST_ENTITY_TYPE = 'list';

/**
 * Upper bound on the number of distinct lists a user's subscriptions are resolved
 * from when building the main feed. A user may subscribe to many lists; resolving
 * an unbounded number would balloon the feed candidate query. Truncation is logged.
 */
export const MAX_SUBSCRIBED_LISTS_FOR_FEED = 200;

/**
 * Upper bound on the number of extra author ids contributed to the main feed from
 * subscribed lists. Keeps the author set (and the resulting feed query) within
 * sane limits even when subscribed lists are very large. Truncation is logged.
 */
export const MAX_SUBSCRIBED_LIST_AUTHORS_FOR_FEED = 5000;

export class ListSubscriptionService {
  /**
   * Increment a list's subscriber count by one. Called when a 'list' entity
   * follow is successfully created. Best-effort: a count drift must never break
   * the follow operation, so failures are logged rather than thrown.
   *
   * No id-shape guard. The Mongoose version returned early for anything that was
   * not 24-char hex, which after the cutover would have silently skipped the
   * maintenance for every list created since — the counter would drift down
   * forever with nothing logged. An id that names no list simply updates no row.
   */
  async incrementSubscriberCount(listId: string): Promise<void> {
    try {
      await getDb()
        .update(accountLists)
        .set({ subscriberCount: sql`${accountLists.subscriberCount} + 1` })
        .where(eq(accountLists.id, listId));
    } catch (error) {
      logger.error('[ListSubscriptionService] Failed to increment subscriberCount', { listId, error });
    }
  }

  /**
   * Decrement a list's subscriber count by one, flooring at zero. Called when a
   * 'list' entity follow is removed. Best-effort, same rationale as increment,
   * and the same reason for carrying no id-shape guard.
   */
  async decrementSubscriberCount(listId: string): Promise<void> {
    try {
      // Floor at zero in the PREDICATE, not with `greatest(...)`: a row already
      // at zero must not be touched at all, which is what Mongo's
      // `{ subscriberCount: { $gt: 0 } }` filter did — and `updated_at` is a sort
      // key for `GET /lists`, so a no-op write would reshuffle the list order.
      // `account_lists_subscriber_count_check` refuses a negative value anyway.
      await getDb()
        .update(accountLists)
        .set({ subscriberCount: sql`${accountLists.subscriberCount} - 1` })
        .where(and(eq(accountLists.id, listId), gt(accountLists.subscriberCount, 0)));
    } catch (error) {
      logger.error('[ListSubscriptionService] Failed to decrement subscriberCount', { listId, error });
    }
  }

  /**
   * Resolve the deduplicated set of member oxyUserIds across all lists the given
   * user subscribes to. Three batched queries (no N+1), and both the number of
   * lists and the number of resolved authors are capped, logging when either
   * bound truncates the result.
   *
   * Re-checks list visibility per row rather than trusting the subscription. The
   * write path gates a new subscription, but a subscription outlives the state
   * it was created under: a list can be flipped to private after the fact, and
   * rows predating the gate are already in the table. Since membership is
   * inferable from whose posts land in the feed, the check has to be here — at
   * the point of use — not only at the point of subscription.
   *
   * @returns deduplicated member oxyUserIds (empty on no subscriptions)
   */
  async getSubscribedListMemberIds(userId: string): Promise<string[]> {
    const db = getDb();

    // Ordered so truncation is deterministic: the OLDEST subscriptions are the
    // ones that survive the cap. Mongo took whatever order the collection scan
    // produced, which made a truncated feed differ run to run.
    const subscriptions = await db
      .select({ entityId: entityFollows.entityId })
      .from(entityFollows)
      .where(and(eq(entityFollows.userId, userId), eq(entityFollows.entityType, LIST_ENTITY_TYPE)))
      .orderBy(asc(entityFollows.createdAt), asc(entityFollows.id))
      .limit(MAX_SUBSCRIBED_LISTS_FOR_FEED + 1);

    if (subscriptions.length === 0) return [];

    if (subscriptions.length > MAX_SUBSCRIBED_LISTS_FOR_FEED) {
      logger.warn('[ListSubscriptionService] Subscribed-list count exceeds cap; truncating', {
        userId,
        subscribedLists: subscriptions.length,
        cap: MAX_SUBSCRIBED_LISTS_FOR_FEED,
      });
    }

    const listIds = subscriptions
      .slice(0, MAX_SUBSCRIBED_LISTS_FOR_FEED)
      .map((row) => row.entityId);

    const lists = await db
      .select({
        id: accountLists.id,
        isPublic: accountLists.isPublic,
        ownerOxyUserId: accountLists.ownerOxyUserId,
      })
      .from(accountLists)
      .where(inArray(accountLists.id, listIds));

    const visibleListIds = lists.filter((list) => canViewList(list, userId)).map((list) => list.id);
    if (visibleListIds.length === 0) return [];

    // DISTINCT in the database rather than a `Set` in JS, so the cap is a real
    // work bound rather than a bound applied after everything was already read.
    // Ordered by member id purely so a truncated result is REPRODUCIBLE — which
    // one of two members survives the cap is arbitrary either way, but it must
    // not change between two identical requests.
    const members = await db
      .selectDistinct({ oxyUserId: accountListMembers.oxyUserId })
      .from(accountListMembers)
      .where(inArray(accountListMembers.listId, visibleListIds))
      .orderBy(asc(accountListMembers.oxyUserId))
      .limit(MAX_SUBSCRIBED_LIST_AUTHORS_FOR_FEED + 1);

    if (members.length > MAX_SUBSCRIBED_LIST_AUTHORS_FOR_FEED) {
      logger.warn('[ListSubscriptionService] Subscribed-list author count exceeds cap; truncating', {
        userId,
        cap: MAX_SUBSCRIBED_LIST_AUTHORS_FOR_FEED,
      });
      return members.slice(0, MAX_SUBSCRIBED_LIST_AUTHORS_FOR_FEED).map((row) => row.oxyUserId);
    }

    return members.map((row) => row.oxyUserId);
  }
}

export const listSubscriptionService = new ListSubscriptionService();
