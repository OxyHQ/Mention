/**
 * Feed types for Mention social network
 * Shared between frontend and backend
 */

import {
  HydratedPost as DomainPost,
  PostContent,
  PostVisibility,
  PostActorSummary,
  PostEngagementSummary,
} from './post';

// Common user interface for feed items
export type FeedUser = PostActorSummary;

// Common engagement interface for feed items
export type FeedEngagement = PostEngagementSummary;

// Feed item types for frontend components
export type Post = DomainPost;

export interface Reply extends DomainPost {
  postId?: string;
}

export interface FeedRepost extends DomainPost {
  originalPostId?: string;
}

// Feed types and actions
export type FeedType = 'posts' | 'media' | 'replies' | 'likes' | 'reposts' | 'mixed' | 'for_you' | 'following' | 'saved' | 'explore' | 'custom';

export type PostAction = 'reply' | 'repost' | 'like' | 'share';

// Feed data structures
export interface FeedItem {
  id: string;
  type: 'post' | 'reply' | 'repost';
  data: DomainPost | Reply | FeedRepost;
  createdAt: string;
  updatedAt: string;
}

export interface FeedResponse {
  items: any[]; // HydratedPost[] - using any[] for flexibility during migration
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
