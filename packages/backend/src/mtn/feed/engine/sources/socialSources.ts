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
import UserSettings from '../../../../models/UserSettings';
import { FEED_FIELDS } from '../../FeedAPI';
import { ChronoCursor } from '../../CursorBuilder';
import { DISCOVERY_SAFE_MATCH } from '../../feedSafety';
import { logger } from '../../../../utils/logger';
import { ProfileVisibility, requiresAccessCheck } from '../../../../utils/privacyHelpers';
import type { CandidatePost, FeedEngineContext, SourceModule } from '../types';

/**
 * A "new voice" author must have at most this many recent posts to qualify as
 * low-volume in the local approximation. True account-age / follower-count
 * gating is Phase-4-blocked (needs Oxy user data).
 */
const NEW_VOICE_MAX_RECENT_POSTS = 20;

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

/** Fetch posts by id, preserving the given id order (used by the pre-ranked aggregate sources). */
async function fetchPostsByIds(ids: mongoose.Types.ObjectId[]): Promise<CandidatePost[]> {
  if (ids.length === 0) return [];
  const posts = (await Post.find({ _id: { $in: ids } })
    .select(FEED_FIELDS)
    .maxTimeMS(5000)
    .lean()) as unknown as CandidatePost[];
  const order = new Map(ids.map((id, i) => [String(id), i]));
  return posts.sort((a, b) => (order.get(String(a._id)) ?? 0) - (order.get(String(b._id)) ?? 0));
}

/** Filter author ids through the same profile-visibility gate used by profile feeds. */
async function filterProfileVisibleAuthorIds(ctx: FeedEngineContext, authorIds: string[]): Promise<string[]> {
  const uniqueAuthorIds = Array.from(new Set(authorIds.filter((id) => typeof id === 'string' && id.length > 0)));
  if (uniqueAuthorIds.length === 0) return [];

  const followAuthorizedIds = new Set([ctx.currentUserId, ...(ctx.followingIds ?? [])].filter(Boolean));
  const settings = await UserSettings.find(
    { oxyUserId: { $in: uniqueAuthorIds } },
    { oxyUserId: 1, 'privacy.profileVisibility': 1 },
  ).lean();
  const visibilityByAuthor = new Map(
    settings.map((row) => [
      row.oxyUserId,
      row.privacy?.profileVisibility ?? ProfileVisibility.PUBLIC,
    ]),
  );

  return uniqueAuthorIds.filter((authorId) => {
    const visibility = visibilityByAuthor.get(authorId) ?? ProfileVisibility.PUBLIC;
    return !requiresAccessCheck(visibility) || followAuthorizedIds.has(authorId);
  });
}

/** Standard engagement composite (mirrors the discovery aggregations). */
function engagementScoreExpr() {
  const cfg = MtnConfig.ranking.engagement;
  return {
    $add: [
      { $multiply: [{ $ifNull: ['$stats.likesCount', 0] }, cfg.likeWeight] },
      { $multiply: [{ $ifNull: ['$stats.boostsCount', 0] }, cfg.boostWeight] },
      { $multiply: [{ $ifNull: ['$stats.commentsCount', 0] }, cfg.commentWeight] },
    ],
  };
}

/** Escape a domain for safe embedding in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

/** `questions`: posts classified with `intent === 'question'` (Q&A discovery). */
export const questionsSource: SourceModule = {
  id: 'questions',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, _params, cap) =>
    fetchChrono(
      { 'postClassification.intent': 'question', visibility: PostVisibility.PUBLIC, status: 'published' },
      ctx.cursor,
      cap,
    ),
};

/** `news`: posts classified with `intent === 'news'` or a `news` topic. */
export const newsSource: SourceModule = {
  id: 'news',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, _params, cap) =>
    fetchChrono(
      {
        visibility: PostVisibility.PUBLIC,
        status: 'published',
        $and: [{ $or: [{ 'postClassification.intent': 'news' }, { 'postClassification.topics': 'news' }] }],
      },
      ctx.cursor,
      cap,
    ),
};

/**
 * `instance`: posts from a specific fediverse instance (`params.domain`), or
 * local-only posts when `params.domain === 'local'`.
 *
 * NOTE (data-model gap): Post has no indexed `federation.instanceDomain` field —
 * only `federation.actorUri`. Remote-instance matching therefore uses an anchored
 * host-prefix regex on `federation.actorUri` (correct but not index-served).
 * Phase-4 optimization: denormalize + index `federation.instanceDomain` at ingest.
 */
export const instanceSource: SourceModule = {
  id: 'instance',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, params, cap) => {
    const domain = typeof params.domain === 'string' ? params.domain.trim().toLowerCase() : '';
    if (!domain) return [];

    const match: Record<string, unknown> = { visibility: PostVisibility.PUBLIC, status: 'published' };
    if (domain === 'local') {
      match.$and = [{ $or: [{ federation: null }, { federation: { $exists: false } }] }];
    } else {
      match['federation.actorUri'] = new RegExp(`^https?://${escapeRegExp(domain)}(?::\\d+)?/`, 'i');
    }
    return fetchChrono(match, ctx.cursor, cap);
  },
};

/**
 * `links`: posts linking to a specific domain (`params.domain`) — "news from
 * domain X".
 *
 * NOTE (data-model gap): Post has no indexed link-host field; link previews are
 * cached in Redis, not stored on the post. Matching therefore scans the cited
 * `content.sources[].url` and inline `content.text` links with a host-boundary
 * regex (correct but not index-served). Phase-4 optimization: persist + index a
 * normalized `content.linkHosts` array at ingest.
 */
