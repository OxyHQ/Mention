/**
 * Saved Feed
 *
 * User's bookmarked/saved posts.
 */

import { HydratedPost } from '@mention/shared-types';
import { Post } from '../../../models/Post';
import Bookmark from '../../../models/Bookmark';
import { postHydrationService } from '../../../services/PostHydrationService';
import { FeedAPI, FeedAPIResponse, FeedFetchOptions, FeedContext, FEED_FIELDS } from '../FeedAPI';
import { ChronoCursor, didCursorAdvance } from '../CursorBuilder';
import { logger } from '../../../utils/logger';
import mongoose from 'mongoose';

export class SavedFeed implements FeedAPI {
  readonly descriptor = 'saved' as const;

  async peekLatest(context: FeedContext): Promise<HydratedPost | undefined> {
    if (!context.currentUserId) return undefined;

    const bookmark = await Bookmark.findOne({ userId: context.currentUserId })
      .sort({ createdAt: -1 })
      .lean();

    if (!bookmark) return undefined;
    const post = await Post.findById(bookmark.postId).select(FEED_FIELDS).lean();
    if (!post) return undefined;

    const [hydrated] = await postHydrationService.hydratePosts([post], {
      viewerId: context.currentUserId,
      oxyClient: context.oxyClient,
      maxDepth: 0,
    });
    return hydrated;
  }

  async fetch(options: FeedFetchOptions, context: FeedContext): Promise<FeedAPIResponse> {
    const { cursor, limit } = options;
    const empty: FeedAPIResponse = { slices: [], items: [], hasMore: false, totalCount: 0 };

    if (!context.currentUserId) return empty;

    // Get bookmarked post IDs
    const bookmarkQuery: any = { userId: context.currentUserId };
    if (cursor && mongoose.Types.ObjectId.isValid(cursor)) {
      bookmarkQuery._id = { $lt: new mongoose.Types.ObjectId(cursor) };
    }

    const bookmarks = await Bookmark.find(bookmarkQuery)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = bookmarks.length > limit;
    const bookmarksToProcess = hasMore ? bookmarks.slice(0, limit) : bookmarks;

    const postIds = bookmarksToProcess.map((b: any) => b.postId).filter(Boolean);
    if (postIds.length === 0) return empty;

    const posts = await Post.find({ _id: { $in: postIds } })
      .select(FEED_FIELDS)
      .lean();

    // Preserve bookmark order
    const postMap = new Map<string, any>();
    for (const post of posts) postMap.set(post._id.toString(), post);
    const ordered = postIds
      .map((id: string) => postMap.get(id.toString()))
      .filter(Boolean);

    const hydrated = await postHydrationService.hydratePosts(ordered, {
      viewerId: context.currentUserId,
      oxyClient: context.oxyClient,
      maxDepth: 0,
      includeLinkMetadata: true,
    });

    // Mark all as saved
    for (const post of hydrated) {
      if (post.viewerState) post.viewerState.isSaved = true;
    }

    let nextCursor: string | undefined;
    if (bookmarksToProcess.length > 0 && hasMore) {
      nextCursor = ChronoCursor.build(
        bookmarksToProcess[bookmarksToProcess.length - 1]._id.toString()
      );
      if (!didCursorAdvance(nextCursor, cursor)) {
        logger.warn('[SavedFeed] Cursor did not advance', { cursor, nextCursor });
        nextCursor = undefined;
      }
    }

    return {
      slices: [],
      items: hydrated,
      hasMore,
      cursor: nextCursor,
      totalCount: hydrated.length,
    };
  }
}
