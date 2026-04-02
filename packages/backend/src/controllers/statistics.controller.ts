import { Response } from "express";
import { AuthRequest } from "../types/auth";
import Post from "../models/Post";
import { logger } from '../utils/logger';
import { aliaChat, isAliaEnabled } from '../utils/alia';
import { oxy as oxyClient } from '../../server';
import { userPreferenceService } from '../services/UserPreferenceService';

interface DateRange {
  startDate: Date;
  endDate: Date;
}

function getDateRange(days: number = 30): DateRange {
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

    const { days = 30 } = req.query;
    const daysNum = parseInt(days as string, 10) || 30;
    const { startDate, endDate } = getDateRange(daysNum);

    // Get all posts by user in date range
    const posts = await Post.find({
      oxyUserId: userId,
      createdAt: { $gte: startDate, $lte: endDate }
    } as any).lean();

    // Aggregate stats
    const totalPosts = posts.length;
    const totalViews = posts.reduce((sum, post) => sum + (post.stats?.viewsCount || 0), 0);
    const totalLikes = posts.reduce((sum, post) => sum + (post.stats?.likesCount || 0), 0);
    const totalReplies = posts.reduce((sum, post) => sum + (post.stats?.commentsCount || 0), 0);
    const totalReposts = posts.reduce((sum, post) => sum + (post.stats?.repostsCount || 0), 0);
    const totalShares = posts.reduce((sum, post) => sum + (post.stats?.sharesCount || 0), 0);

    // Calculate engagement
    const totalInteractions = totalLikes + totalReplies + totalReposts + totalShares;
    const engagementRate = totalViews > 0 ? (totalInteractions / totalViews) * 100 : 0;
    const averageEngagementPerPost = totalPosts > 0 ? totalInteractions / totalPosts : 0;

    // Get daily breakdown for charts
    const dailyStats = new Map<string, {
      date: string;
      views: number;
      likes: number;
      replies: number;
      reposts: number;
      interactions: number;
    }>();

    posts.forEach(post => {
      const date = new Date(post.createdAt).toISOString().split('T')[0];
      const existing = dailyStats.get(date) || {
        date,
        views: 0,
        likes: 0,
        replies: 0,
        reposts: 0,
        interactions: 0
      };

      existing.views += post.stats?.viewsCount || 0;
      existing.likes += post.stats?.likesCount || 0;
      existing.replies += post.stats?.commentsCount || 0;
      existing.reposts += post.stats?.repostsCount || 0;
      existing.interactions += (post.stats?.likesCount || 0) + 
                                (post.stats?.commentsCount || 0) + 
                                (post.stats?.repostsCount || 0);

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
        reposts: post.stats?.repostsCount || 0,
        engagement: (post.stats?.likesCount || 0) + 
                   (post.stats?.commentsCount || 0) + 
                   (post.stats?.repostsCount || 0),
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
        reposts: totalReposts,
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
      repostsCount: 0,
      commentsCount: 0,
      viewsCount: 0,
      sharesCount: 0
    };

    // Calculate engagement metrics
    const totalInteractions = stats.likesCount + stats.commentsCount + stats.repostsCount + stats.sharesCount;
    const engagementRate = stats.viewsCount > 0 
      ? (totalInteractions / stats.viewsCount) * 100 
      : 0;

    // Get unique viewers (approximate - users who liked/commented/reposted)
    const likedBy = Array.isArray(post.metadata?.likedBy) ? post.metadata.likedBy : [];
    const uniqueViewers = stats.viewsCount; // We don't track unique viewers separately yet

    // Get replies
    const replies = await Post.find({ parentPostId: postId }).lean();
    const replyCount = replies.length;

    // Get reposts
    const reposts = await Post.find({ repostOf: postId }).lean();
    const repostCount = reposts.length;

    // Get quote posts (posts that quote this one)
    const quotes = await Post.find({ quoteOf: postId }).lean();
    const quoteCount = quotes.length;

    // Calculate reach (approximate - views + reposts reach)
    const reach = stats.viewsCount + (repostCount * 10); // Estimate repost reach

    res.json({
      postId: post._id.toString(),
      createdAt: post.createdAt,
      stats: {
        views: stats.viewsCount,
        likes: stats.likesCount,
        replies: replyCount,
        reposts: repostCount,
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
        hasReposts: repostCount > 0,
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

    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Increment view count (we could add deduplication later)
    await Post.findByIdAndUpdate(postId, {
      $inc: { 'stats.viewsCount': 1 }
    });

    // Record interaction for user preference learning
    if (userId) {
      try {
        await userPreferenceService.recordInteraction(userId, postId, 'view');
      } catch (error) {
        logger.warn('Failed to record view interaction:', error);
      }
    }

    res.json({ success: true, viewsCount: (post.stats?.viewsCount || 0) + 1 });
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

    const { days = 30 } = req.query;
    const daysNum = parseInt(days as string, 10) || 30;
    const { startDate, endDate } = getDateRange(daysNum);

    // Note: Follower tracking would need to be implemented separately
    // For now, we'll return a placeholder structure
    // This would require tracking follower changes in a separate collection
    
    // Get posts to estimate engagement-related follower growth
    const posts = await Post.find({
      oxyUserId: userId,
      createdAt: { $gte: startDate, $lte: endDate }
    } as any).lean();

    // Estimate follower engagement based on interactions
    const totalInteractions = posts.reduce((sum, post) => {
      return sum + (post.stats?.likesCount || 0) + 
                   (post.stats?.commentsCount || 0) + 
                   (post.stats?.repostsCount || 0);
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

    const { days = 30 } = req.query;
    const daysNum = parseInt(days as string, 10) || 30;
    const { startDate, endDate } = getDateRange(daysNum);

    const posts = await Post.find({
      oxyUserId: userId,
      createdAt: { $gte: startDate, $lte: endDate }
    } as any).lean();

    let totalViews = 0;
    let totalLikes = 0;
    let totalReplies = 0;
    let totalReposts = 0;
    let totalShares = 0;

    posts.forEach(post => {
      totalViews += post.stats?.viewsCount || 0;
      totalLikes += post.stats?.likesCount || 0;
      totalReplies += post.stats?.commentsCount || 0;
      totalReposts += post.stats?.repostsCount || 0;
      totalShares += post.stats?.sharesCount || 0;
    });

    const totalInteractions = totalLikes + totalReplies + totalReposts + totalShares;

    // Calculate various engagement ratios
    const engagementRate = totalViews > 0 ? (totalInteractions / totalViews) * 100 : 0;
    const likeRate = totalViews > 0 ? (totalLikes / totalViews) * 100 : 0;
    const replyRate = totalViews > 0 ? (totalReplies / totalViews) * 100 : 0;
    const repostRate = totalViews > 0 ? (totalReposts / totalViews) * 100 : 0;
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
        repostRate: parseFloat(repostRate.toFixed(2)),
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
        reposts: totalReposts,
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

    // Get language from Oxy user profile
    let language = 'en';
    try {
      const oxyUser = await oxyClient.getUserById(userId);
      const userLang = (oxyUser as Record<string, unknown>)?.language;
      if (typeof userLang === 'string' && userLang) {
        language = userLang.split('-')[0]; // e.g. 'en-US' → 'en'
      }
    } catch {
      // Fall back to English if profile fetch fails
    }

    const { startDate } = getDateRange(14);
    const now = new Date();

    const posts = await Post.find({
      oxyUserId: userId,
      createdAt: { $gte: startDate, $lte: now },
    } as any).lean();

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
      const reposts = postList.reduce((sum, p) => sum + (p.stats?.repostsCount || 0), 0);
      const totalInteractions = likes + replies + reposts;
      const engagementRate = totalViews > 0 ? (totalInteractions / totalViews) * 100 : 0;
      return { totalPosts, totalViews, totalInteractions, engagementRate, likes, replies, reposts };
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
      { type: 'reposts', count: current.reposts },
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
      `This week: ${current.totalPosts} posts, ${current.totalViews} views, ${current.totalInteractions} interactions (${current.likes} likes, ${current.replies} replies, ${current.reposts} reposts), ${current.engagementRate.toFixed(1)}% engagement.`,
      `Previous week: ${previous.totalPosts} posts, ${previous.totalViews} views, ${previous.totalInteractions} interactions (${previous.likes} likes, ${previous.replies} replies, ${previous.reposts} reposts), ${previous.engagementRate.toFixed(1)}% engagement.`,
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
        engagement: (p.stats?.likesCount || 0) + (p.stats?.commentsCount || 0) + (p.stats?.repostsCount || 0),
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
              '- Posts that get early replies and reposts get boosted by the algorithm, so encourage conversation-starting content.',
              '- Posting consistently (even 1 post/day) signals activity and improves reach over time.',
              '- Engagement rate matters more than raw views — a smaller audience that interacts is better than passive viewers.',
              '- If replies are low, suggest ending posts with questions or hot takes to spark discussion.',
              '- If reposts are low, suggest sharing insights, tips, or relatable content that people want to share.',
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

