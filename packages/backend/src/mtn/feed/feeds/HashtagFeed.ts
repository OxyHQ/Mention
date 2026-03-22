/**
 * Hashtag Feed
 *
 * Posts containing a specific hashtag.
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

export class HashtagFeed implements FeedAPI {
  readonly descriptor;
  private readonly tag: string;

  constructor(tag: string) {
    this.tag = tag.toLowerCase();
    this.descriptor = `hashtag|${this.tag}` as const;
  }

  async peekLatest(context: FeedContext): Promise<HydratedPost | undefined> {
    const post = await Post.findOne({
      hashtags: this.tag,
      visibility: 'public',
    })
      .select(FEED_FIELDS)
      .sort({ createdAt: -1 })
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

    const match: any = {
      hashtags: this.tag,
      visibility: 'public',
    };
    ChronoCursor.applyToQuery(match, cursor);

    const posts = await Post.find(match)
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
        logger.warn('[HashtagFeed] Cursor did not advance', { cursor, nextCursor });
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
}
