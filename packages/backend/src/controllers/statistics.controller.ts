import { Response } from "express";
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getBaseLanguage, getPrimaryLanguage } from '@oxyhq/core';
import { PostType, PostVisibility } from '@mention/shared-types';
import Post from "../models/Post";
import UserSettings from "../models/UserSettings";
import { logger } from '../utils/logger';
import { aliaChat, isAliaEnabled } from '../utils/alia';
import { oxy as oxyClient } from '../../server';
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

    const daysNum = queryInt(req.query.days) || DEFAULT_STATS_WINDOW_DAYS;
    const { startDate, endDate } = getDateRange(daysNum);

    // Get all posts by user in date range
    const posts = await Post.find({
      oxyUserId: userId,
      createdAt: { $gte: startDate, $lte: endDate }
    } as Record<string, unknown>).lean();

    // Aggregate stats
    const totalPosts = posts.length;
    const totalViews = posts.reduce((sum, post) => sum + (post.stats?.viewsCount || 0), 0);
    const totalLikes = posts.reduce((sum, post) => sum + (post.stats?.likesCount || 0), 0);
    const totalReplies = posts.reduce((sum, post) => sum + (post.stats?.commentsCount || 0), 0);
    const totalBoosts = posts.reduce((sum, post) => sum + (post.stats?.boostsCount || 0), 0);
    const totalShares = posts.reduce((sum, post) => sum + (post.stats?.sharesCount || 0), 0);

    // Calculate engagement
    const totalInteractions = totalLikes + totalReplies + totalBoosts + totalShares;
    const engagementRate = totalViews > 0 ? (totalInteractions / totalViews) * 100 : 0;
    const averageEngagementPerPost = totalPosts > 0 ? totalInteractions / totalPosts : 0;

    // Get daily breakdown for charts
    const dailyStats = new Map<string, {
      date: string;
      views: number;
      likes: number;
      replies: number;
      boosts: number;
      interactions: number;
    }>();

    posts.forEach(post => {
      const date = new Date(post.createdAt).toISOString().split('T')[0];
      const existing = dailyStats.get(date) || {
        date,
        views: 0,
        likes: 0,
        replies: 0,
        boosts: 0,
        interactions: 0
      };

      existing.views += post.stats?.viewsCount || 0;
      existing.likes += post.stats?.likesCount || 0;
      existing.replies += post.stats?.commentsCount || 0;
      existing.boosts += post.stats?.boostsCount || 0;
      existing.interactions += (post.stats?.likesCount || 0) +
                                (post.stats?.commentsCount || 0) +
                                (post.stats?.boostsCount || 0);

      dailyStats.set(date, existing);
    });

    const dailyBreakdown = Array.from(dailyStats.values()).sort((a, b) => 
      a.date.localeCompare(b.date)
    );

    // Get top performing posts
    const topPosts = posts
      .map(post => ({
        postId: post._id.toString(),
        views: post.stats?.viewsCount || 0,
        likes: post.stats?.likesCount || 0,
        replies: post.stats?.commentsCount || 0,
        boosts: post.stats?.boostsCount || 0,
        engagement: (post.stats?.likesCount || 0) +
                   (post.stats?.commentsCount || 0) +
                   (post.stats?.boostsCount || 0),
        createdAt: post.createdAt
      }))
      .sort((a, b) => b.engagement - a.engagement)
      .slice(0, 10);

    // Get posts by type breakdown
    const postsByType = posts.reduce((acc, post) => {
      const type = post.type || 'text';
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    res.json({
      period: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        days: daysNum
      },
      overview: {
        totalPosts,
        totalViews,
        totalInteractions,
        engagementRate: parseFloat(engagementRate.toFixed(2)),
        averageEngagementPerPost: parseFloat(averageEngagementPerPost.toFixed(2))
      },
      interactions: {
        likes: totalLikes,
        replies: totalReplies,
        boosts: totalBoosts,
        shares: totalShares
      },
      dailyBreakdown,
      topPosts,
      postsByType
    });
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
    ]);

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

    const post = await Post.findById(postId).lean();
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Check if user owns the post
    if (post.oxyUserId !== userId) {
      return res.status(403).json({ message: 'You can only view insights for your own posts' });
    }

    const stats = post.stats || {
      likesCount: 0,
      boostsCount: 0,
      commentsCount: 0,
      viewsCount: 0,
      sharesCount: 0
    };

    // Calculate engagement metrics
    const totalInteractions = stats.likesCount + stats.commentsCount + stats.boostsCount + stats.sharesCount;
    const engagementRate = stats.viewsCount > 0 
      ? (totalInteractions / stats.viewsCount) * 100 
      : 0;

    // Get unique viewers (approximate - users who liked/commented/boosted)
    const likedBy = Array.isArray(post.metadata?.likedBy) ? post.metadata.likedBy : [];
    const uniqueViewers = stats.viewsCount; // We don't track unique viewers separately yet

    // Get replies
    const replies = await Post.find({ parentPostId: postId }).lean();
    const replyCount = replies.length;

    // Get boosts
    const boosts = await Post.find({ boostOf: postId }).lean();
    const boostCount = boosts.length;

    // Get quote posts (posts that quote this one)
    const quotes = await Post.find({ quoteOf: postId }).lean();
    const quoteCount = quotes.length;

    // Calculate reach (approximate - views + boosts reach)
    const reach = stats.viewsCount + (boostCount * 10); // Estimate boost reach

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
        reach,
        uniqueViewers
      },
      breakdown: {
        likedBy: likedBy.length,
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
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const daysNum = queryInt(req.query.days) || DEFAULT_STATS_WINDOW_DAYS;
    const { startDate, endDate } = getDateRange(daysNum);

    // Note: Follower tracking would need to be implemented separately
    // For now, we'll return a placeholder structure
    // This would require tracking follower changes in a separate collection
    
    // Get posts to estimate engagement-related follower growth
    const posts = await Post.find({
      oxyUserId: userId,
      createdAt: { $gte: startDate, $lte: endDate }
    } as Record<string, unknown>).lean();

    // Estimate follower engagement based on interactions
    const totalInteractions = posts.reduce((sum, post) => {
      return sum + (post.stats?.likesCount || 0) +
                   (post.stats?.commentsCount || 0) +
                   (post.stats?.boostsCount || 0);
    }, 0);

    res.json({
      period: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        days: daysNum
      },
      currentFollowers: 0, // Would need to fetch from Oxy services
      followerChanges: [], // Would need historical tracking
      estimatedGrowth: {
        interactions: totalInteractions,
        note: 'Follower tracking requires integration with Oxy services'
      }
    });
  } catch (error) {
    logger.error('Error fetching follower changes:', error);
    res.status(500).json({
      message: 'Error fetching follower changes',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
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

    const daysNum = queryInt(req.query.days) || DEFAULT_STATS_WINDOW_DAYS;
    const { startDate, endDate } = getDateRange(daysNum);

    const posts = await Post.find({
      oxyUserId: userId,
      createdAt: { $gte: startDate, $lte: endDate }
    } as Record<string, unknown>).lean();

    let totalViews = 0;
    let totalLikes = 0;
    let totalReplies = 0;
    let totalBoosts = 0;
    let totalShares = 0;

    posts.forEach(post => {
      totalViews += post.stats?.viewsCount || 0;
      totalLikes += post.stats?.likesCount || 0;
      totalReplies += post.stats?.commentsCount || 0;
      totalBoosts += post.stats?.boostsCount || 0;
      totalShares += post.stats?.sharesCount || 0;
    });

    const totalInteractions = totalLikes + totalReplies + totalBoosts + totalShares;

    // Calculate various engagement ratios
    const engagementRate = totalViews > 0 ? (totalInteractions / totalViews) * 100 : 0;
    const likeRate = totalViews > 0 ? (totalLikes / totalViews) * 100 : 0;
    const replyRate = totalViews > 0 ? (totalReplies / totalViews) * 100 : 0;
    const boostRate = totalViews > 0 ? (totalBoosts / totalViews) * 100 : 0;
    const shareRate = totalViews > 0 ? (totalShares / totalViews) * 100 : 0;

    // Calculate average per post
    const avgViewsPerPost = posts.length > 0 ? totalViews / posts.length : 0;
    const avgEngagementPerPost = posts.length > 0 ? totalInteractions / posts.length : 0;

    res.json({
      period: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        days: daysNum
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
        posts: posts.length,
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
      const oxyUser = await oxyClient.getUserById(userId);
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
      oxyUserId: userId,
      createdAt: { $gte: startDate, $lte: now },
    } as Record<string, unknown>).lean();

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
        contentSnippet: (p.content?.text || '').slice(0, 80),
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

