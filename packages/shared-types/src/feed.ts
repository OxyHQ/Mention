/**
 * Feed types for Mention social network
 * Shared between frontend and backend
 */

import { Post as DomainPost, PostContent, PostVisibility } from './post';

// Common user interface for feed items
export interface FeedUser {
  id?: string;
  name: string;
  handle: string;
  avatar: string;
  verified: boolean;
}

// Common engagement interface for feed items
export interface FeedEngagement {
  replies: number;
  reposts: number;
  likes: number;
}

// Feed item types for frontend components
export interface Post {
  id: string;
  user: FeedUser;
  content: PostContent | string; // Support both new PostContent structure and legacy string
  date: string;
  engagement: FeedEngagement;
  media?: string[];
  isLiked?: boolean;
  isReposted?: boolean;
  isSaved?: boolean;
}

export interface Reply {
  id: string;
  postId: string;
  user: FeedUser;
  content: PostContent | string; // Support both new PostContent structure and legacy string
  date: string;
  engagement: FeedEngagement;
  isLiked?: boolean;
  isReposted?: boolean;
  isSaved?: boolean;
}

export interface FeedRepost {
  id: string;
  originalPostId: string;
  user: FeedUser;
  date: string;
  engagement: FeedEngagement;
  isLiked?: boolean;
  isReposted?: boolean;
  isSaved?: boolean;
}

// Feed types and actions
export type FeedType = 'posts' | 'media' | 'replies' | 'likes' | 'reposts' | 'mixed' | 'for_you' | 'following';

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
  items: FeedItem[];
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
