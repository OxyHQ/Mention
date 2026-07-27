import { Response } from "express";
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getBaseLanguage, getPrimaryLanguage } from '@oxyhq/core';
import { PostType, PostVisibility } from '@mention/shared-types';
import { resolveVariant } from '../services/postVariants';
import Post from "../models/Post";
import UserSettings from "../models/UserSettings";
import { logger } from '../utils/logger';
import { aliaChat, isAliaEnabled } from '../utils/alia';
import { getRuntimeOxyClient } from '../runtime/oxyClient';
import { userPreferenceService } from '../services/UserPreferenceService';
import { recordDedupedView } from '../services/feedViewCounter';
import { validateRequired } from '../utils/apiHelpers';
import { queryInt } from '../utils/queryParams';
import { checkFollowAccess, requiresAccessCheck, ProfileVisibility } from '../utils/privacyHelpers';

/**
 * Language the AI weekly summary is written in when the viewer's Oxy account
 * declares no language (ISO 639-1 base code, matching what the prompt expects).
 */
const DEFAULT_SUMMARY_LANGUAGE = 'en';

/** Trailing window the statistics endpoints report on when `?days` is absent. */
const DEFAULT_STATS_WINDOW_DAYS = 30;
const MAX_STATS_WINDOW_DAYS = 366;
const STATISTICS_QUERY_MAX_TIME_MS = 3_000;
const STATISTICS_CACHE_TTL_MS = 30_000;
const STATISTICS_CACHE_MAX_ENTRIES = 500;

interface DateRange {
  startDate: Date;
  endDate: Date;
}

function getDateRange(days: number = DEFAULT_STATS_WINDOW_DAYS): DateRange {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  return { startDate, endDate };
}

function requestedStatsDays(value: unknown): number {
  const parsed = queryInt(value);
  return parsed === undefined
    ? DEFAULT_STATS_WINDOW_DAYS
    : Math.min(MAX_STATS_WINDOW_DAYS, Math.max(1, parsed));
}

interface UserStatisticsPayload {
  period: { startDate: string; endDate: string; days: number };
  overview: {
    totalPosts: number;
    totalViews: number;
    totalInteractions: number;
    engagementRate: number;
    averageEngagementPerPost: number;
  };
  interactions: { likes: number; replies: number; boosts: number; shares: number };
  dailyBreakdown: Array<{
    date: string;
    views: number;
    likes: number;
    replies: number;
    boosts: number;
    interactions: number;
  }>;
  topPosts: Array<{
    postId: string;
    views: number;
    likes: number;
    replies: number;
    boosts: number;
    engagement: number;
    createdAt: Date;
  }>;
  postsByType: Record<string, number>;
}

const statisticsCache = new Map<
  string,
  { expiresAt: number; value: UserStatisticsPayload }
>();

function cacheStatistics(key: string, value: UserStatisticsPayload): void {
  statisticsCache.delete(key);
  statisticsCache.set(key, { expiresAt: Date.now() + STATISTICS_CACHE_TTL_MS, value });
  while (statisticsCache.size > STATISTICS_CACHE_MAX_ENTRIES) {
    const oldest = statisticsCache.keys().next().value as string | undefined;
    if (!oldest) break;
    statisticsCache.delete(oldest);
  }
}

function rounded(value: number): number {
  return Number(value.toFixed(2));
}

