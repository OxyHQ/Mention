/**
 * Analytics-related types for Mention social network
 */

import { Timestamps } from './common';

export enum AnalyticsPeriod {
  HOUR = 'hour',
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
  QUARTER = 'quarter',
  YEAR = 'year'
}

export enum AnalyticsMetric {
  POSTS = 'posts',
  LIKES = 'likes',
  REPOSTS = 'reposts',
  COMMENTS = 'comments',
  VIEWS = 'views',
  FOLLOWERS = 'followers',
  FOLLOWING = 'following',
  ENGAGEMENT = 'engagement',
  REACH = 'reach',
  IMPRESSIONS = 'impressions'
}

export interface AnalyticsData {
  id: string;
  oxyUserId?: string; // Links to Oxy user
  postId?: string;
  metric: AnalyticsMetric;
  period: AnalyticsPeriod;
  value: number;
  timestamp: string;
  metadata?: Record<string, any>;
}

export interface UserAnalytics {
  oxyUserId: string; // Links to Oxy user
  period: AnalyticsPeriod;
  startDate: string;
  endDate: string;
  metrics: {
    posts: number;
    likes: number;
    reposts: number;
    comments: number;
    views: number;
    followers: number;
    following: number;
    engagement: number;
    reach: number;
    impressions: number;
  };
  trends: AnalyticsTrend[];
  topPosts: PostAnalytics[];
  topHashtags: HashtagAnalytics[];
  audience: AudienceAnalytics;
}

export interface PostAnalytics {
  postId: string;
  views: number;
  likes: number;
  reposts: number;
  comments: number;
  shares: number;
  engagement: number;
  reach: number;
  impressions: number;
  clickThroughRate: number;
  timeSpent: number; // average time spent viewing
  demographics: DemographicData;
  geographicData: GeographicData[];
}

export interface HashtagAnalytics {
  hashtag: string;
  postCount: number;
  reach: number;
  impressions: number;
  engagement: number;
  trendDirection: 'up' | 'down' | 'stable';
  topPosts: string[]; // post IDs
}

export interface AudienceAnalytics {
  totalFollowers: number;
  activeFollowers: number;
  newFollowers: number;
  lostFollowers: number;
  demographics: DemographicData;
  geographicData: GeographicData[];
  interests: InterestData[];
  activityTimes: ActivityTimeData[];
}

export interface DemographicData {
  ageGroups: Record<string, number>;
  genders: Record<string, number>;
  languages: Record<string, number>;
  devices: Record<string, number>;
}

export interface GeographicData {
  country: string;
  region?: string;
  city?: string;
  count: number;
  percentage: number;
}

export interface InterestData {
  category: string;
  count: number;
  percentage: number;
}

export interface ActivityTimeData {
  hour: number;
  dayOfWeek: number;
  count: number;
  percentage: number;
}

export interface AnalyticsTrend {
  metric: AnalyticsMetric;
  values: Array<{
    timestamp: string;
    value: number;
  }>;
  change: number; // percentage change
  trend: 'up' | 'down' | 'stable';
}

export interface AnalyticsRequest {
  oxyUserId?: string; // Links to Oxy user
  postId?: string;
  metrics: AnalyticsMetric[];
  period: AnalyticsPeriod;
  startDate: string;
  endDate: string;
  groupBy?: 'hour' | 'day' | 'week' | 'month';
}

export interface AnalyticsResponse {
  data: AnalyticsData[];
  trends: AnalyticsTrend[];
  summary: Record<AnalyticsMetric, number>;
  period: AnalyticsPeriod;
  startDate: string;
  endDate: string;
}

export interface PlatformAnalytics {
  totalUsers: number;
  activeUsers: number;
  totalPosts: number;
  totalInteractions: number;
  engagementRate: number;
  topTrendingTopics: string[];
  topInfluencers: string[]; // oxyUserIds
  geographicDistribution: GeographicData[];
  platformGrowth: AnalyticsTrend[];
} 