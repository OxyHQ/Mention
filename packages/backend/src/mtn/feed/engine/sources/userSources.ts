/**
 * User-oriented source modules — wrap the Hashtag, Author, and Saved feed
 * queries plus the `accounts` (custom-feed author list) source and the
 * `mutuals` placeholder. Each reproduces the pre-existing feed's exact query.
 */

import mongoose from 'mongoose';
import { PostType, PostVisibility } from '@mention/shared-types';
import { Post } from '../../../../models/Post';
import UserSettings from '../../../../models/UserSettings';
import { ProfileVisibility, requiresAccessCheck } from '../../../../utils/privacyHelpers';
import { FEED_FIELDS } from '../../FeedAPI';
import { ChronoCursor } from '../../CursorBuilder';
import { logger } from '../../../../utils/logger';
import type { AuthorFeedFilter } from '@mention/shared-types';
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
          { 'content.text': { $in: regexes } },
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

    return (await Post.find(match)
      .select(FEED_FIELDS)
      .sort({ _id: -1 })
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

    return (await Post.find(match)
      .select(FEED_FIELDS)
      .sort({ _id: -1 })
      .limit(cap)
      .maxTimeMS(5000)
      .lean()) as unknown as CandidatePost[];
  },
};

/** Author query for the posts/replies/media filters (wraps `AuthorFeed.buildQuery`). */
function buildAuthoredQuery(authorId: string, filter: AuthorFeedFilter, cursor?: string): Record<string, unknown> {
  const query: Record<string, unknown> = {
    oxyUserId: authorId,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
  };

  switch (filter) {
    case 'posts':
      query.parentPostId = null;
      break;
    case 'replies':
      query.parentPostId = { $ne: null };
      break;
    case 'media':
      query.$and = [
        { $or: [{ type: { $in: [PostType.IMAGE, PostType.VIDEO] } }, { 'content.media.0': { $exists: true } }] },
        { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
        { $or: [{ boostOf: null }, { boostOf: { $exists: false } }] },
      ];
      break;
    case 'likes':
      break;
  }

  ChronoCursor.applyToQuery(query, cursor);
  return query;
}

async function canViewAuthorLikes(ctx: FeedEngineContext, authorId: string): Promise<boolean> {
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
  if (!(await canViewAuthorLikes(ctx, authorId))) return [];

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
 * `authored`: a single author's posts/replies/media (chronological) or likes
 * (ordered). Wraps `AuthorFeed`. Params `{ authorId, filter }`.
 */
export const authoredSource: SourceModule = {
  id: 'authored',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, params, cap) => {
    const authorId = typeof params.authorId === 'string' ? params.authorId : '';
    if (!authorId) return [];
    const filter = (typeof params.filter === 'string' ? params.filter : 'posts') as AuthorFeedFilter;

    if (filter === 'likes') {
      return gatherAuthorLikes(authorId, ctx);
    }

    const query = buildAuthoredQuery(authorId, filter, ctx.cursor);
    return (await Post.find(query)
      .select(FEED_FIELDS)
      .sort({ _id: -1 })
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
 * `mutuals`: viewer's mutual-follow authors. Phase 1 PLACEHOLDER returning `[]`
 * (so the token resolves); the real Oxy-backed mutual set lands in Phase 2.
 */
export const mutualsSource: SourceModule = {
  id: 'mutuals',
  kind: 'source',
  userComposable: false,
  gather: async () => {
    logger.debug('[mutuals source] placeholder (Phase 2) — returning empty');
    return [];
  },
};

export const userSourceModules: SourceModule[] = [
  keywordsSource,
  accountsSource,
  authoredSource,
  savedSource,
  mutualsSource,
];