export const linksSource: SourceModule = {
  id: 'links',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, params, cap) => {
    const domain = typeof params.domain === 'string' ? params.domain.trim().toLowerCase() : '';
    if (!domain) return [];

    const hostRegex = new RegExp(`https?://(?:[a-z0-9-]+\\.)*${escapeRegExp(domain)}(?:[/:?#]|\\s|$)`, 'i');
    const match: Record<string, unknown> = {
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      $and: [{ $or: [{ 'content.sources.url': hostRegex }, { 'content.text': hostRegex }] }],
    };
    return fetchChrono(match, ctx.cursor, cap);
  },
};

/**
 * `newVoices`: cold-start discovery of accounts new to the network.
 *
 * NOTE (data-model gap): true "new account" detection (account creation age +
 * follower count) requires Oxy user data and is Phase-4-blocked. This local
 * approximation surfaces LOW-VOLUME authors active in the recency window (few
 * recent posts), earliest-arriving first — a bounded proxy. Fetches each
 * qualifying author's latest post. Always SFW for safe-for-work viewers.
 */
export const newVoicesSource: SourceModule = {
  id: 'newVoices',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, _params, cap) => {
    const allowSensitive = ctx.showSensitiveContent === true;
    const windowStart = new Date(Date.now() - MtnConfig.feed.candidateSources.recencyWindowMs);

    const match: Record<string, unknown> = {
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      createdAt: { $gte: windowStart },
      ...(allowSensitive ? {} : DISCOVERY_SAFE_MATCH),
      $and: [
        { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
        { $or: [{ boostOf: null }, { boostOf: { $exists: false } }] },
      ],
    };

    const groups = (await Post.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$oxyUserId',
          latestPostId: { $max: '$_id' },
          recentCount: { $sum: 1 },
          firstPostAt: { $min: '$createdAt' },
        },
      },
      { $match: { recentCount: { $lte: NEW_VOICE_MAX_RECENT_POSTS } } },
      { $sort: { firstPostAt: -1 } },
      { $limit: cap },
    ]).option({ maxTimeMS: 5000 })) as Array<{ latestPostId: unknown }>;

    const ids = groups
      .map((g) => g.latestPostId)
      .filter((id): id is mongoose.Types.ObjectId => id instanceof mongoose.Types.ObjectId);
    return fetchPostsByIds(ids);
  },
};

/**
 * `topReplies`: the highest-engagement replies in the recency window ("best
 * replies"). Aggregates an engagement composite to rank, then fetches the ranked
 * posts preserving that order. Always SFW for safe-for-work viewers.
 */
export const topRepliesSource: SourceModule = {
  id: 'topReplies',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, _params, cap) => {
    const allowSensitive = ctx.showSensitiveContent === true;
    const windowStart = new Date(Date.now() - MtnConfig.feed.candidateSources.recencyWindowMs);

    const match: Record<string, unknown> = {
      parentPostId: { $ne: null },
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      createdAt: { $gte: windowStart },
      ...(allowSensitive ? {} : DISCOVERY_SAFE_MATCH),
    };

    const ranked = (await Post.aggregate([
      { $match: match },
      { $addFields: { engagementScore: engagementScoreExpr() } },
      { $sort: { engagementScore: -1, _id: -1 } },
      { $limit: cap },
      { $project: { _id: 1 } },
    ]).option({ maxTimeMS: 5000 })) as Array<{ _id: unknown }>;

    const ids = ranked
      .map((r) => r._id)
      .filter((id): id is mongoose.Types.ObjectId => id instanceof mongoose.Types.ObjectId);
    return fetchPostsByIds(ids);
  },
};

/**
 * `friendsOfFriends`: posts by accounts the viewer's follows follow (but the
 * viewer does not) — social-graph expansion. `ctx.fofIds` is populated by the
 * controller (via the Oxy follows-of-follows endpoint, guarded optional call)
 * ONLY for the Friends-of-Friends feed; returns `[]` when it is empty (any other
 * context, or a viewer whose network yields none). PUBLIC-only, and excludes
 * authors whose profile privacy would deny the viewer's normal profile access.
 */
export const friendsOfFriendsSource: SourceModule = {
  id: 'friendsOfFriends',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) => {
    const visibleFofIds = await filterProfileVisibleAuthorIds(ctx, ctx.fofIds ?? []);
    if (visibleFofIds.length === 0) return [];

    return fetchChrono(
      { oxyUserId: { $in: visibleFofIds }, visibility: PostVisibility.PUBLIC, status: 'published' },
      ctx.cursor,
      cap,
    );
  },
};

/**
 * `curated`: editorially-promoted posts (`curated === true`). The `curated` flag
 * is sparse on Post; no writer ships in Phase 2 (admin setter deferred), so this
 * source is inert until posts are promoted.
 */
export const curatedSource: SourceModule = {
  id: 'curated',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, _params, cap) =>
    fetchChrono({ curated: true, visibility: PostVisibility.PUBLIC, status: 'published' }, ctx.cursor, cap),
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
  questionsSource,
  newsSource,
  instanceSource,
  linksSource,
  newVoicesSource,
  topRepliesSource,
  friendsOfFriendsSource,
  curatedSource,
];
