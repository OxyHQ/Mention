/**
 * FeedAPI Interface
 *
 * Unified interface for all feed sources. Every feed type implements this.
 * Replaces the IFeedStrategy interface.
 */

import { FeedPostSlice, HydratedPost, SlicedFeedResponse } from '@mention/shared-types';
import { FeedDescriptor } from '@mention/shared-types';
import type { RankingUserBehavior, FeedRankingSettings } from '../../services/FeedRankingService';
import type { OxyClient } from '../../utils/privacyHelpers';

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
  /**
   * Author ids from lists the viewer subscribes to. These are feed-inclusion
   * candidates only and MUST NOT be treated as follow relationships for
   * followers-only visibility checks.
   */
  subscribedListMemberIds?: string[];
  userBehavior?: RankingUserBehavior;
  feedSettings?: FeedRankingSettings;
  oxyClient?: OxyClient;
  /**
   * The viewer's DOMINANT learned coarse region (the highest-count
   * `userBehavior.preferredRegions` entry), resolved once by the controller via
   * `UserPreferenceService.getTopRegion`. Consumed as a BEST-EFFORT relevance
   * signal by the For You region candidate source and the authenticated Explore
   * relevance boost. Frequently `undefined` (post region is sparse), in which
   * case every region-conditional path is a strict no-op — never an error, never
   * an empty feed. Absent for anonymous viewers.
   */
  viewerRegion?: string;
  /**
   * Whether THIS viewer has opted in to seeing sensitive / NSFW content. When
   * `true`, discovery surfaces (For You, Explore) and ranking do NOT exclude or
   * zero sensitive posts for this viewer; the posts still carry their sensitive
   * flag for client-side blur / content warnings. Defaults to `false`
   * (safe-for-work) for anonymous viewers and on any load failure.
   */
  showSensitiveContent?: boolean;
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
 * placeholder), plus `topics` and `postClassification.languages` (used by
 * topic/locale ranking & candidate generation; the top-level AP `language` is
 * projected separately above) and `topicRefs` (registry-linked canonical topics
 * for personalization / hidden-topic suppression). Ranking reads `topicRefs`
 * first and falls back to the slug-only `topics`; it treats an absent /
 * un-baselined classification as NEUTRAL.
 */
export const FEED_FIELDS = '_id oxyUserId authorship federation createdAt visibility type parentPostId boostOf quoteOf threadId content stats metadata hashtags mentions language postClassification.scores postClassification.status postClassification.version postClassification.sensitive postClassification.topics postClassification.topicRefs postClassification.languages postClassification.sentiment';
