import { authenticatedClient } from '../utils/api';

/**
 * Client for the analytics behind the Insights screen, the weekly recap and a
 * post's insights sheet.
 *
 * The SERVER routes are still `/statistics/*`. This module is named for the
 * feature the app ships (Insights); renaming the API is a backend change and
 * deliberately not part of this one.
 *
 * ## Whose numbers
 *
 * The period-scoped reads take an optional `accountId` — the account the numbers
 * are ABOUT, which is the signed-in viewer whenever it is omitted. It exists for
 * accounts that have no login of their own: a channel can never be signed in as,
 * so without a subject parameter its own operators had no way to ask for its
 * numbers at all.
 *
 * The server decides who may name one (any active member of a channel; an
 * `account:act_as` holder for an organization / project / bot) and answers 403
 * otherwise — it never quietly substitutes the caller's own numbers, so a
 * dashboard on screen is always the account it says it is.
 *
 * {@link InsightsService.getWeeklySummary} deliberately takes NO account: it is a
 * second-person retrospective addressed to the reader, and the screens keep it on
 * the viewer's own insights only.
 */
const INSIGHTS_BASE = '/statistics';

/** Default window for every period-scoped query, in days. */
const DEFAULT_PERIOD_DAYS = 30;

/**
 * The account a period-scoped read is about. Omitted ⇒ the signed-in viewer,
 * which is what every call made before channels had an insights page.
 */
export interface InsightsSubjectOptions {
  accountId?: string;
}

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

/**
 * The query for a period-scoped read. `accountId` is omitted entirely rather than
 * sent empty when there is no subject, so the ordinary viewer request stays
 * byte-identical to the one this app has always made — the server reads an absent
 * parameter and a self-naming one the same way, but an empty string is neither.
 */
function subjectParams(
  days: number,
  options: InsightsSubjectOptions,
): Record<string, string | number> {
  const accountId = options.accountId?.trim();
  return accountId ? { days, accountId } : { days };
}

class InsightsService {
  /** Account-level analytics over the given window. */
  async getAccountInsights(
    days: number = DEFAULT_PERIOD_DAYS,
    options: InsightsSubjectOptions = {},
  ): Promise<AccountInsights> {
    const response = await authenticatedClient.get<AccountInsights>(`${INSIGHTS_BASE}/user`, {
      params: subjectParams(days, options),
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
  async getEngagementRatios(
    days: number = DEFAULT_PERIOD_DAYS,
    options: InsightsSubjectOptions = {},
  ): Promise<EngagementRatios> {
    const response = await authenticatedClient.get<EngagementRatios>(
      `${INSIGHTS_BASE}/engagement`,
      { params: subjectParams(days, options) },
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
