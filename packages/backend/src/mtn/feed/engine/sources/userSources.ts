/**
 * User-oriented source modules — wrap the Hashtag, Author, and Saved feed
 * queries plus the `accounts` (custom-feed author list) source and the
 * `mutuals` placeholder. Each reproduces the pre-existing feed's exact query.
 */

import mongoose from 'mongoose';
import { isAuthorFeedFilter, PostType, PostVisibility } from '@mention/shared-types';
import { Post } from '../../../../models/Post';
import { Lane } from '../../../../models/Lane';
import UserSettings from '../../../../models/UserSettings';
import { ProfileVisibility, requiresAccessCheck } from '../../../../utils/privacyHelpers';
import { buildAuthorFeedMatch } from '../../../../utils/postAuthorship';
import { excludedDisplayModesForTab, loadExcludedLaneIds } from '../../../../services/laneVisibility';
import { FEED_FIELDS } from '../../FeedAPI';
import { ChronoCursor } from '../../CursorBuilder';
import { notAReplyClause, restrictToReplies, restrictToRoots } from '../../../../utils/postReply';
import { trendTermMatch } from '../../../../services/trending/termSpace';
import type { AuthorFeedFilter, LaneDisplayMode, LaneOwnerType } from '@mention/shared-types';
import type { CandidatePost, FeedEngineContext, SourceModule } from '../types';

/** `keywords`: posts matching hashtags (Hashtag feed) and/or content keywords (custom). */
export const keywordsSource: SourceModule = {
  id: 'keywords',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, params, cap) => {
    const hashtags = Array.isArray(params.hashtags)
      ? (params.hashtags as string[]).map((t) => t.toLowerCase())
      : [];
    const keywords = Array.isArray(params.keywords) ? (params.keywords as string[]) : [];

    if (hashtags.length === 0 && keywords.length === 0) return [];

    const match: Record<string, unknown> = { visibility: 'public', status: 'published' };
    const conditions: Record<string, unknown>[] = [];

    if (keywords.length > 0) {
      const regexes = keywords.map((k) => new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
      conditions.push({
        $or: [
          { 'content.variants.text': { $in: regexes } },
          { hashtags: { $in: keywords.map((k) => k.toLowerCase()) } },
        ],
      });
    }

    if (hashtags.length > 0) {
      // Single hashtag matches the multikey `hashtags` array directly (mirrors
      // the legacy HashtagFeed); multiple hashtags use `$in`.
      conditions.push(hashtags.length === 1 ? { hashtags: hashtags[0] } : { hashtags: { $in: hashtags } });
    }

    if (conditions.length === 1) {
      Object.assign(match, conditions[0]);
    } else if (conditions.length > 1) {
      match.$and = conditions;
    }

    ChronoCursor.applyToQuery(match, ctx.cursor);

    // Sorted on the CURSOR's axis. See `trendTermsSource` below for why `_id`
    // alone is not merely a different order but a skipped page boundary.
    return (await Post.find(match)
      .select(FEED_FIELDS)
      .sort({ createdAt: -1, _id: -1 })
      .limit(cap)
      .maxTimeMS(5000)
      .lean()) as unknown as CandidatePost[];
  },
};

/**
 * `trendTerms`: the posts behind ONE trend — what a reader lands on after
 * pressing it.
 *
 * Matched with {@link trendTermMatch} — the SAME definition the detection batch
 * counts over, shared rather than restated. A feed that matched less than
 * detection counted would open a reported trend onto a screen missing exactly
 * the posts that made it trend, which is why the two must not be able to drift.
 */
