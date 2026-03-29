/**
 * Following Feed
 *
 * Chronological posts from followed users.
 * Replaces FollowingFeedStrategy.
 */

import { HydratedPost } from '@mention/shared-types';
import { MtnConfig } from '@mention/shared-types';
import { Post } from '../../../models/Post';
import { postHydrationService } from '../../../services/PostHydrationService';
import { threadSlicingService } from '../../../services/ThreadSlicingService';
import { FeedResponseBuilder } from '../../../utils/FeedResponseBuilder';
import { FeedAPI, FeedAPIResponse, FeedFetchOptions, FeedContext, FEED_FIELDS } from '../FeedAPI';
import { ChronoCursor, didCursorAdvance } from '../CursorBuilder';
import { logger } from '../../../utils/logger';

export class FollowingFeed implements FeedAPI {
  readonly descriptor = 'following' as const;

  async peekLatest(context: FeedContext): Promise<HydratedPost | undefined> {
    if (!context.currentUserId || !context.followingIds?.length) return undefined;

    const post = await Post.findOne({
      oxyUserId: { $in: [context.currentUserId, ...context.followingIds] },
      visibility: { $in: ['public', 'followers_only'] },
    })
      .select(FEED_FIELDS)
      .sort({ createdAt: -1 })
      .lean();

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
    const { currentUserId, followingIds } = context;

    const empty: FeedAPIResponse = { slices: [], items: [], hasMore: false, totalCount: 0 };
    if (!currentUserId || !followingIds?.length) return empty;

    const match: any = {
      oxyUserId: { $in: [currentUserId, ...followingIds] },
      visibility: { $in: ['public', 'followers_only'] },
    };
    ChronoCursor.applyToQuery(match, cursor);

    const fetchLimit = Math.ceil(limit * MtnConfig.feed.sliceOverfetchMultiplier);
    const posts = await Post.find(match)
      .select(FEED_FIELDS)
      .sort({ createdAt: -1 })
      .limit(fetchLimit + 1)
      .maxTimeMS(5000)
      .lean();

    const hasMore = posts.length > fetchLimit;
    const postsToProcess = hasMore ? posts.slice(0, fetchLimit) : posts;

    const { slices: rawSlices } = await threadSlicingService.sliceFeed(postsToProcess, {
      enableThreadGrouping: true,
      enableReplyContext: true,
      maxSliceSize: MtnConfig.feed.maxSliceSize,
      viewerId: currentUserId,
    });

    const hydratedSlices = await postHydrationService.hydrateSlices(rawSlices, {
      viewerId: currentUserId,
      oxyClient: context.oxyClient,
      maxDepth: 0,
      includeLinkMetadata: true,
    });

    let nextCursor: string | undefined;
    if (postsToProcess.length > 0 && hasMore) {
      const lastPost = postsToProcess[postsToProcess.length - 1];
      nextCursor = ChronoCursor.build(lastPost._id.toString());
      if (!didCursorAdvance(nextCursor, cursor)) {
        logger.warn('[FollowingFeed] Cursor did not advance', { cursor, nextCursor });
        nextCursor = undefined;
      }
    }

    return FeedResponseBuilder.buildSlicedResponse({
      slices: hydratedSlices,
      limit,
      previousCursor: cursor,
      cursorFromLastSlice: nextCursor,
      hasMore,
    });
  }
}
