/**
 * List Subscription Service
 *
 * Owns the "follow a list" (subscribe) domain boundary. Following a list is a
 * SUBSCRIPTION: the subscriber sees posts from the list's members in their main
 * feed WITHOUT establishing any follow relationship with those members. It never
 * touches follower/following counts.
 *
 * Two responsibilities:
 *  1. Maintain `AccountList.subscriberCount` atomically when a 'list' EntityFollow
 *     is created/removed.
 *  2. Resolve the deduplicated set of member oxyUserIds across all lists a user
 *     subscribes to, for merging into the main feed's author candidate set.
 */

import mongoose from 'mongoose';
import { EntityFollow } from '../models/EntityFollow';
import AccountList from '../models/AccountList';
import { logger } from '../utils/logger';

/** EntityFollow.entityType value for list subscriptions. */
export const LIST_ENTITY_TYPE = 'list';

/**
 * Upper bound on the number of distinct lists a user's subscriptions are resolved
 * from when building the main feed. A user may subscribe to many lists; resolving
 * an unbounded number would balloon the feed candidate query. Truncation is logged.
 */
export const MAX_SUBSCRIBED_LISTS_FOR_FEED = 200;

/**
 * Upper bound on the number of extra author ids contributed to the main feed from
 * subscribed lists. Keeps the `$in` author set (and the resulting Mongo query)
 * within sane limits even when subscribed lists are very large. Truncation is logged.
 */
export const MAX_SUBSCRIBED_LIST_AUTHORS_FOR_FEED = 5000;

export class ListSubscriptionService {
  /**
   * Increment a list's subscriber count by one. Called when a 'list' EntityFollow
   * is successfully created. Best-effort: a count drift must never break the follow
   * operation, so failures are logged rather than thrown.
   */
  async incrementSubscriberCount(listId: string): Promise<void> {
    if (!mongoose.Types.ObjectId.isValid(listId)) return;
    try {
      await AccountList.updateOne({ _id: listId }, { $inc: { subscriberCount: 1 } });
    } catch (error) {
      logger.error('[ListSubscriptionService] Failed to increment subscriberCount', { listId, error });
    }
  }

  /**
   * Decrement a list's subscriber count by one, flooring at zero. Called when a
   * 'list' EntityFollow is removed. Best-effort, same rationale as increment.
   */
  async decrementSubscriberCount(listId: string): Promise<void> {
    if (!mongoose.Types.ObjectId.isValid(listId)) return;
    try {
      // Floor at zero: only decrement when the current value is positive.
      await AccountList.updateOne(
        { _id: listId, subscriberCount: { $gt: 0 } },
        { $inc: { subscriberCount: -1 } },
      );
    } catch (error) {
      logger.error('[ListSubscriptionService] Failed to decrement subscriberCount', { listId, error });
    }
  }

  /**
   * Resolve the deduplicated set of member oxyUserIds across all lists the given
   * user subscribes to. Batches the EntityFollow + AccountList lookups (no N+1),
   * and caps both the number of lists and the number of resolved authors, logging
   * when either bound truncates the result.
   *
   * @returns deduplicated member oxyUserIds (excludes the empty set on no subscriptions)
   */
  async getSubscribedListMemberIds(userId: string): Promise<string[]> {
    const listIds = await EntityFollow.find(
      { userId, entityType: LIST_ENTITY_TYPE },
      { entityId: 1 },
    )
      .limit(MAX_SUBSCRIBED_LISTS_FOR_FEED + 1)
      .lean();

    if (listIds.length === 0) return [];

    const truncatedLists = listIds.length > MAX_SUBSCRIBED_LISTS_FOR_FEED;
    if (truncatedLists) {
      logger.warn('[ListSubscriptionService] Subscribed-list count exceeds cap; truncating', {
        userId,
        subscribedLists: listIds.length,
        cap: MAX_SUBSCRIBED_LISTS_FOR_FEED,
      });
    }

    const objectIds = listIds
      .slice(0, MAX_SUBSCRIBED_LISTS_FOR_FEED)
      .map((doc) => doc.entityId)
      .filter((id): id is string => typeof id === 'string' && mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    if (objectIds.length === 0) return [];

    const lists = await AccountList.find(
      { _id: { $in: objectIds } },
      { memberOxyUserIds: 1 },
    ).lean();

    const memberIds = new Set<string>();
    let truncatedAuthors = false;
    for (const list of lists) {
      for (const memberId of list.memberOxyUserIds || []) {
        if (memberIds.size >= MAX_SUBSCRIBED_LIST_AUTHORS_FOR_FEED) {
          truncatedAuthors = true;
          break;
        }
        memberIds.add(memberId);
      }
      if (truncatedAuthors) break;
    }

    if (truncatedAuthors) {
      logger.warn('[ListSubscriptionService] Subscribed-list author count exceeds cap; truncating', {
        userId,
        cap: MAX_SUBSCRIBED_LIST_AUTHORS_FOR_FEED,
      });
    }

    return Array.from(memberIds);
  }
}

export const listSubscriptionService = new ListSubscriptionService();
