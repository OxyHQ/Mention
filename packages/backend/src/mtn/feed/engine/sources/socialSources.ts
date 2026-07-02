/**
 * Social-graph + content source modules (Phase 2).
 *
 * Each is a {@link SourceModule} producing a bounded candidate set derived from
 * the viewer's follow / engagement graph or from content classification. They
 * follow the Phase 1 authoring pattern exactly: a single Mongo query selecting
 * `FEED_FIELDS`, chronological `_id`-sort + `ChronoCursor` for timeline sources,
 * `.maxTimeMS(5000)`, capped to `cap`, and soft-failing to `[]`. No new ranking
 * or hydration logic lives here — the engine wraps them.
 */

import mongoose from 'mongoose';
import { PostType, PostVisibility, MtnConfig } from '@mention/shared-types';
import { Post } from '../../../../models/Post';
import Like from '../../../../models/Like';
import { EntityFollow } from '../../../../models/EntityFollow';
import { StarterPack } from '../../../../models/StarterPack';
import { FEED_FIELDS } from '../../FeedAPI';
import { ChronoCursor } from '../../CursorBuilder';
import { logger } from '../../../../utils/logger';
import type { CandidatePost, FeedEngineContext, SourceModule } from '../types';

/** Chronological fetch shared by the timeline-style social sources. */
async function fetchChrono(match: Record<string, unknown>, cursor: string | undefined, cap: number): Promise<CandidatePost[]> {
  ChronoCursor.applyToQuery(match, cursor);
  return (await Post.find(match)
    .select(FEED_FIELDS)
    .sort({ _id: -1 })
    .limit(cap)
    .maxTimeMS(5000)
    .lean()) as unknown as CandidatePost[];
}

/**
 * `friendsEngaged`: posts the viewer's follows liked or boosted in the recent
 * window, ranked by how many follows engaged with each ("Popular with Friends").
 * Pre-orders by friend-engagement count (stamped as `finalScore`) so the ranked
 * definition sees the most-engaged candidates; the engine re-ranks with its
 * engagement/recency signals. Excludes the viewer's own posts and boosts.
 */
export const friendsEngagedSource: SourceModule = {
  id: 'friendsEngaged',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) => {
    const followingIds = ctx.followingIds ?? [];
    if (followingIds.length === 0) return [];

    const windowStart = new Date(Date.now() - MtnConfig.feed.candidateSources.recencyWindowMs);

    const likeGroups = (await Like.aggregate([
      { $match: { userId: { $in: followingIds }, value: 1, createdAt: { $gte: windowStart } } },
      { $group: { _id: '$postId', friendCount: { $sum: 1 } } },
      { $sort: { friendCount: -1 } },
      { $limit: cap },
    ]).option({ maxTimeMS: 5000 })) as Array<{ _id: unknown; friendCount: number }>;

    const boostDocs = (await Post.find({
      type: PostType.BOOST,
      oxyUserId: { $in: followingIds },
      createdAt: { $gte: windowStart },
    })
      .select('boostOf')
      .limit(cap)
      .maxTimeMS(5000)
      .lean()) as Array<{ boostOf?: string }>;

    const friendCountByPost = new Map<string, number>();
    for (const group of likeGroups) {
      const id = group._id ? String(group._id) : '';
      if (id) friendCountByPost.set(id, (friendCountByPost.get(id) ?? 0) + group.friendCount);
    }
    for (const boost of boostDocs) {
      if (boost.boostOf) {
        friendCountByPost.set(boost.boostOf, (friendCountByPost.get(boost.boostOf) ?? 0) + 1);
      }
    }
    if (friendCountByPost.size === 0) return [];

    const objectIds = Array.from(friendCountByPost.keys())
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));
    if (objectIds.length === 0) return [];

    const match: Record<string, unknown> = {
      _id: { $in: objectIds },
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      $and: [{ $or: [{ boostOf: null }, { boostOf: { $exists: false } }] }],
    };
    if (ctx.currentUserId) match.oxyUserId = { $ne: ctx.currentUserId };

    const posts = (await Post.find(match)
      .select(FEED_FIELDS)
      .maxTimeMS(5000)
      .lean()) as unknown as CandidatePost[];

    return posts
      .map((post) => {
        post.finalScore = friendCountByPost.get(String(post._id)) ?? 0;
        return post;
      })
      .sort((a, b) => {
        const diff = (b.finalScore ?? 0) - (a.finalScore ?? 0);
        if (diff !== 0) return diff;
        const at = new Date((a.createdAt as Date | string | undefined) ?? 0).getTime();
        const bt = new Date((b.createdAt as Date | string | undefined) ?? 0).getTime();
        return bt - at;
      })
      .slice(0, cap);
  },
};

/**
 * `quotes`: quote posts referencing a specific post (`params.postId`) and/or
 * authored by a set of authors (`params.authorIds`). Chronological.
 */
export const quotesSource: SourceModule = {
  id: 'quotes',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, params, cap) => {
    const postId = typeof params.postId === 'string' ? params.postId : '';
    const authorIds = Array.isArray(params.authorIds) ? (params.authorIds as string[]) : [];
    if (!postId && authorIds.length === 0) return [];

    const match: Record<string, unknown> = { visibility: PostVisibility.PUBLIC, status: 'published' };
    const conditions: Record<string, unknown>[] = [];
    if (postId) conditions.push({ quoteOf: postId });
    if (authorIds.length > 0) conditions.push({ quoteOf: { $ne: null }, oxyUserId: { $in: authorIds } });

    if (conditions.length === 1) {
      Object.assign(match, conditions[0]);
    } else {
      match.$and = [{ $or: conditions }];
    }

    return fetchChrono(match, ctx.cursor, cap);
  },
};

