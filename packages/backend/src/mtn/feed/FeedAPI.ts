/**
 * FeedAPI Interface
 *
 * Unified interface for all feed sources. Every feed type implements this.
 * Replaces the IFeedStrategy interface.
 */

import { FeedPostSlice, HydratedPost, SlicedFeedResponse } from '@mention/shared-types';
import { FeedDescriptor } from '@mention/shared-types';

export interface FeedAPIResponse {
  slices: FeedPostSlice[];
  items: HydratedPost[];
  nextCursor?: string;
  hasMore: boolean;
  totalCount: number;
}

export interface FeedFetchOptions {
  cursor?: string;
  limit: number;
}

export interface FeedContext {
  currentUserId?: string;
  followingIds?: string[];
  userBehavior?: any;
  feedSettings?: any;
  oxyClient?: any;
}

export interface FeedAPI {
  readonly descriptor: FeedDescriptor;

  /**
   * Peek at the latest item without consuming cursor.
   * Used for "new posts" indicators.
   */
  peekLatest(context: FeedContext): Promise<HydratedPost | undefined>;

  /**
   * Fetch a page of feed items.
   */
  fetch(options: FeedFetchOptions, context: FeedContext): Promise<FeedAPIResponse>;
}

/** Standard fields to select from Post collection */
export const FEED_FIELDS = '_id oxyUserId federation createdAt visibility type parentPostId repostOf quoteOf threadId content stats metadata hashtags mentions language';
