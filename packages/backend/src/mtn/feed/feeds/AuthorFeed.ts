/**
 * Author Feed
 *
 * Posts by a specific user, with optional filter (posts, replies, media, likes).
 */

import { HydratedPost, PostType, PostVisibility } from '@mention/shared-types';
import { MtnConfig } from '@mention/shared-types';
import { Post } from '../../../models/Post';
import { postHydrationService } from '../../../services/PostHydrationService';
import { threadSlicingService } from '../../../services/ThreadSlicingService';
import { FeedResponseBuilder } from '../../../utils/FeedResponseBuilder';
import { FeedAPI, FeedAPIResponse, FeedFetchOptions, FeedContext, FEED_FIELDS } from '../FeedAPI';
import { ChronoCursor, didCursorAdvance } from '../CursorBuilder';
import { logger } from '../../../utils/logger';
import type { AuthorFeedFilter } from '@mention/shared-types';

export class AuthorFeed implements FeedAPI {
  readonly descriptor;
  private readonly authorId: string;
  private readonly filter: AuthorFeedFilter;

  constructor(authorId: string, filter: AuthorFeedFilter = 'posts') {
    this.authorId = authorId;
    this.filter = filter;
    this.descriptor = filter === 'posts'
      ? (`author|${authorId}` as const)
      : (`author|${authorId}|${filter}` as const);
  }

  async peekLatest(context: FeedContext): Promise<HydratedPost | undefined> {
    const query = this.buildQuery();
    const post = await Post.findOne(query).select(FEED_FIELDS).sort({ createdAt: -1 }).lean();
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
    const query = this.buildQuery(cursor);

    const posts = await Post.find(query)
      .select(FEED_FIELDS)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .maxTimeMS(5000)
      .lean();

    const hasMore = posts.length > limit;
    const postsToReturn = hasMore ? posts.slice(0, limit) : posts;

    let nextCursor: string | undefined;
    if (postsToReturn.length > 0 && hasMore) {
      nextCursor = ChronoCursor.build(postsToReturn[postsToReturn.length - 1]._id.toString());
      if (!didCursorAdvance(nextCursor, cursor)) {
        logger.warn('[AuthorFeed] Cursor did not advance', { cursor, nextCursor });
        nextCursor = undefined;
      }
    }

    const { slices: rawSlices } = await threadSlicingService.sliceFeed(postsToReturn, {
      enableThreadGrouping: true,
      enableReplyContext: false,
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

  private buildQuery(cursor?: string): any {
    const query: any = {
      oxyUserId: this.authorId,
      visibility: PostVisibility.PUBLIC,
    };

    switch (this.filter) {
      case 'posts':
        query.parentPostId = null;
        break;
      case 'replies':
        query.parentPostId = { $ne: null };
        break;
      case 'media':
        query.$and = [
          {
            $or: [
              { type: { $in: [PostType.IMAGE, PostType.VIDEO] } },
              { 'content.media.0': { $exists: true } },
            ],
          },
          { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
          { $or: [{ repostOf: null }, { repostOf: { $exists: false } }] },
        ];
        break;
      case 'likes':
        // Likes feed is handled differently (query Like model)
        break;
    }

    ChronoCursor.applyToQuery(query, cursor);
    return query;
  }
}
