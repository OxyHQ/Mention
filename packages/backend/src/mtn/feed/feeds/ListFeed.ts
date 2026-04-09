/**
 * List Feed
 *
 * Posts from members of a specific list.
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
import mongoose from 'mongoose';

export class ListFeed implements FeedAPI {
  readonly descriptor;
  private readonly listId: string;

  constructor(listId: string) {
    this.listId = listId;
    this.descriptor = `list|${listId}` as const;
  }

  async peekLatest(context: FeedContext): Promise<HydratedPost | undefined> {
    const memberIds = await this.getListMemberIds();
    if (!memberIds.length) return undefined;

    const post = await Post.findOne({
      oxyUserId: { $in: memberIds },
      visibility: 'public',
      status: 'published',
    })
      .select(FEED_FIELDS)
      .sort({ _id: -1 })
      .lean();

    if (!post) return undefined;
    const [hydrated] = await postHydrationService.hydratePosts([post], {
      viewerId: context.currentUserId,
      maxDepth: 0,
    });
    return hydrated;
  }

  async fetch(options: FeedFetchOptions, context: FeedContext): Promise<FeedAPIResponse> {
    const { cursor, limit } = options;
    const empty: FeedAPIResponse = { slices: [], items: [], hasMore: false, totalCount: 0 };

    const memberIds = await this.getListMemberIds();
    if (!memberIds.length) return empty;

    const match: any = {
      oxyUserId: { $in: memberIds },
      visibility: 'public',
      status: 'published',
    };
    ChronoCursor.applyToQuery(match, cursor);

    const posts = await Post.find(match)
      .select(FEED_FIELDS)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .maxTimeMS(5000)
      .lean();

    const hasMore = posts.length > limit;
    const postsToReturn = hasMore ? posts.slice(0, limit) : posts;

    let nextCursor: string | undefined;
    if (postsToReturn.length > 0 && hasMore) {
      const last = postsToReturn[postsToReturn.length - 1];
      nextCursor = ChronoCursor.build(last._id.toString(), last.createdAt);
      if (!didCursorAdvance(nextCursor, cursor)) {
        logger.warn('[ListFeed] Cursor did not advance', { cursor, nextCursor });
        nextCursor = undefined;
      }
    }

    const { slices: rawSlices } = await threadSlicingService.sliceFeed(postsToReturn, {
      enableThreadGrouping: true,
      enableReplyContext: true,
      maxSliceSize: MtnConfig.feed.maxSliceSize,
      viewerId: context.currentUserId,
    });

    const hydratedSlices = await postHydrationService.hydrateSlices(rawSlices, {
      viewerId: context.currentUserId,
      oxyClient: context.oxyClient,
      maxDepth: 0,
      includeLinkMetadata: true,
    });

    return FeedResponseBuilder.buildSlicedResponse({
      slices: hydratedSlices,
      limit,
      previousCursor: cursor,
      cursorFromLastSlice: nextCursor,
      hasMore,
    });
  }

  private async getListMemberIds(): Promise<string[]> {
    try {
      const { AccountList } = await import('../../../models/AccountList.js');
      if (!mongoose.Types.ObjectId.isValid(this.listId)) return [];
      const list = await AccountList.findById(this.listId).lean();
      return list?.memberOxyUserIds || [];
    } catch {
      logger.warn('[ListFeed] Failed to load list', { listId: this.listId });
      return [];
    }
  }
}
