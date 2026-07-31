import { authenticatedClient } from '../utils/api';

/**
 * Client for the viewer's own analytics — the data behind the Insights screen,
 * the weekly recap and a post's insights sheet.
 *
 * The SERVER routes are still `/statistics/*`. This module is named for the
 * feature the app ships (Insights); renaming the API is a backend change and
 * deliberately not part of this one.
 */
const INSIGHTS_BASE = '/statistics';

/** Default window for every period-scoped query, in days. */
const DEFAULT_PERIOD_DAYS = 30;

export interface AccountInsights {
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
    boosts: number;
    shares: number;
  };
  dailyBreakdown: {
    date: string;
    views: number;
    likes: number;
    replies: number;
    boosts: number;
    interactions: number;
  }[];
  topPosts: {
    postId: string;
    views: number;
    likes: number;
    replies: number;
    boosts: number;
    engagement: number;
    createdAt: string;
  }[];
  postsByType: Record<string, number>;
}

export interface PostInsights {
  postId: string;
  createdAt: string;
  stats: {
    views: number;
    likes: number;
    replies: number;
    boosts: number;
    quotes: number;
    shares: number;
  };
  engagement: {
    totalInteractions: number;
    engagementRate: number;
    reach: number;
    uniqueViewers: number | null;
  };
  breakdown: {
    likedBy: number;
    hasReplies: boolean;
    hasBoosts: boolean;
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
    boostRate: number;
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
    boosts: number;
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
  followerChanges: {
    date: string;
    change: number;
    total: number;
  }[];
  estimatedGrowth: {
    interactions: number;
    note: string;
  };
}

export interface WeeklySummary {
  summary: string | null;
}

/** Acknowledgement of a recorded post view, carrying the fresh total. */
export interface PostViewAck {
  success: boolean;
  viewsCount: number;
}

class InsightsService {
  /** Account-level analytics over the given window. */
  async getAccountInsights(days: number = DEFAULT_PERIOD_DAYS): Promise<AccountInsights> {
    const response = await authenticatedClient.get<AccountInsights>(`${INSIGHTS_BASE}/user`, {
      params: { days },
    });
    return response.data;
  }

  /** Per-post analytics behind the post insights sheet. */
  async getPostInsights(postId: string): Promise<PostInsights> {
    const response = await authenticatedClient.get<PostInsights>(
      `${INSIGHTS_BASE}/post/${postId}`,
    );
    return response.data;
  }

  /** Record one view of a post. Fire-and-forget at every call site. */
  async trackPostView(postId: string): Promise<PostViewAck> {
    const response = await authenticatedClient.post<PostViewAck>(
      `${INSIGHTS_BASE}/post/${postId}/view`,
    );
    return response.data;
  }

  /** Follower-count movement across the window. */
  async getFollowerChanges(days: number = DEFAULT_PERIOD_DAYS): Promise<FollowerChanges> {
    const response = await authenticatedClient.get<FollowerChanges>(`${INSIGHTS_BASE}/followers`, {
      params: { days },
    });
    return response.data;
  }

  /** Engagement ratios, averages and totals for the window. */
  async getEngagementRatios(days: number = DEFAULT_PERIOD_DAYS): Promise<EngagementRatios> {
    const response = await authenticatedClient.get<EngagementRatios>(
      `${INSIGHTS_BASE}/engagement`,
      { params: { days } },
    );
    return response.data;
  }

  /** AI-generated recap of the viewer's week; `summary` is null when unavailable. */
  async getWeeklySummary(): Promise<WeeklySummary> {
    const response = await authenticatedClient.get<WeeklySummary>(
      `${INSIGHTS_BASE}/weekly-summary`,
    );
    return response.data;
  }
}

export const insightsService = new InsightsService();