async function queryUserStatistics(
  userId: string,
  days: number,
): Promise<UserStatisticsPayload> {
  const cacheKey = `${userId}:${days}`;
  const cached = statisticsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    statisticsCache.delete(cacheKey);
    statisticsCache.set(cacheKey, cached);
    return cached.value;
  }
  if (cached) statisticsCache.delete(cacheKey);

  const { startDate, endDate } = getDateRange(days);
  const [facets] = await Post.aggregate<{
    overview: Array<{
      totalPosts: number;
      totalViews: number;
      totalLikes: number;
      totalReplies: number;
      totalBoosts: number;
      totalShares: number;
    }>;
    dailyBreakdown: UserStatisticsPayload['dailyBreakdown'];
    topPosts: UserStatisticsPayload['topPosts'];
    postsByType: Array<{ type: string; count: number }>;
  }>([
    {
      $match: {
        authorship: {
          $elemMatch: { oxyUserId: userId, role: 'owner' },
        },
        createdAt: { $gte: startDate, $lte: endDate },
      },
    },
    {
      $facet: {
        overview: [
          {
            $group: {
              _id: null,
              totalPosts: { $sum: 1 },
              totalViews: { $sum: { $ifNull: ['$stats.viewsCount', 0] } },
              totalLikes: { $sum: { $ifNull: ['$stats.likesCount', 0] } },
              totalReplies: { $sum: { $ifNull: ['$stats.commentsCount', 0] } },
              totalBoosts: { $sum: { $ifNull: ['$stats.boostsCount', 0] } },
              totalShares: { $sum: { $ifNull: ['$stats.sharesCount', 0] } },
            },
          },
        ],
        dailyBreakdown: [
          {
            $group: {
              _id: {
                $dateToString: {
                  format: '%Y-%m-%d',
                  date: '$createdAt',
                  timezone: 'UTC',
                },
              },
              views: { $sum: { $ifNull: ['$stats.viewsCount', 0] } },
              likes: { $sum: { $ifNull: ['$stats.likesCount', 0] } },
              replies: { $sum: { $ifNull: ['$stats.commentsCount', 0] } },
              boosts: { $sum: { $ifNull: ['$stats.boostsCount', 0] } },
              shares: { $sum: { $ifNull: ['$stats.sharesCount', 0] } },
            },
          },
          {
            $project: {
              _id: 0,
              date: '$_id',
              views: 1,
              likes: 1,
              replies: 1,
              boosts: 1,
              shares: 1,
            },
          },
          {
            $set: {
              interactions: { $add: ['$likes', '$replies', '$boosts', '$shares'] },
            },
          },
          { $unset: 'shares' },
          { $sort: { date: 1 } },
        ],
        topPosts: [
          {
            $project: {
              postId: { $toString: '$_id' },
              views: { $ifNull: ['$stats.viewsCount', 0] },
              likes: { $ifNull: ['$stats.likesCount', 0] },
              replies: { $ifNull: ['$stats.commentsCount', 0] },
              boosts: { $ifNull: ['$stats.boostsCount', 0] },
              shares: { $ifNull: ['$stats.sharesCount', 0] },
              createdAt: 1,
            },
          },
          {
            $set: {
              engagement: { $add: ['$likes', '$replies', '$boosts', '$shares'] },
            },
          },
          { $sort: { engagement: -1, createdAt: -1 } },
          { $limit: 10 },
          { $unset: 'shares' },
        ],
        postsByType: [
          { $group: { _id: { $ifNull: ['$type', 'text'] }, count: { $sum: 1 } } },
          { $project: { _id: 0, type: '$_id', count: 1 } },
        ],
      },
    },
  ]).option({ maxTimeMS: STATISTICS_QUERY_MAX_TIME_MS });

  const totals = facets?.overview[0] ?? {
    totalPosts: 0,
    totalViews: 0,
    totalLikes: 0,
    totalReplies: 0,
    totalBoosts: 0,
    totalShares: 0,
  };
  const totalInteractions =
    totals.totalLikes + totals.totalReplies + totals.totalBoosts + totals.totalShares;
  const value: UserStatisticsPayload = {
    period: {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      days,
    },
    overview: {
      totalPosts: totals.totalPosts,
      totalViews: totals.totalViews,
      totalInteractions,
      engagementRate: rounded(
        totals.totalViews > 0 ? (totalInteractions / totals.totalViews) * 100 : 0,
      ),
      averageEngagementPerPost: rounded(
        totals.totalPosts > 0 ? totalInteractions / totals.totalPosts : 0,
      ),
    },
    interactions: {
      likes: totals.totalLikes,
      replies: totals.totalReplies,
      boosts: totals.totalBoosts,
      shares: totals.totalShares,
    },
    dailyBreakdown: facets?.dailyBreakdown ?? [],
    topPosts: facets?.topPosts ?? [],
    postsByType: Object.fromEntries(
      (facets?.postsByType ?? []).map(({ type, count }) => [type, count]),
    ),
  };
  cacheStatistics(cacheKey, value);
  return value;
}

/**
 * Get user statistics (overall analytics)
 * Shows post views, interactions, follower changes, and engagement ratios
 */
