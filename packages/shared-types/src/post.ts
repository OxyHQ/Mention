/**
 * Post-related types for Mention social network
 */

import { Timestamps, Coordinates, GeoJSONPoint } from './common';

export enum PostType {
  TEXT = 'text',
  IMAGE = 'image',
  VIDEO = 'video',
  POLL = 'poll',
  REPOST = 'repost',
  QUOTE = 'quote'
}

export enum PostVisibility {
  PUBLIC = 'public',
  FOLLOWERS_ONLY = 'followers_only',
  PRIVATE = 'private'
}

export interface PostContent {
  text?: string;
  images?: string[];
  video?: string;
  poll?: PollData;
  location?: GeoJSONPoint;
}

export interface PollData {
  question: string;
  options: string[];
  endTime: string;
  votes: Record<string, number>; // option index -> vote count
  userVotes: Record<string, string>; // userId -> option index
}

export interface Post {
  id: string;
  _id?: string;
  oxyUserId: string; // Links to Oxy user
  type: PostType;
  content: PostContent;
  visibility: PostVisibility;
  isEdited: boolean;
  editHistory?: string[];
  language?: string;
  tags?: string[];
  mentions?: string[]; // oxyUserIds
  hashtags?: string[];
  repostOf?: string; // original post id
  quoteOf?: string; // quoted post id
  parentPostId?: string; // for replies
  threadId?: string; // for thread posts
  stats: PostStats;
  metadata: PostMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface PostStats {
  likesCount: number;
  repostsCount: number;
  commentsCount: number;
  viewsCount: number;
  sharesCount: number;
}

export interface PostMetadata {
  isSensitive?: boolean;
  isPinned?: boolean;
  isBookmarked?: boolean;
  isLiked?: boolean;
  isReposted?: boolean;
  isCommented?: boolean;
  isFollowingAuthor?: boolean;
  authorBlocked?: boolean;
  authorMuted?: boolean;
  // Track user interactions
  likedBy?: string[]; // Array of user IDs who liked this post
  savedBy?: string[]; // Array of user IDs who saved this post
}

export interface CreatePostRequest {
  content: PostContent;
  visibility?: PostVisibility;
  parentPostId?: string;
  threadId?: string;
  tags?: string[];
  mentions?: string[];
  hashtags?: string[];
}

export interface UpdatePostRequest {
  content?: PostContent;
  visibility?: PostVisibility;
  tags?: string[];
  mentions?: string[];
  hashtags?: string[];
}

export interface PostFeed {
  posts: Post[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface PostFilters {
  authorId?: string;
  type?: PostType;
  visibility?: PostVisibility;
  hashtags?: string[];
  mentions?: string[];
  dateFrom?: string;
  dateTo?: string;
  isEdited?: boolean;
} 