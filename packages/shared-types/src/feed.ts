/**
 * Feed types for Mention social network
 * Shared between frontend and backend
 */

import {
  HydratedPost,
  PostContent,
  PostContentInput,
  PostVisibility,
  PostUser,
} from './post';

export interface Reply extends HydratedPost {
  postId?: string;
}

export interface FeedBoost extends HydratedPost {
  originalPostId?: string;
}

// Feed types and actions
export type FeedType = 'posts' | 'media' | 'replies' | 'likes' | 'boosts' | 'mixed' | 'for_you' | 'following' | 'saved' | 'explore' | 'videos' | 'custom' | 'hashtag' | 'topic' | 'trending' | 'mutuals' | 'friends_popular' | 'friends_of_friends';

export type PostAction = 'reply' | 'boost' | 'like' | 'share';

export interface FeedResponse {
  items: HydratedPost[];
  hasMore: boolean;
  nextCursor?: string;
  totalCount: number;
  /**
   * Set to `true` when the feed is still being populated asynchronously
   * (e.g. a federated user's ActivityPub outbox is syncing in the background).
   * Clients should show a brief loading state and refetch shortly after.
   */
  pending?: boolean;
}

// Feed request and filtering
export interface FeedRequest {
  type: FeedType;
  cursor?: string;
  limit?: number;
  userId?: string;
  filters?: FeedFilters;
}

export interface FeedFilters {
  includeReplies?: boolean;
  includeBoosts?: boolean;
  includeMedia?: boolean;
  includeSensitive?: boolean;
  language?: string;
  dateFrom?: string;
  dateTo?: string;
}

// API request types
export interface CreateReplyRequest {
  postId: string;
  content: PostContentInput;
  visibility?: PostVisibility;
  mentions?: string[];
  hashtags?: string[];
}

export interface CreateBoostRequest {
  originalPostId: string;
  content?: PostContentInput;
  visibility?: PostVisibility;
  mentions?: string[];
  hashtags?: string[];
}

export interface LikeRequest {
  postId: string;
  type: 'post' | 'reply' | 'boost';
}

export interface UnlikeRequest {
  postId: string;
  type: 'post' | 'reply' | 'boost';
}

// Thread slicing types for grouped feed rendering

export interface FeedSliceItem {
  post: HydratedPost;
  isThreadParent: boolean;
  isThreadChild: boolean;
  isThreadLastChild: boolean;
}

export type FeedSliceReason =
  | { type: 'boost'; actor: PostUser }
  | { type: 'replyContext'; parentAuthor: PostUser }
  | { type: 'selfThread' };

export interface FeedPostSlice {
  _sliceKey: string;
  items: FeedSliceItem[];
  isIncompleteThread: boolean;
  reason?: FeedSliceReason;
}

// Feed interstitials — recommendation cards spliced between post slices

/**
 * The kinds of recommendation card the feed can carry.
 *
 * `similarAccounts` is the PROFILE-feed card ("accounts similar to the profile
 * you are viewing"). It is the only kind driven by the feed's SUBJECT rather
 * than the viewer's own graph, and it is the only one that carries `subjectId`.
 */
export type FeedInterstitialKind =
  | 'suggestedUsers'
  | 'suggestedFeeds'
  | 'suggestedStarterPacks'
  | 'similarAccounts';

/**
 * A recommendation card's PLACEMENT, not its content. The server decides which
 * kind of card goes where (a synchronous, I/O-free computation off the viewer's
 * follow-graph density); the client lazily fetches what goes inside it from the
 * dedicated, already-cached recommendation endpoints. A feed response therefore
 * never blocks on recommendation data.
 *
 * Slots live at the TOP LEVEL of the response, never inside `slices[].items` —
 * that array is flattened into `items[]` (`FeedResponseBuilder`) and must stay
 * strictly posts for every existing client.
 */
export interface FeedInterstitialSlot {
  /** Stable row key. Survives re-renders; changes when the feed is refreshed. */
  key: string;
  kind: FeedInterstitialKind;
  /**
   * The slot renders directly AFTER the slice with this key. Anchored by slice
   * key rather than index because the client drops slices of its own accord
   * (blocked authors). A slot whose anchor slice is absent is discarded.
   */
  afterSliceKey: string;
  /**
   * The profile the suggestions are ABOUT — set only for `similarAccounts`, where
   * the card answers "who is like the account whose feed you're reading". Never
   * the viewer: the server drops the card on your own profile.
   */
  subjectId?: string;
}

/**
 * What a viewer did with a recommendation card. Reported to
 * `POST /feed/mtn/interstitial-events`, NOT to the post-interaction route: that
 * one requires a `postUri` and feeds post ranking, so card events would corrupt
 * author/topic affinity with engagement that never touched a post.
 *
 * These land as low-cardinality COUNTERS, never per-row documents — the point is
 * "are people following anyone from the feed", not who followed whom.
 */
export type FeedInterstitialEventName =
  | 'impression'
  | 'click'
  | 'follow'
  | 'subscribe'
  | 'use'
  | 'dismiss'
  | 'seeMore';

export interface FeedInterstitialEventInput {
  feedDescriptor: string;
  slotKey: string;
  kind: FeedInterstitialKind;
  event: FeedInterstitialEventName;
  /** Zero-based index of the item within the card. Absent for card-level events. */
  position?: number;
}

export interface SlicedFeedResponse {
  slices: FeedPostSlice[];
  /**
   * The flat post list. NOT a legacy mirror of `slices` — it is LOAD-BEARING and
   * is the SOLE representation for every feed that returns no slices at all:
   * saved posts, the author-likes feed, and the anonymous For You / Videos /
   * Media fallbacks (`FeedEngine.finalizeOrdered` / `runPopularFallback` emit
   * `slices: []`). The client's flat-items branch in `buildFeedRows` is their
   * live render path. Sliced feeds populate BOTH, so any tuner that mutates
   * `slices` must re-flatten into `items` (`FeedResponseBuilder`).
   */
  items: HydratedPost[];
  hasMore: boolean;
  nextCursor?: string;
  totalCount: number;
  /**
   * Set to `true` when the feed is still being populated asynchronously
   * (e.g. a federated user's ActivityPub outbox is syncing in the background).
   * Clients should show a brief loading state and refetch shortly after.
   */
  pending?: boolean;
  /**
   * Recommendation-card placements for THIS page. Only ever present for
   * authenticated viewers on the descriptors in
   * `MtnConfig.feed.interstitials.allowedDescriptors`.
   */
  interstitials?: FeedInterstitialSlot[];
}
