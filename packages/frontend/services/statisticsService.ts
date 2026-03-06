import { authenticatedClient } from '../utils/api';

export interface UserStatistics {
  period: {
    startDate: string;
    endDate: string;
    days: number;
  };
  overview: {
    totalPosts: number;
    totalViews: number;
    totalInteractions: number;
    engagementRate: number;
    averageEngagementPerPost: number;
  };
  interactions: {
    likes: number;
    replies: number;
    reposts: number;
    shares: number;
  };
  dailyBreakdown: Array<{
    date: string;
    views: number;
    likes: number;
    replies: number;
    reposts: number;
    interactions: number;
  }>;
  topPosts: Array<{
    postId: string;
    views: number;
    likes: number;
    replies: number;
    reposts: number;
    engagement: number;
    createdAt: string;
  }>;
  postsByType: Record<string, number>;
}

export interface PostInsights {
  postId: string;
  createdAt: string;
  stats: {
    views: number;
    likes: number;
    replies: number;
    reposts: number;
    quotes: number;
    shares: number;
  };
  engagement: {
    totalInteractions: number;
    engagementRate: number;
    reach: number;
    uniqueViewers: number;
  };
  breakdown: {
    likedBy: number;
    hasReplies: boolean;
    hasReposts: boolean;
    hasQuotes: boolean;
  };
}

export interface EngagementRatios {
  period: {
    startDate: string;
    endDate: string;
    days: number;
  };
  ratios: {
    engagementRate: number;
    likeRate: number;
    replyRate: number;
    repostRate: number;
    shareRate: number;
  };
  averages: {
    viewsPerPost: number;
    engagementPerPost: number;
  };
  totals: {
    posts: number;
    views: number;
    interactions: number;
    likes: number;
    replies: number;
    reposts: number;
    shares: number;
  };
}

export interface FollowerChanges {
  period: {
    startDate: string;
    endDate: string;
    days: number;
  };
  currentFollowers: number;
  followerChanges: Array<{
    date: string;
    change: number;
    total: number;
  }>;
  estimatedGrowth: {
    interactions: number;
    note: string;
  };
}

class StatisticsService {
  /**
   * Get user statistics (overall analytics)
   */
  async getUserStatistics(days: number = 30): Promise<UserStatistics> {
    const response = await authenticatedClient.get('/statistics/user', {
      params: { days }
    });
    return response.data;
  }

  /**
   * Get post-specific insights
   */
  async getPostInsights(postId: string): Promise<PostInsights> {
    const response = await authenticatedClient.get(`/statistics/post/${postId}`);
    return response.data;
  }

  /**
   * Track post view
   */
  async trackPostView(postId: string): Promise<{ success: boolean; viewsCount: number }> {
    const response = await authenticatedClient.post(`/statistics/post/${postId}/view`);
    return response.data;
  }

  /**
   * Get follower changes over time
   */
  async getFollowerChanges(days: number = 30): Promise<FollowerChanges> {
    const response = await authenticatedClient.get('/statistics/followers', {
      params: { days }
    });
    return response.data;
  }

  /**
   * Get engagement ratios and performance metrics
   */
  async getEngagementRatios(days: number = 30): Promise<EngagementRatios> {
    const response = await authenticatedClient.get('/statistics/engagement', {
      params: { days }
    });
    return response.data;
  }
}

export const statisticsService = new StatisticsService();

