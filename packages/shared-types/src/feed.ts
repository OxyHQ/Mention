/**
 * Feed types for Mention social network
 * Shared between frontend and backend
 */

import {
  HydratedPost,
  PostContent,
  PostVisibility,
  PostActorSummary,
} from './post';

export interface Reply extends HydratedPost {
  postId?: string;
}

export interface FeedBoost extends HydratedPost {
  originalPostId?: string;
}

// Feed types and actions
export type FeedType = 'posts' | 'media' | 'replies' | 'likes' | 'boosts' | 'mixed' | 'for_you' | 'following' | 'saved' | 'explore' | 'videos' | 'custom' | 'hashtag' | 'topic';

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
  content: PostContent;
  visibility?: PostVisibility;
  mentions?: string[];
  hashtags?: string[];
}

export interface CreateBoostRequest {
  originalPostId: string;
  content?: PostContent;
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
  | { type: 'boost'; actor: PostActorSummary }
  | { type: 'replyContext'; parentAuthor: PostActorSummary }
  | { type: 'selfThread' };

export interface FeedPostSlice {
  _sliceKey: string;
  items: FeedSliceItem[];
  isIncompleteThread: boolean;
  reason?: FeedSliceReason;
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
}