export const trendTermsSource: SourceModule = {
  id: 'trendTerms',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, params, cap) => {
    const term = typeof params.term === 'string' ? params.term.trim().toLowerCase() : '';
    if (!term) return [];

    const match: Record<string, unknown> = {
      // Nested under `$and` so the cursor's own `$or` (added by
      // `ChronoCursor.applyToQuery`) cannot clobber it.
      $and: [trendTermMatch(term)],
      visibility: 'public',
      status: 'published',
    };
    ChronoCursor.applyToQuery(match, ctx.cursor);

    // `{ createdAt, _id }`, matching the `ChronoCursor` keyset — never `_id`
    // alone. A federated post's import-time `_id` bears no relation to the
    // `createdAt` it was written at, so an `_id` sort behind a `createdAt`
    // cursor does not merely misorder: it permanently SKIPS backfilled posts at
    // every page boundary. This feed is mostly federated posts, so it is the
    // worst possible place for that. (Same rule as the `authored` source; see
    // AGENTS.md § Profile feed.)
    return (await Post.find(match)
      .select(FEED_FIELDS)
      .sort({ createdAt: -1, _id: -1 })
      .limit(cap)
      .maxTimeMS(5000)
      .lean()) as unknown as CandidatePost[];
  },
};

/** `accounts`: posts from an explicit author-id list (custom feeds). */
export const accountsSource: SourceModule = {
  id: 'accounts',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, params, cap) => {
    const authorIds = Array.isArray(params.authorIds) ? (params.authorIds as string[]) : [];
    if (authorIds.length === 0) return [];

    const match: Record<string, unknown> = {
      oxyUserId: { $in: authorIds },
      visibility: 'public',
      status: 'published',
    };
    ChronoCursor.applyToQuery(match, ctx.cursor);

    // Sorted on the CURSOR's axis, same rule as the two sources above.
    return (await Post.find(match)
      .select(FEED_FIELDS)
      .sort({ createdAt: -1, _id: -1 })
      .limit(cap)
      .maxTimeMS(5000)
      .lean()) as unknown as CandidatePost[];
  },
};

/** Author query: posts owned by or accepted-collaborated by the profile user. */
function buildAuthoredQuery(
  authorId: string,
  filter: AuthorFeedFilter,
  excludedLaneIds: readonly string[],
  cursor?: string,
): Record<string, unknown> {
  const query: Record<string, unknown> = {
    ...buildAuthorFeedMatch(authorId),
    visibility: PostVisibility.PUBLIC,
    status: 'published',
  };

  // The author's own curation (see `services/laneVisibility` for which modes are
  // excluded from which tab). A KEY OF ITS OWN, so it coexists with the `$and`
  // the `media`/`videos` branches below assign, and — critically — never touches
  // `match.$or`, which `ChronoCursor.applyToQuery` ASSIGNS: a filter written
  // there would work on page one and silently stop working on every page after.
  // `$nin` also matches documents with no `laneId`, so a post outside every lane
  // passes with no extra clause.
  if (excludedLaneIds.length > 0) {
    query.laneId = { $nin: excludedLaneIds };
  }

  switch (filter) {
    case 'posts':
      // Boosts are top-level posts, so they surface on the main tab too — the
      // definition hydrates at depth 1 so the boosted original renders.
      restrictToRoots(query);
      break;
    case 'replies':
      restrictToReplies(query);
      break;
    case 'boosts':
      query.boostOf = { $ne: null };
      break;
    case 'media':
      // The three media shapes `mediaOnlyFilter.keep` recognizes, so the query
      // and the in-memory predicate agree on what "has media" means.
      query.$and = [
        {
          $or: [
            { type: { $in: [PostType.IMAGE, PostType.VIDEO] } },
            { 'content.media.0': { $exists: true } },
            { 'content.attachments': { $elemMatch: { type: 'media' } } },
          ],
        },
        notAReplyClause(),
        { $or: [{ boostOf: null }, { boostOf: { $exists: false } }] },
      ];
      break;
    case 'videos':
      // Deliberately NARROWER than `media`: the two video shapes
      // `videoOnlyFilter.keep` recognizes, and no `content.attachments` branch,
      // because that predicate has none — including it would fetch posts the
      // filter then drops, paying for a page that arrives short.
      query.$and = [
        {
          $or: [
            { type: PostType.VIDEO },
            { 'content.media': { $elemMatch: { type: 'video' } } },
          ],
        },
        notAReplyClause(),
        { $or: [{ boostOf: null }, { boostOf: { $exists: false } }] },
      ];
      break;
    case 'likes':
      break;
  }

  ChronoCursor.applyToQuery(query, cursor);
  return query;
}

