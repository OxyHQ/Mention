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

/**
 * Standard fields to select from Post collection.
 *
 * Includes the minimal `postClassification` projection ranking needs to read the
 * quality/safety signals: `scores` + `status` + `version` (consumed by
 * FeedRankingService — `status`/`version` are the provenance markers that
 * distinguish real AI / deterministic-baseline scores from the schema-default
 * placeholder), plus `topics`/`language` (used by topic/locale ranking &
 * candidate generation) and `topicRefs` (registry-linked canonical topics for
 * personalization / hidden-topic suppression). `extracted.topics` is the legacy
 * fallback ranking reads when a post predates `topicRefs`. Ranking treats an
 * absent / un-baselined classification as NEUTRAL.
 */
export const FEED_FIELDS = '_id oxyUserId federation createdAt visibility type parentPostId boostOf quoteOf threadId content stats metadata hashtags mentions language postClassification.scores postClassification.status postClassification.version postClassification.sensitive postClassification.topics postClassification.topicRefs postClassification.language extracted.topics';