export const getUserStatistics = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const days = requestedStatsDays(req.query.days);
    res.json(await queryUserStatistics(userId, days));
  } catch (error) {
    logger.error('Error fetching user statistics:', error);
    res.status(500).json({
      message: 'Error fetching user statistics',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Get a user's posting activity bucketed per UTC day (GitHub-style heatmap).
 *
 * PUBLIC profile data — keyed by the `:userId` path param, the same way public
 * profile stats (follower counts, profile-design counts) are exposed. Optional
 * auth: `req.user` is populated when a session is present but never required.
 * The target user's profile visibility is respected exactly like the public
 * profile-design counts: a private / followers-only profile returns an empty
 * activity set unless the viewer is the owner or an approved follower.
 */
export const getUserActivity = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.params.userId as string;
    const validationError = validateRequired(userId, 'userId');
    if (validationError) {
      return res.status(400).json({ message: validationError });
    }

    // Clamp the requested window to a sane range. Default 365 (a full year of the
    // heatmap); min 30, max 366.
    const rawDays = queryInt(req.query.days);
    const days = rawDays === undefined ? 365 : Math.min(366, Math.max(30, rawDays));

    // Respect the target user's profile visibility — mirrors the public
    // profile-design stats. For a private / followers-only profile the viewer
    // must be the owner or an approved follower; otherwise the activity is empty.
    const currentUserId = req.user?.id;
    if (currentUserId !== userId) {
      const settings = await UserSettings.findOne({ oxyUserId: userId }).lean();
      const profileVisibility = settings?.privacy?.profileVisibility || ProfileVisibility.PUBLIC;
      if (requiresAccessCheck(profileVisibility)) {
        if (!currentUserId) {
          return res.json({ activity: [] });
        }
        const hasAccess = await checkFollowAccess(currentUserId, userId);
        if (!hasAccess) {
          return res.json({ activity: [] });
        }
      }
    }

    // Window boundary in UTC — end of today minus `days`. The request timezone is
    // never read; both the boundary and the per-day buckets are computed in UTC.
    const now = new Date();
    const endOfToday = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999
    ));
    const startDate = new Date(endOfToday.getTime() - days * 24 * 60 * 60 * 1000);

    // Count authored posts per UTC day: original posts + replies + quotes, but
    // NOT boosts/reposts (a repost is a `type: 'boost'` post that carries no
    // authored content). Scoped to the user's public, published posts so it stays
    // consistent with the public profile-design counts and never leaks
    // followers-only/private content. Only days with count > 0 are returned; the
    // client fills the gaps.
    const activity = await Post.aggregate<{ date: string; count: number }>([
      {
        $match: {
          oxyUserId: userId,
          visibility: PostVisibility.PUBLIC,
          status: 'published',
          type: { $ne: PostType.BOOST },
          createdAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
          count: { $sum: 1 },
        },
      },
      { $project: { _id: 0, date: '$_id', count: 1 } },
      { $sort: { date: 1 } },
    ]).option({ maxTimeMS: STATISTICS_QUERY_MAX_TIME_MS });

    res.json({ activity });
  } catch (error) {
    logger.error('Error fetching user activity:', error);
    res.status(500).json({
      message: 'Error fetching user activity',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Get post-specific insights
 * Shows views, likes, replies, reach, and engagement for a specific post
 */
export const getPostInsights = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { postId } = req.params;

    const post = await Post.findById(postId)
      .select('_id oxyUserId createdAt stats')
      .maxTimeMS(STATISTICS_QUERY_MAX_TIME_MS)
      .lean();
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Check if user owns the post
    if (String(post.oxyUserId) !== userId) {
      return res.status(403).json({ message: 'You can only view insights for your own posts' });
    }

    const stats = post.stats || {
      likesCount: 0,
      boostsCount: 0,
      commentsCount: 0,
      viewsCount: 0,
      sharesCount: 0,
      savesCount: 0,
    };

    // Calculate engagement metrics
    const totalInteractions = stats.likesCount + stats.commentsCount + stats.boostsCount + stats.sharesCount;
    const engagementRate = stats.viewsCount > 0 
      ? (totalInteractions / stats.viewsCount) * 100 
      : 0;

    const [replyCount, boostCount, quoteCount] = await Promise.all([
      Post.countDocuments({ parentPostId: postId }),
      Post.countDocuments({ boostOf: postId }),
      Post.countDocuments({ quoteOf: postId }),
    ]);

    res.json({
      postId: post._id.toString(),
      createdAt: post.createdAt,
      stats: {
        views: stats.viewsCount,
        likes: stats.likesCount,
        replies: replyCount,
        boosts: boostCount,
        quotes: quoteCount,
        shares: stats.sharesCount
      },
      engagement: {
        totalInteractions,
        engagementRate: parseFloat(engagementRate.toFixed(2)),
        // Reach is the measured view counter. Mention does not currently retain
        // a durable lifetime unique-viewer set, so that metric is explicit null
        // rather than a fabricated estimate.
        reach: stats.viewsCount,
        uniqueViewers: null,
      },
      breakdown: {
        likedBy: stats.likesCount,
        hasReplies: replyCount > 0,
        hasBoosts: boostCount > 0,
        hasQuotes: quoteCount > 0
      }
    });
  } catch (error) {
    logger.error('Error fetching post insights:', error);
    res.status(500).json({
      message: 'Error fetching post insights',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Track post view
 * Increments view count when a user views a post
 */
export const trackPostView = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const postId = req.params.postId as string;

    if (!postId) {
      return res.status(400).json({ message: 'Post ID is required' });
    }

    // Deduplicate the view per (viewer, post) through the SAME canonical
    // feed-impression guard used by ranking (`recordDedupedView` → Redis
    // `SET NX EX viewseen:<post>:<viewer>`): only the FIRST view within the
    // window performs the `$inc` on `stats.viewsCount`; a duplicate view or an
    // ineligible/absent post is a no-op. This closes the previous
    // undeduplicated `$inc`-on-any-postId inflation path. An anonymous request
    // (no viewer id) cannot be deduped, so — matching `feedViewCounter`, which
    // requires a viewer id — it is never counted.
    if (userId) {
      await recordDedupedView(postId, userId);
    }

    // Read back the current count for the response; this also serves as the
    // existence check, so a missing post still returns 404.
    const post = await Post.findById(postId, { 'stats.viewsCount': 1 }).lean();
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Best-effort preference learning — detached so it never adds latency to the
    // view response.
    if (userId) {
      void userPreferenceService
        .recordInteraction(userId, postId, 'view')
        .catch((error) => logger.warn('Failed to record view interaction:', error));
    }

    res.json({ success: true, viewsCount: post.stats?.viewsCount ?? 0 });
  } catch (error) {
    logger.error('Error tracking post view:', error);
    res.status(500).json({
      message: 'Error tracking post view',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Get follower changes over time
 * Shows follower growth/loss trends
 */
export const getFollowerChanges = async (req: AuthRequest, res: Response) => {
  if (!req.user?.id) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  return res.status(501).json({
    message: 'Follower history is unavailable until authoritative Oxy snapshots are enabled',
    available: false,
  });
};

/**
 * Get engagement ratios and performance metrics
 */
export const getEngagementRatios = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const days = requestedStatsDays(req.query.days);
    const statistics = await queryUserStatistics(userId, days);
    const totalViews = statistics.overview.totalViews;
    const totalInteractions = statistics.overview.totalInteractions;
    const totalLikes = statistics.interactions.likes;
    const totalReplies = statistics.interactions.replies;
    const totalBoosts = statistics.interactions.boosts;
    const totalShares = statistics.interactions.shares;
    const totalPosts = statistics.overview.totalPosts;

    // Calculate various engagement ratios
    const engagementRate = totalViews > 0 ? (totalInteractions / totalViews) * 100 : 0;
    const likeRate = totalViews > 0 ? (totalLikes / totalViews) * 100 : 0;
    const replyRate = totalViews > 0 ? (totalReplies / totalViews) * 100 : 0;
    const boostRate = totalViews > 0 ? (totalBoosts / totalViews) * 100 : 0;
    const shareRate = totalViews > 0 ? (totalShares / totalViews) * 100 : 0;

    // Calculate average per post
    const avgViewsPerPost = totalPosts > 0 ? totalViews / totalPosts : 0;
    const avgEngagementPerPost = totalPosts > 0 ? totalInteractions / totalPosts : 0;

    res.json({
      period: {
        ...statistics.period,
      },
      ratios: {
        engagementRate: parseFloat(engagementRate.toFixed(2)),
        likeRate: parseFloat(likeRate.toFixed(2)),
        replyRate: parseFloat(replyRate.toFixed(2)),
        boostRate: parseFloat(boostRate.toFixed(2)),
        shareRate: parseFloat(shareRate.toFixed(2))
      },
      averages: {
        viewsPerPost: parseFloat(avgViewsPerPost.toFixed(2)),
        engagementPerPost: parseFloat(avgEngagementPerPost.toFixed(2))
      },
      totals: {
        posts: totalPosts,
        views: totalViews,
        interactions: totalInteractions,
        likes: totalLikes,
        replies: totalReplies,
        boosts: totalBoosts,
        shares: totalShares
      }
    });
  } catch (error) {
    logger.error('Error fetching engagement ratios:', error);
    res.status(500).json({
      message: 'Error fetching engagement ratios',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Get AI-generated weekly summary
 * Computes current vs previous week stats and generates a personalized insight via Alia
 */
export const getWeeklySummary = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!isAliaEnabled()) {
      return res.json({ summary: null });
    }

    // Write the summary in the viewer's PRIMARY account language. Oxy stores
    // account languages as BCP-47 locales (`es-ES`), primary first; the prompt
    // wants the base ISO 639-1 code (`es`). English is the fallback when the
    // account declares no language or the profile fetch fails.
    let language = DEFAULT_SUMMARY_LANGUAGE;
    try {
      const oxyUser = await getRuntimeOxyClient().getUserById(userId);
      const primaryLocale = getPrimaryLanguage(oxyUser);
      const baseLanguage = primaryLocale ? getBaseLanguage(primaryLocale) : '';
      if (baseLanguage) {
        language = baseLanguage;
      }
    } catch (error) {
      logger.warn('[statistics] Failed to resolve viewer language for the weekly summary; using English', {
        userId,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }

    const { startDate } = getDateRange(14);
    const now = new Date();

    const posts = await Post.find({
      authorship: { $elemMatch: { oxyUserId: userId, role: 'owner' } },
      createdAt: { $gte: startDate, $lte: now },
    } as Record<string, unknown>)
      .select('createdAt type stats content.variants content.text')
      .maxTimeMS(STATISTICS_QUERY_MAX_TIME_MS)
      .lean();

    // Split into current week (last 7 days) and previous week (days 8-14)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const currentWeekPosts = posts.filter(p => new Date(p.createdAt) >= sevenDaysAgo);
    const previousWeekPosts = posts.filter(p => new Date(p.createdAt) < sevenDaysAgo);

    const computeStats = (postList: typeof posts) => {
      const totalPosts = postList.length;
      const totalViews = postList.reduce((sum, p) => sum + (p.stats?.viewsCount || 0), 0);
      const likes = postList.reduce((sum, p) => sum + (p.stats?.likesCount || 0), 0);
      const replies = postList.reduce((sum, p) => sum + (p.stats?.commentsCount || 0), 0);
      const boosts = postList.reduce((sum, p) => sum + (p.stats?.boostsCount || 0), 0);
      const totalInteractions = likes + replies + boosts;
      const engagementRate = totalViews > 0 ? (totalInteractions / totalViews) * 100 : 0;
      return { totalPosts, totalViews, totalInteractions, engagementRate, likes, replies, boosts };
    };

    const current = computeStats(currentWeekPosts);
    const previous = computeStats(previousWeekPosts);

    const delta = (cur: number, prev: number): string => {
      if (prev === 0) return cur > 0 ? '+100' : '0';
      return ((cur - prev) / prev * 100).toFixed(0);
    };

    // Skip AI call if the user had no activity in either week — nothing meaningful to summarize
    if (current.totalPosts === 0 && previous.totalPosts === 0) {
      return res.json({ summary: null });
    }

    // Determine which post type performed best this week
    const postTypeMap: Record<string, number> = {};
    for (const p of currentWeekPosts) {
      const type = p.type || 'text';
      postTypeMap[type] = (postTypeMap[type] || 0) + 1;
    }
    const topPostType = Object.entries(postTypeMap)
      .sort((a, b) => b[1] - a[1])[0];

    // Find the user's strongest interaction type this week
    const interactionRanking = [
      { type: 'likes', count: current.likes },
      { type: 'replies', count: current.replies },
      { type: 'boosts', count: current.boosts },
    ].sort((a, b) => b.count - a.count);
    const strongestInteraction = interactionRanking[0];
    const weakestInteraction = interactionRanking[interactionRanking.length - 1];

    // Format the week's date range for context
    const weekStart = new Date(sevenDaysAgo);
    const weekEnd = new Date();
    const formatDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const dateRange = `${formatDate(weekStart)} - ${formatDate(weekEnd)}`;

    const lines = [
      `Period: ${dateRange}.`,
      `This week: ${current.totalPosts} posts, ${current.totalViews} views, ${current.totalInteractions} interactions (${current.likes} likes, ${current.replies} replies, ${current.boosts} boosts), ${current.engagementRate.toFixed(1)}% engagement.`,
      `Previous week: ${previous.totalPosts} posts, ${previous.totalViews} views, ${previous.totalInteractions} interactions (${previous.likes} likes, ${previous.replies} replies, ${previous.boosts} boosts), ${previous.engagementRate.toFixed(1)}% engagement.`,
      `Week-over-week: views ${delta(current.totalViews, previous.totalViews)}%, interactions ${delta(current.totalInteractions, previous.totalInteractions)}%, posts ${delta(current.totalPosts, previous.totalPosts)}%.`,
    ];
    if (topPostType) {
      lines.push(`Most used post type this week: ${topPostType[0]} (${topPostType[1]} posts).`);
    }
    if (strongestInteraction.count > 0) {
      lines.push(`Strongest interaction: ${strongestInteraction.type} (${strongestInteraction.count}). Weakest: ${weakestInteraction.type} (${weakestInteraction.count}).`);
    }

    // Find the best-performing post this week by total engagement
    const bestPost = currentWeekPosts
      .map(p => ({
        engagement: (p.stats?.likesCount || 0) + (p.stats?.commentsCount || 0) + (p.stats?.boostsCount || 0),
        views: p.stats?.viewsCount || 0,
        type: p.type || 'text',
        // The primary rendition — an analytics snippet shows the author's own words.
        contentSnippet: resolveVariant(p.content).text.slice(0, 80),
      }))
      .sort((a, b) => b.engagement - a.engagement)[0];

    if (bestPost && bestPost.engagement > 0) {
      lines.push(`Best post this week: ${bestPost.type} post with ${bestPost.views} views and ${bestPost.engagement} interactions${bestPost.contentSnippet ? ` — "${bestPost.contentSnippet}${bestPost.contentSnippet.length >= 80 ? '...' : ''}"` : ''}.`);
    }

    // Find the most active day this week
    const dayActivity = new Map<string, number>();
    for (const p of currentWeekPosts) {
      const day = new Date(p.createdAt).toLocaleDateString('en-US', { weekday: 'long' });
      dayActivity.set(day, (dayActivity.get(day) || 0) + 1);
    }
    const mostActiveDay = [...dayActivity.entries()].sort((a, b) => b[1] - a[1])[0];
    if (mostActiveDay) {
      lines.push(`Most active day: ${mostActiveDay[0]} (${mostActiveDay[1]} posts).`);
    }

    const userMessage = lines.join('\n');

    try {
      const summary = await aliaChat(
        [
          {
            role: 'system',
            content: [
              'You write weekly performance summaries for Mention, a social media platform.',
              'You are speaking directly to the user about their personal stats for the given date range vs the previous week.',
              'Write exactly 2-3 sentences.',
              'First sentence: a concrete observation about their week — reference actual numbers and what changed.',
              'Second sentence: one specific, actionable growth tip based on what the data shows.',
              'Your growth tips should be based on how social media algorithms work:',
              '- Posts that get early replies and boosts get boosted by the algorithm, so encourage conversation-starting content.',
              '- Posting consistently (even 1 post/day) signals activity and improves reach over time.',
              '- Engagement rate matters more than raw views — a smaller audience that interacts is better than passive viewers.',
              '- If replies are low, suggest ending posts with questions or hot takes to spark discussion.',
              '- If boosts are low, suggest sharing insights, tips, or relatable content that people want to share.',
              '- If views are high but interactions are low, the content reaches people but does not resonate — suggest trying different formats or more personal/opinionated posts.',
              '- Mixing post types (text, images, polls) keeps the audience engaged.',
              'Pick the ONE most relevant tip for this user based on their specific data. Do not list multiple tips.',
              'Optional third sentence only for notable milestones or patterns.',
              'Tone: conversational and direct — like a smart friend reviewing your stats. No corporate speak, no motivational quotes, no exclamation marks, no emojis, no bullet points, no markdown.',
              'Address the user as "you" / "your". Never say "the user".',
              'If this week had zero posts, gently encourage posting again without guilt.',
              `Write the entire summary in the language with code "${language}". If you don't recognize the code, use English.`,
              'Return ONLY the summary text.',
            ].join(' '),
          },
          { role: 'user', content: userMessage },
        ],
        { model: 'alia-lite', temperature: 0.7, maxTokens: 200 },
      );

      return res.json({ summary });
    } catch (aiError) {
      logger.warn('Alia AI summary generation failed:', aiError);
      return res.json({ summary: null });
    }
  } catch (error) {
    logger.error('Error generating weekly summary:', error);
    res.status(500).json({
      message: 'Error generating weekly summary',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};