/**
 * Whether the viewer may see the profile's feed at all.
 *
 * A private / followers-only profile is gated on the viewer following it — the
 * same check the profile screen enforces, applied here so it holds for EVERY
 * tab (posts, replies, media, boosts, likes) rather than the posts themselves
 * leaking through their own `visibility: public` flag. Returning `false` yields
 * an empty feed, which is exactly what a viewer without access must see.
 */
async function canViewAuthorFeed(ctx: FeedEngineContext, authorId: string): Promise<boolean> {
  if (ctx.currentUserId === authorId) return true;
  const settings = await UserSettings.findOne(
    { oxyUserId: authorId },
    { 'privacy.profileVisibility': 1 },
  ).lean();
  const profileVisibility = settings?.privacy?.profileVisibility ?? ProfileVisibility.PUBLIC;
  if (!requiresAccessCheck(profileVisibility)) return true;
  if (!ctx.currentUserId) return false;
  return (ctx.followingIds ?? []).includes(authorId);
}

function buildVisibleLikedPostMatch(ctx: FeedEngineContext): Record<string, unknown> {
  const viewerId = ctx.currentUserId;
  const followAuthorizedIds = Array.from(new Set([viewerId, ...(ctx.followingIds ?? [])].filter(Boolean)));

  if (!viewerId) {
    return { visibility: PostVisibility.PUBLIC };
  }

  return {
    $or: [
      { visibility: PostVisibility.PUBLIC },
      { oxyUserId: { $in: followAuthorizedIds }, visibility: PostVisibility.FOLLOWERS_ONLY },
      { oxyUserId: viewerId, visibility: PostVisibility.PRIVATE },
    ],
  };
}

/** The viewer's liked posts, in like order, for the ORDERED Author-likes feed. */
async function gatherAuthorLikes(authorId: string, ctx: FeedEngineContext): Promise<CandidatePost[]> {
  const pageLimit = ctx.pageLimit ?? 30;

  const Like = (await import('../../../../models/Like')).default;
  const likes = await Like.find({ userId: authorId, value: 1 })
    .sort({ createdAt: -1 })
    .limit(pageLimit + 1)
    .select('postId')
    .lean();
  const likedPostIds = likes.map((l) => l.postId);
  if (likedPostIds.length === 0) return [];

  const hasMore = likedPostIds.length > pageLimit;
  const ids = hasMore ? likedPostIds.slice(0, pageLimit) : likedPostIds;

  const posts = await Post.find({
    _id: { $in: ids },
    status: 'published',
    ...buildVisibleLikedPostMatch(ctx),
  })
    .select(FEED_FIELDS)
    .lean();

  const postMap = new Map(posts.map((p) => [String(p._id), p]));
  const ordered = ids
    .map((id) => postMap.get(String(id)))
    .filter((p): p is NonNullable<typeof p> => Boolean(p)) as unknown as CandidatePost[];

  if (hasMore && ordered.length > 0) {
    ordered[ordered.length - 1]._feedCursor = ChronoCursor.build(likes[pageLimit - 1]._id.toString());
  }
  return ordered;
}

/**
 * `authored`: a single author's posts/replies/media/boosts (chronological) or
 * likes (ordered) — the profile feed. Params `{ authorId, filter }`.
 */
