/**
 * FeedAPI Interface
 *
 * Unified interface for all feed sources. Every feed type implements this.
 * Replaces the IFeedStrategy interface.
 */

import { FeedPostSlice, HydratedPost } from '@mention/shared-types';
import { FeedDescriptor } from '@mention/shared-types';
import type { FeedTuning } from '@mention/shared-types';
import type { RankingUserBehavior, FeedRankingSettings } from '../../services/ranking/signalContext';
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
   * The viewer's follower ids (accounts that follow the viewer), resolved ONCE
   * per feed request by `loadViewerFeedContext` alongside `followingIds`. Threaded
   * into `PostHydrationService` so hydration does NOT re-fetch `getUserFollowers`
   * from Oxy on the feed path (used there for reciprocal-relationship checks).
   * Absent for anonymous viewers.
   */
  followerIds?: string[];
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
  /**
   * The viewer's Oxy account locales as canonical BCP-47 (`es-ES`, `en-US`),
   * primary first, resolved by `loadViewerFeedContext`. REGION-SIGNIFICANT: this
   * is what hydration resolves a post's VARIANT against, and `selectVariantForTag`
   * prefers the exact locale over the base subtag, so `pt-BR` and `pt-PT` are
   * different answers. `[]` for an anonymous viewer.
   *
   * NOT the readability set — see {@link viewerBaseLanguages}, which answers a
   * different question in a different unit.
   */
  viewerLanguages?: string[];
  /**
   * The reader's READABILITY set: which languages they can read at all, as ISO
   * 639-1 BASE subtags, primary first, capped at 3. Resolved from the Oxy account,
   * else the request (`?lang=`, then `Accept-Language`) — so unlike
   * {@link viewerLanguages} it is populated for an ANONYMOUS reader, which is the
   * reader whose For You had no language signal at all. Never derived from
   * behavior: the learned array that used to drive this was appended to on any
   * interaction including a SKIP, so it drifted toward whatever the feed had
   * already shown.
   *
   * Base form, so it is already in the same unit as
   * `posts.classification_languages` and no consumer re-derives it. Region is
   * deliberately discarded — a Mexican Spanish reader reads Spain's Spanish.
   *
   * Three consumers, in descending strength: `viewerLanguageSql` (a HARD SQL
   * predicate on the discovery lanes and the popular fallback),
   * `languageMismatchPenalty` (the soft downrank covering what reaches ranking
   * without passing one of those queries), and the Discover relevance BOOST
   * (which orders and never excludes).
   *
   * EMPTY / absent ⇒ all three go neutral. An unknown reader is never filtered,
   * only an unmatched one.
   */
  viewerBaseLanguages?: string[];
  /**
   * The viewer's Mention-local per-user FEED TUNING (Phase 4B), loaded from
   * `UserSettings.feedTuning` by `loadViewerFeedContext`. The For You
   * discovery-gate filter modules read `feedTuning.forYou` as EFFECTIVE overrides
   * layered over the `MtnConfig.feed.discoveryGate` config defaults (toggle a gate
   * module off / re-tune its threshold for THIS viewer only), while
   * `forYouDefinition` stays static. Absent for anonymous viewers, viewers with no
   * tuning, or on any load failure ⇒ the config-default gate applies unchanged.
   */
  feedTuning?: FeedTuning;
  /**
   * Lane ids THIS reader has silenced (`LaneMute`), resolved once per request by
   * `loadViewerFeedContext`. Applied by `FeedEngine` as an in-memory predicate
   * over the merged pool — see there for why it is not a `FilterModule` and not a
   * Mongo clause. Empty / absent for anonymous readers and for the overwhelming
   * majority of authenticated ones, in which case the predicate is never built.
   */
  mutedLaneIds?: string[];
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

