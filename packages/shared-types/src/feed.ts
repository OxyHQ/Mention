/**
 * Feed-related types for Mention social network
 */

import { Post } from './post';
import { Profile, OxyUser } from './profile';

export enum FeedType {
  HOME = 'home',
  EXPLORE = 'explore',
  TRENDING = 'trending',
  LATEST = 'latest',
  TOP = 'top',
  FOLLOWING = 'following',
  FOR_YOU = 'for_you',
  BOOKMARKS = 'bookmarks',
  LIKES = 'likes',
  USER_PROFILE = 'user_profile',
  HASHTAG = 'hashtag',
  SEARCH = 'search'
}

export enum FeedAlgorithm {
  CHRONOLOGICAL = 'chronological',
  RELEVANCE = 'relevance',
  ENGAGEMENT = 'engagement',
  PERSONALIZED = 'personalized'
}

export interface Feed {
  id: string;
  type: FeedType;
  algorithm: FeedAlgorithm;
  posts: Post[];
  hasMore: boolean;
  nextCursor?: string;
  refreshToken?: string;
  lastUpdated: string;
}

export interface TimelineFeed extends Feed {
  type: FeedType.HOME | FeedType.FOLLOWING | FeedType.FOR_YOU;
  algorithm: FeedAlgorithm;
}

export interface ExploreFeed extends Feed {
  type: FeedType.EXPLORE | FeedType.TRENDING;
  trendingTopics: TrendingTopic[];
  suggestedProfiles: Profile[];
}

export interface UserProfileFeed extends Feed {
  type: FeedType.USER_PROFILE;
  oxyUserId: string; // Links to Oxy user
  filter: 'posts' | 'replies' | 'media' | 'likes';
}

export interface HashtagFeed extends Feed {
  type: FeedType.HASHTAG;
  hashtag: string;
  postCount: number;
}

export interface SearchFeed extends Feed {
  type: FeedType.SEARCH;
  query: string;
  filters: SearchFilters;
  results: SearchResults;
}

export interface TrendingTopic {
  id: string;
  name: string;
  hashtag: string;
  postCount: number;
  trendDirection: 'up' | 'down' | 'stable';
  category?: string;
  isPromoted: boolean;
  createdAt: string;
}

export interface SearchResults {
  posts: Post[];
  profiles: Profile[];
  hashtags: string[];
  totalPosts: number;
  totalProfiles: number;
  totalHashtags: number;
}

export interface SearchFilters {
  type?: 'posts' | 'users' | 'hashtags' | 'all';
  dateFrom?: string;
  dateTo?: string;
  language?: string;
  isVerified?: boolean;
  hasMedia?: boolean;
  hasLinks?: boolean;
  isSensitive?: boolean;
}

export interface FeedPreferences {
  algorithm: FeedAlgorithm;
  showRetweets: boolean;
  showReplies: boolean;
  showQuotes: boolean;
  showMedia: boolean;
  showSensitiveContent: boolean;
  autoRefresh: boolean;
  refreshInterval: number; // in minutes
}

export interface FeedRequest {
  type: FeedType;
  algorithm?: FeedAlgorithm;
  cursor?: string;
  limit?: number;
  filters?: FeedFilters;
  oxyUserId?: string; // for user-specific feeds
  hashtag?: string; // for hashtag feeds
  query?: string; // for search feeds
}

export interface FeedFilters {
  includeRetweets?: boolean;
  includeReplies?: boolean;
  includeQuotes?: boolean;
  includeMedia?: boolean;
  includeSensitive?: boolean;
  language?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface FeedStats {
  totalPosts: number;
  totalUsers: number;
  totalInteractions: number;
  averageEngagement: number;
  topHashtags: string[];
  topMentions: string[];
  trendingTopics: TrendingTopic[];
}

export interface FeedRefreshRequest {
  feedId: string;
  refreshToken?: string;
  forceRefresh?: boolean;
}

export interface FeedRefreshResponse {
  newPosts: Post[];
  updatedPosts: Post[];
  removedPosts: string[];
  hasMore: boolean;
  nextCursor?: string;
  refreshToken?: string;
  lastUpdated: string;
} 