/** `repliesFromFollows`: replies authored by the viewer's follows (conversation). */
export const repliesFromFollowsSource: SourceModule = {
  id: 'repliesFromFollows',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) => {
    const followingIds = ctx.followingIds ?? [];
    if (followingIds.length === 0) return [];

    return fetchChrono(
      {
        oxyUserId: { $in: followingIds },
        parentPostId: { $ne: null },
        visibility: PostVisibility.PUBLIC,
        status: 'published',
      },
      ctx.cursor,
      cap,
    );
  },
};

/**
 * `boostsFromFollows`: boost (repost) posts authored by the viewer's follows.
 * Boosts carry an intentionally empty body — any definition using this source
 * MUST hydrate at `maxDepth:1` (see the boost-hydration gotcha) or they render
 * blank.
 */
export const boostsFromFollowsSource: SourceModule = {
  id: 'boostsFromFollows',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) => {
    const followingIds = ctx.followingIds ?? [];
    if (followingIds.length === 0) return [];

    return fetchChrono(
      { type: PostType.BOOST, oxyUserId: { $in: followingIds }, status: 'published' },
      ctx.cursor,
      cap,
    );
  },
};

/** `mentionsOfMe`: posts whose `mentions` array contains the viewer. */
export const mentionsOfMeSource: SourceModule = {
  id: 'mentionsOfMe',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) => {
    if (!ctx.currentUserId) return [];

    return fetchChrono(
      {
        mentions: ctx.currentUserId,
        visibility: { $in: [PostVisibility.PUBLIC, PostVisibility.FOLLOWERS_ONLY] },
        status: 'published',
      },
      ctx.cursor,
      cap,
    );
  },
};

/**
 * `hashtagFollows`: posts carrying any hashtag the viewer follows (resolved via
 * `EntityFollow` `entityType:'hashtag'`).
 */
export const hashtagFollowsSource: SourceModule = {
  id: 'hashtagFollows',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) => {
    if (!ctx.currentUserId) return [];

    let tags: string[] = [];
    try {
      tags = await EntityFollow.distinct('entityId', {
        userId: ctx.currentUserId,
        entityType: 'hashtag',
      });
    } catch (error) {
      logger.warn('[hashtagFollows source] Failed to load followed hashtags', error);
      return [];
    }

    const normalized = Array.from(new Set(tags.map((t) => t.toLowerCase()).filter(Boolean)));
    if (normalized.length === 0) return [];

    return fetchChrono(
      { hashtags: { $in: normalized }, visibility: PostVisibility.PUBLIC, status: 'published' },
      ctx.cursor,
      cap,
    );
  },
};

/** `starterPack`: posts by the members of a StarterPack (`params.packId`). */
export const starterPackSource: SourceModule = {
  id: 'starterPack',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, params, cap) => {
    const packId = typeof params.packId === 'string' ? params.packId : '';
    if (!packId || !mongoose.Types.ObjectId.isValid(packId)) return [];

    let memberIds: string[] = [];
    try {
      const pack = await StarterPack.findById(packId).lean();
      memberIds = pack?.memberOxyUserIds ?? [];
    } catch (error) {
      logger.warn('[starterPack source] Failed to load starter pack', { packId, error });
      return [];
    }
    if (memberIds.length === 0) return [];

    return fetchChrono(
      { oxyUserId: { $in: memberIds }, visibility: PostVisibility.PUBLIC, status: 'published' },
      ctx.cursor,
      cap,
    );
  },
};

/**
 * `onThisDay`: nostalgia — the viewer's own posts (or the viewer + their follows
 * when `params.scope === 'follows'`) from earlier years on today's month/day.
 * Uses a `$expr` month/day match, so it is bounded by the author-id filter.
 */
export const onThisDaySource: SourceModule = {
  id: 'onThisDay',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, params, cap) => {
    if (!ctx.currentUserId) return [];

    const scope = params.scope === 'follows' ? 'follows' : 'self';
    const authorClause: Record<string, unknown> =
      scope === 'follows'
        ? { oxyUserId: { $in: Array.from(new Set([ctx.currentUserId, ...(ctx.followingIds ?? [])])) } }
        : { oxyUserId: ctx.currentUserId };

    const now = new Date();
    const match: Record<string, unknown> = {
      ...authorClause,
      status: 'published',
      $expr: {
        $and: [
          { $eq: [{ $month: '$createdAt' }, now.getUTCMonth() + 1] },
          { $eq: [{ $dayOfMonth: '$createdAt' }, now.getUTCDate()] },
          { $lt: [{ $year: '$createdAt' }, now.getUTCFullYear()] },
        ],
      },
    };

    return fetchChrono(match, ctx.cursor, cap);
  },
};

export const socialSourceModules: SourceModule[] = [
  friendsEngagedSource,
  quotesSource,
  repliesFromFollowsSource,
  boostsFromFollowsSource,
  mentionsOfMeSource,
  hashtagFollowsSource,
  starterPackSource,
  onThisDaySource,
];