export const authoredSource: SourceModule = {
  id: 'authored',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, params, cap) => {
    const authorId = typeof params.authorId === 'string' ? params.authorId : '';
    if (!authorId) return [];
    const filterParam = typeof params.filter === 'string' ? params.filter : undefined;
    const filter: AuthorFeedFilter = isAuthorFeedFilter(filterParam) ? filterParam : 'posts';

    if (!(await canViewAuthorFeed(ctx, authorId))) return [];

    if (filter === 'likes') {
      // The likes tab lists OTHER people's posts, so the profile owner's own
      // lane curation has no bearing on it.
      return gatherAuthorLikes(authorId, ctx);
    }

    const excludedLaneIds = await loadExcludedLaneIds(
      'user',
      authorId,
      excludedDisplayModesForTab(filter),
    );
    const query = buildAuthoredQuery(authorId, filter, excludedLaneIds, ctx.cursor);
    // Sorted by `createdAt` — NOT `_id` — to match the chronological keyset
    // `ChronoCursor` writes into the query (and the engine's own re-sort). A
    // federated post's import-time `_id` bears no relation to its remote
    // `createdAt`, so an `_id` sort here silently drops backfilled posts that
    // fall on the wrong side of the cursor's `createdAt` boundary. `_id` is the
    // tiebreaker, mirroring the cursor's compound comparison. Backed by
    // `{ 'authorship.oxyUserId': 1, 'authorship.status': 1, createdAt: -1 }`.
    return (await Post.find(query)
      .select(FEED_FIELDS)
      .sort({ createdAt: -1, _id: -1 })
      .limit(cap)
      .maxTimeMS(5000)
      .lean()) as unknown as CandidatePost[];
  },
};

/**
 * `lane`: ONE lane's own tab. Param `{ laneId }` — one parameter, because a lane
 * already knows its publisher.
 *
 * TWO GATES, and the feed is a back door without either of them:
 *
 *  1. **The publisher's own visibility.** A private / followers-only profile
 *     answers an empty feed to a non-follower here exactly as it does on every
 *     other profile tab (`canViewAuthorFeed`). A lane must never become a side
 *     entrance to a publisher the reader cannot see.
 *  2. **`displayMode === 'tab'` and nothing else.** `mixed` has no tab of its own
 *     (its posts are on the main one) and `hidden` is off the showcase
 *     altogether — serving either would make this descriptor the way to read a
 *     lane its owner took down.
 *
 * The query is `{ laneId }` plus the publisher's scope, deliberately NOT
 * `buildAuthorFeedMatch`: that multikey `authorship` clause would pull the
 * planner onto `post_author_chrono_v1` instead of `post_lane_chrono_v1`, and the
 * literal `laneId` term is also what lets the PARTIAL index be used at all.
 *
 * No `restrictToRoots`: replies and boosts are refused a lane at the write
 * boundary, so filtering them here would be code that can never match.
 */
export const laneSource: SourceModule = {
  id: 'lane',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, params, cap) => {
    const laneId = typeof params.laneId === 'string' ? params.laneId : '';
    if (!laneId || !mongoose.Types.ObjectId.isValid(laneId)) return [];

    const lane = await Lane.findById(laneId)
      .select('ownerType ownerId displayMode')
      .lean<{ ownerType: LaneOwnerType; ownerId: string; displayMode: LaneDisplayMode } | null>();
    if (!lane) return [];

    // Gate 2 first: it is free, and it is the one that makes an unlisted lane
    // unreadable through this descriptor.
    if (lane.displayMode !== 'tab') return [];

    // Gate 1. Channels have no visibility rule of their own yet, and no post can
    // carry a channel lane until they do, so a channel-owned lane serves nothing
    // rather than serving unguarded.
    if (lane.ownerType !== 'user') return [];
    if (!(await canViewAuthorFeed(ctx, lane.ownerId))) return [];

    const match: Record<string, unknown> = {
      laneId,
      oxyUserId: lane.ownerId,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
    };
    ChronoCursor.applyToQuery(match, ctx.cursor);

    // Sorted on the CURSOR's axis — `{ createdAt, _id }`, never `_id` alone —
    // the same rule every source here follows and the same order
    // `post_lane_chrono_v1` stores.
    return (await Post.find(match)
      .select(FEED_FIELDS)
      .sort({ createdAt: -1, _id: -1 })
      .limit(cap)
      .maxTimeMS(5000)
      .lean()) as unknown as CandidatePost[];
  },
};

