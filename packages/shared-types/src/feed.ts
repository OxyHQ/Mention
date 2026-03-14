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

export interface FeedRepost extends HydratedPost {
  originalPostId?: string;
}

// Feed types and actions
export type FeedType = 'posts' | 'media' | 'replies' | 'likes' | 'reposts' | 'mixed' | 'for_you' | 'following' | 'saved' | 'explore' | 'custom';

export type PostAction = 'reply' | 'repost' | 'like' | 'share';

// Feed data structures
export interface FeedItem {
  id: string;
  type: 'post' | 'reply' | 'repost';
  data: HydratedPost | Reply | FeedRepost;
  createdAt: string;
  updatedAt: string;
}

export interface FeedResponse {
  items: HydratedPost[];
  hasMore: boolean;
  nextCursor?: string;
  totalCount: number;
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
  includeReposts?: boolean;
  includeMedia?: boolean;
  includeSensitive?: boolean;
  language?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface FeedStats {
  totalPosts: number;
  totalReplies: number;
  totalReposts: number;
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

export interface CreateRepostRequest {
  originalPostId: string;
  content?: PostContent;
  visibility?: PostVisibility;
  mentions?: string[];
  hashtags?: string[];
}

export interface LikeRequest {
  postId: string;
  type: 'post' | 'reply' | 'repost';
}

export interface UnlikeRequest {
  postId: string;
  type: 'post' | 'reply' | 'repost';
}

export interface ShareRequest {
  postId: string;
  type: 'post' | 'reply' | 'repost';
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
  | { type: 'repost'; actor: PostActorSummary }
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
}
