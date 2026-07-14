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

// Feed data structures
export interface FeedItem {
  id: string;
  type: 'post' | 'reply' | 'boost';
  data: HydratedPost | Reply | FeedBoost;
  createdAt: string;
  updatedAt: string;
}

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

export interface FeedStats {
  totalPosts: number;
  totalReplies: number;
  totalBoosts: number;
  totalLikes: number;
  averageEngagement: number;
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

export interface ShareRequest {
  postId: string;
  type: 'post' | 'reply' | 'boost';
  platform?: 'twitter' | 'facebook' | 'linkedin' | 'copy';
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

/** The three kinds of recommendation card the feed can carry. */
export type FeedInterstitialKind =
  | 'suggestedUsers'
  | 'suggestedFeeds'
  | 'suggestedStarterPacks';

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
}

export interface SlicedFeedResponse {
  slices: FeedPostSlice[];
  items: HydratedPost[]; // backward compat: flattened slices
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
