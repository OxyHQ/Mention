/**
 * Custom Feed
 *
 * User-created feeds with configurable filters.
 * Replaces CustomFeedStrategy — now includes thread slicing for consistency.
 */

import { HydratedPost } from '@mention/shared-types';
import { MtnConfig } from '@mention/shared-types';
import { Post } from '../../../models/Post';
import CustomFeedModel from '../../../models/CustomFeed';
import { postHydrationService } from '../../../services/PostHydrationService';
import { threadSlicingService } from '../../../services/ThreadSlicingService';
import { FeedResponseBuilder } from '../../../utils/FeedResponseBuilder';
import { FeedAPI, FeedAPIResponse, FeedFetchOptions, FeedContext, FEED_FIELDS } from '../FeedAPI';
import { ChronoCursor, didCursorAdvance } from '../CursorBuilder';
import { logger } from '../../../utils/logger';
import mongoose from 'mongoose';

export class CustomFeed implements FeedAPI {
  readonly descriptor;
  private readonly feedId: string;

  constructor(feedId: string) {
    this.feedId = feedId;
    this.descriptor = `custom|${feedId}` as const;
  }

  async peekLatest(context: FeedContext): Promise<HydratedPost | undefined> {
    const query = await this.buildQuery(context);
    if (!query) return undefined;

    const post = await Post.findOne(query).select(FEED_FIELDS).sort({ _id: -1 }).lean();
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

    if (!this.feedId || !mongoose.Types.ObjectId.isValid(this.feedId)) return empty;

    const query = await this.buildQuery(context, cursor);
    if (!query) return empty;

    const posts = await Post.find(query)
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
        logger.warn('[CustomFeed] Cursor did not advance', { cursor, nextCursor });
        nextCursor = undefined;
      }
    }

    // Thread slicing (now included for all feeds)
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

  private async buildQuery(context: FeedContext, cursor?: string): Promise<any | null> {
    const feed = await CustomFeedModel.findById(this.feedId).lean();
    if (!feed) {
      logger.warn('[CustomFeed] Feed not found', { feedId: this.feedId });
      return null;
    }

    if (!feed.isPublic && feed.ownerOxyUserId !== context.currentUserId) {
      logger.warn('[CustomFeed] Access denied', { feedId: this.feedId });
      return null;
    }

    // Expand authors
    let authors: string[] = Array.from(new Set(feed.memberOxyUserIds || []));
    try {
      if (feed.sourceListIds?.length) {
        const { AccountList } = await import('../../../models/AccountList.js');
        const lists = await AccountList.find({ _id: { $in: feed.sourceListIds } }).lean();
        for (const list of lists) {
          if (list.memberOxyUserIds) authors.push(...list.memberOxyUserIds);
        }
        authors = Array.from(new Set(authors));
      }
    } catch (e) {
      logger.warn('[CustomFeed] Failed to expand source lists', e);
    }

    const conditions: any[] = [];
    const query: any = { visibility: 'public', status: 'published' };

    if (authors.length > 0) {
      conditions.push({ oxyUserId: { $in: authors } });
    }

    if (feed.keywords?.length) {
      const regexes = feed.keywords.map((k: string) =>
        new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      );
      conditions.push({
        $or: [
          { 'content.text': { $in: regexes } },
          { hashtags: { $in: feed.keywords.map((k: string) => k.toLowerCase()) } },
        ],
      });
    }

    if (authors.length === 0 && (!feed.keywords || feed.keywords.length === 0)) return null;

    if (feed.includeReplies === false) {
      conditions.push({ $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] });
    }
    if (feed.includeReposts === false) {
      conditions.push({ $or: [{ repostOf: null }, { repostOf: { $exists: false } }] });
    }
    if (feed.language) {
      conditions.push({ language: feed.language });
    }

    ChronoCursor.applyToQuery(query, cursor);

    if (conditions.length > 0) query.$and = conditions;
    return query;
  }
}
