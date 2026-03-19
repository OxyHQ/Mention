/**
 * Following Feed Strategy
 * Shows posts from users that the current user follows, sorted chronologically.
 * Includes thread slicing for self-threads and reply context.
 */

import { SlicedFeedResponse } from '@mention/shared-types';
import { AuthRequest } from '../../types/auth';
import { Post } from '../../models/Post';
import { IFeedStrategy, FeedStrategyContext, FeedStrategyOptions } from './FeedStrategy';
import { postHydrationService } from '../PostHydrationService';
import { threadSlicingService } from '../ThreadSlicingService';
import { FeedResponseBuilder } from '../../utils/FeedResponseBuilder';
import { logger } from '../../utils/logger';
import mongoose from 'mongoose';

export class FollowingFeedStrategy implements IFeedStrategy {
  private readonly FEED_FIELDS = '_id oxyUserId federation createdAt visibility type parentPostId repostOf quoteOf threadId content stats metadata hashtags mentions language';
  // Overfetch multiplier to compensate for multi-post slices consuming extra posts
  private readonly SLICE_OVERFETCH_MULTIPLIER = 1.5;

  getName(): string {
    return 'following';
  }

  async generateFeed(
    req: AuthRequest,
    options: FeedStrategyOptions,
    context: FeedStrategyContext
  ): Promise<SlicedFeedResponse> {
    const { cursor, limit } = options;
    const { currentUserId, followingIds } = context;

    const emptyResponse: SlicedFeedResponse = {
      slices: [],
      items: [],
      hasMore: false,
      nextCursor: undefined,
      totalCount: 0,
    };

    if (!currentUserId) return emptyResponse;
    if (!followingIds || followingIds.length === 0) return emptyResponse;

    // Build query for posts from followed users
    // No longer excludes replies — slicing handles thread grouping and reply context
    const match: any = {
      oxyUserId: { $in: [currentUserId, ...followingIds] },
      visibility: { $in: ['public', 'followers'] },
    };

    if (cursor && mongoose.Types.ObjectId.isValid(cursor)) {
      match._id = { $lt: new mongoose.Types.ObjectId(cursor) };
    }

    // Overfetch to account for multi-post slices
    const fetchLimit = Math.ceil(limit * this.SLICE_OVERFETCH_MULTIPLIER);
    const posts = await Post.find(match)
      .select(this.FEED_FIELDS)
      .sort({ createdAt: -1 })
      .limit(fetchLimit + 1)
      .maxTimeMS(5000)
      .lean();

    const hasMore = posts.length > fetchLimit;
    const postsToProcess = hasMore ? posts.slice(0, fetchLimit) : posts;

    // Slice posts into thread groups + reply context
    const { slices: rawSlices } = await threadSlicingService.sliceFeed(postsToProcess, {
      enableThreadGrouping: true,
      enableReplyContext: true,
      maxSliceSize: 3,
      viewerId: currentUserId,
    });

    // Hydrate all posts across slices in a single batch
    const hydratedSlices = await postHydrationService.hydrateSlices(rawSlices, {
      viewerId: currentUserId,
      oxyClient: context.oxyClient,
      maxDepth: 0,
      includeLinkMetadata: true,
      includeFullArticleBody: false,
      includeFullMetadata: false,
    });

    // Calculate cursor from the last raw post that was processed
    // (chronological feed uses plain ObjectId cursor)
    let sliceCursor: string | undefined;
    if (postsToProcess.length > 0 && hasMore) {
      const lastPost = postsToProcess[postsToProcess.length - 1];
      sliceCursor = lastPost._id.toString();

      if (cursor && sliceCursor === cursor) {
        logger.warn('[FollowingFeed] Cursor did not advance, stopping pagination', { cursor, sliceCursor });
        sliceCursor = undefined;
      }
    }

    return FeedResponseBuilder.buildSlicedResponse({
      slices: hydratedSlices,
      limit,
      previousCursor: cursor,
      cursorFromLastSlice: sliceCursor,
      hasMore,
    });
  }
}