/** `saved`: the viewer's bookmarks in bookmark order (ORDERED). Wraps `SavedFeed`. */
export const savedSource: SourceModule = {
  id: 'saved',
  kind: 'source',
  userComposable: false,
  gather: async (ctx) => {
    if (!ctx.currentUserId) return [];
    const pageLimit = ctx.pageLimit ?? 30;

    const Bookmark = (await import('../../../../models/Bookmark')).default;
    const bookmarkQuery: Record<string, unknown> = { userId: ctx.currentUserId };
    if (ctx.cursor && mongoose.Types.ObjectId.isValid(ctx.cursor)) {
      bookmarkQuery._id = { $lt: new mongoose.Types.ObjectId(ctx.cursor) };
    }

    const bookmarks = await Bookmark.find(bookmarkQuery)
      .sort({ createdAt: -1 })
      .limit(pageLimit + 1)
      .lean();

    const hasMore = bookmarks.length > pageLimit;
    const bookmarksToProcess = hasMore ? bookmarks.slice(0, pageLimit) : bookmarks;

    const postIds = bookmarksToProcess.map((b) => b.postId).filter(Boolean);
    if (postIds.length === 0) return [];

    const posts = await Post.find({ _id: { $in: postIds }, status: 'published' })
      .select(FEED_FIELDS)
      .lean();

    const postMap = new Map<string, (typeof posts)[number]>();
    for (const post of posts) postMap.set(post._id.toString(), post);
    const ordered = postIds
      .map((id) => postMap.get(id.toString()))
      .filter((p): p is NonNullable<typeof p> => Boolean(p)) as unknown as CandidatePost[];

    if (hasMore && ordered.length > 0) {
      const lastBookmark = bookmarksToProcess[bookmarksToProcess.length - 1];
      ordered[ordered.length - 1]._feedCursor = ChronoCursor.build(
        lastBookmark._id.toString(),
        lastBookmark.createdAt,
      );
    }
    return ordered;
  },
};

/**
 * `mutuals`: the viewer's mutual-follow authors, chronological. `ctx.mutualIds`
 * is populated by the controller (Oxy mutual ids ∪ federated mutuals) only for
 * the Mutuals feed; returns `[]` when it is empty (any non-Mutuals context, or a
 * viewer with no mutuals). Mutuals may show PUBLIC + FOLLOWERS_ONLY posts (a
 * mutual is, by definition, a follower).
 */
export const mutualsSource: SourceModule = {
  id: 'mutuals',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) => {
    const mutualIds = ctx.mutualIds ?? [];
    if (mutualIds.length === 0) return [];

    const match: Record<string, unknown> = {
      oxyUserId: { $in: mutualIds },
      visibility: { $in: [PostVisibility.PUBLIC, PostVisibility.FOLLOWERS_ONLY] },
      status: 'published',
    };
    ChronoCursor.applyToQuery(match, ctx.cursor);

    // Sorted on the CURSOR's axis, same rule as every source above. Mutuals
    // include federated authors, so this one is exposed to the skipped-page
    // boundary exactly like the rest.
    return (await Post.find(match)
      .select(FEED_FIELDS)
      .sort({ createdAt: -1, _id: -1 })
      .limit(cap)
      .maxTimeMS(5000)
      .lean()) as unknown as CandidatePost[];
  },
};

export const userSourceModules: SourceModule[] = [
  keywordsSource,
  trendTermsSource,
  accountsSource,
  authoredSource,
  laneSource,
  savedSource,
  mutualsSource,
];
