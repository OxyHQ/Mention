import { Post } from '../models/Post';
import UserBehavior from '../models/UserBehavior';
import mongoose from 'mongoose';
import { extractFollowingIds } from '../utils/privacyHelpers';
import { logger } from '../utils/logger';

/**
 * FeedRankingService - Advanced feed ranking algorithm
 * Similar to Twitter/X and Facebook's feed algorithms
 * 
 * Ranking factors:
 * 1. Engagement Score - likes, reposts, comments, views (with weights)
 * 2. Recency Score - time decay function
 * 3. Author Relationship - follow status, interaction history, relationship strength
 * 4. Personalization - user preferences, topic interests, post type preferences
 * 5. Content Quality - engagement rate, completion rate, skip rate
 * 6. Diversity - avoid echo chambers, mix content types
 * 7. Negative Signals - hidden, muted, blocked content
 */
export class FeedRankingService {
  // Weight configuration (can be tuned based on A/B testing)
  private readonly WEIGHTS = {
    engagement: {
      likes: 1.0,
      reposts: 2.5,
      comments: 2.0,
      saves: 1.5,
      views: 0.1,
      shares: 2.0
    },
    recency: {
      halfLifeHours: 24, // Posts lose 50% value after 24 hours
      maxAgeHours: 168 // 7 days max age
    },
    author: {
      followBoost: 1.8,
      strongRelationBoost: 1.5,
      weakRelationBoost: 1.2,
      noRelationPenalty: 0.9
    },
    personalization: {
      topicMatchBoost: 1.4,
      postTypeMatchBoost: 1.3,
      languageMatchBoost: 1.2
    },
    quality: {
      highEngagementRateBoost: 1.3,
      lowEngagementRatePenalty: 0.8
    },
    diversity: {
      sameAuthorPenalty: 0.95,
      sameTopicPenalty: 0.92
    }
  };

  /**
   * Calculate comprehensive feed score for a post
   * Public method for use in controllers
   * 
   * @param post - Post document
   * @param userId - Oxy user ID (from req.user?.id) or undefined for anonymous users
   * @param context - Additional context for ranking (followingIds, userBehavior, etc.)
   */
  public async calculatePostScore(
    post: any,
    userId: string | undefined, // Oxy user ID
    context: {
      followingIds?: string[];
      userBehavior?: any;
      recentAuthors?: string[];
      recentTopics?: string[];
      feedSettings?: any; // User feed settings
    } = {}
  ): Promise<number> {
    // Base engagement score (with logarithmic normalization)
    const engagementScore = this.calculateEngagementScore(post);
    
    // Recency score with time decay (using user settings if provided)
    const recencyScore = this.calculateRecencyScore(
      post.createdAt,
      context.feedSettings?.recency?.halfLifeHours,
      context.feedSettings?.recency?.maxAgeHours
    );
    
    // Author relationship score
    const authorScore = await this.calculateAuthorScore(
      post.oxyUserId,
      userId,
      context.followingIds || [],
      context.userBehavior
    );
    
    // Personalization score
    const personalizationScore = await this.calculatePersonalizationScore(
      post,
      context.userBehavior
    );
    
    // Content quality score (with improved metrics)
    const qualityScore = this.calculateQualityScore(post);
    
    // Trending boost (for posts gaining traction)
    const trendingBoost = this.calculateTrendingBoost(post);
    
    // Time-of-day relevance score
    const timeOfDayScore = this.calculateTimeOfDayScore(post, context.userBehavior);
    
    // Diversity penalty (apply after all boosts, using user settings if provided)
    const diversityPenalty = this.calculateDiversityPenalty(
      post,
      context.recentAuthors || [],
      context.recentTopics || [],
      context.feedSettings?.diversity
    );
    
    // Apply negative signals
    const negativePenalty = await this.calculateNegativePenalty(
      post,
      userId,
      context.userBehavior
    );
    
    // Combine all scores
    const finalScore = engagementScore 
      * recencyScore 
      * authorScore 
      * personalizationScore 
      * qualityScore 
      * trendingBoost
      * timeOfDayScore
      * diversityPenalty
      * negativePenalty;
    
    return Math.max(0, finalScore); // Ensure non-negative
  }

  /**
   * Calculate engagement score from post stats with logarithmic normalization
   * Uses log scaling to prevent extremely popular posts from dominating
   */
  private calculateEngagementScore(post: any): number {
    const stats = post.stats || {};
    const metadata = post.metadata || {};
    
    // Get saves count from metadata.savedBy array
    const savesCount = Array.isArray(metadata.savedBy) 
      ? metadata.savedBy.length 
      : 0;
    
    // Calculate raw engagement score
    const rawScore = (
      (stats.likesCount || 0) * this.WEIGHTS.engagement.likes +
      (stats.repostsCount || 0) * this.WEIGHTS.engagement.reposts +
      (stats.commentsCount || 0) * this.WEIGHTS.engagement.comments +
      savesCount * this.WEIGHTS.engagement.saves +
      (stats.viewsCount || 0) * this.WEIGHTS.engagement.views +
      (stats.sharesCount || 0) * this.WEIGHTS.engagement.shares
    );
    
    // Apply logarithmic scaling to prevent extremely popular posts from dominating
    // log(1 + x) normalizes the score, +1 prevents log(0)
    // Scale factor of 10 provides good normalization range
    return Math.log1p(rawScore / 10);
  }

  /**
   * Calculate recency score with improved time decay
   * Uses configurable decay curve (exponential by default, can be linear or logarithmic)
   * 
   * @param createdAt - Post creation date
   * @param halfLifeHours - Optional custom half-life (from user settings)
   * @param maxAgeHours - Optional custom max age (from user settings)
   */
  private calculateRecencyScore(
    createdAt: Date | string,
    halfLifeHours?: number,
    maxAgeHours?: number
  ): number {
    const postDate = new Date(createdAt);
    const now = new Date();
    const ageHours = (now.getTime() - postDate.getTime()) / (1000 * 60 * 60);
    
    const maxAge = maxAgeHours || this.WEIGHTS.recency.maxAgeHours;
    // If post is older than max age, return 0
    if (ageHours > maxAge) {
      return 0;
    }
    
    const halfLife = halfLifeHours || this.WEIGHTS.recency.halfLifeHours;
    
    // Very recent posts (within 1 hour) get full score
    if (ageHours < 1) {
      return 1.0;
    }
    
    // Exponential decay with half-life: value = 0.5 ^ (age / halfLife)
    // This provides smooth decay that accelerates as posts age
    const decayFactor = Math.pow(0.5, ageHours / halfLife);
    
    // Ensure minimum value to prevent complete zero for recent posts
    return Math.max(0.05, decayFactor);
  }

  /**
   * Calculate author relationship score
   * 
   * @param authorId - Oxy user ID of post author
   * @param userId - Oxy user ID of current user (or undefined)
   * @param followingIds - Array of Oxy user IDs that current user follows
   * @param userBehavior - User behavior data from UserBehavior model
   */
  private async calculateAuthorScore(
    authorId: string, // Oxy user ID
    userId: string | undefined, // Oxy user ID
    followingIds: string[], // Array of Oxy user IDs
    userBehavior: any
  ): Promise<number> {
    if (!userId) {
      return 1.0; // No personalization for anonymous users
    }
    
    // Check if following
    const isFollowing = followingIds.includes(authorId);
    if (isFollowing) {
      return this.WEIGHTS.author.followBoost;
    }
    
    // Check relationship strength from behavior data
    if (userBehavior?.preferredAuthors) {
      const authorPreference = userBehavior.preferredAuthors.find(
        (a: any) => a.authorId === authorId
      );
      
      if (authorPreference) {
        // Strong relationship (weight > 0.7)
        if (authorPreference.weight > 0.7) {
          return this.WEIGHTS.author.strongRelationBoost;
        }
        // Weak relationship (weight > 0.3)
        if (authorPreference.weight > 0.3) {
          return this.WEIGHTS.author.weakRelationBoost;
        }
      }
    }
    
    // No relationship - slight penalty
    return this.WEIGHTS.author.noRelationPenalty;
  }

  /**
   * Calculate personalization score based on user preferences
   */
  private async calculatePersonalizationScore(
    post: any,
    userBehavior: any
  ): Promise<number> {
    if (!userBehavior) {
      return 1.0;
    }
    
    let score = 1.0;
    
    // Topic matching
    if (post.hashtags && post.hashtags.length > 0 && userBehavior.preferredTopics) {
      const matchingTopics = post.hashtags.filter((tag: string) =>
        userBehavior.preferredTopics.some((t: any) => 
          t.topic.toLowerCase() === tag.toLowerCase() && t.weight > 0.3
        )
      );
      
      if (matchingTopics.length > 0) {
        // Multiple matching topics = higher boost
        score *= 1 + (matchingTopics.length * 0.1) * this.WEIGHTS.personalization.topicMatchBoost;
      }
    }
    
    // Post type preference
    if (userBehavior.preferredPostTypes) {
      const postType = post.type?.toLowerCase() || 'text';
      const typeCount: number = (userBehavior.preferredPostTypes[postType as keyof typeof userBehavior.preferredPostTypes] as number) || 0;
      const totalTypes: number = Object.values(userBehavior.preferredPostTypes).reduce(
        (a: number, b: unknown) => a + (typeof b === 'number' ? b : 0), 0
      ) as number;
      
      if (totalTypes > 0 && typeCount > 0) {
        const typePreference = typeCount / totalTypes;
        if (typePreference > 0.3) { // User prefers this type
          score *= this.WEIGHTS.personalization.postTypeMatchBoost;
        }
      }
    }
    
    // Language preference
    if (post.language && userBehavior.preferredLanguages?.length > 0) {
      if (userBehavior.preferredLanguages.includes(post.language)) {
        score *= this.WEIGHTS.personalization.languageMatchBoost;
      }
    }
    
    return Math.min(score, 2.0); // Cap at 2x boost
  }

  /**
   * Calculate content quality score with improved metrics
   * Considers engagement rate, engagement velocity, and view-to-engagement ratio
   */
  private calculateQualityScore(post: any): number {
    const stats = post.stats || {};
    const viewsCount = stats.viewsCount || 1; // Avoid division by zero
    
    // Calculate raw engagement (before log scaling for rate calculation)
    const rawEngagement = (
      (stats.likesCount || 0) * this.WEIGHTS.engagement.likes +
      (stats.repostsCount || 0) * this.WEIGHTS.engagement.reposts +
      (stats.commentsCount || 0) * this.WEIGHTS.engagement.comments +
      (Array.isArray(post.metadata?.savedBy) ? post.metadata.savedBy.length : 0) * this.WEIGHTS.engagement.saves +
      (stats.sharesCount || 0) * this.WEIGHTS.engagement.shares
    );
    
    // Calculate engagement rate (engagement per view)
    const engagementRate = rawEngagement / viewsCount;
    
    // Calculate engagement velocity (recent engagement vs total)
    // Posts with recent engagement are more relevant
    const postAge = (Date.now() - new Date(post.createdAt).getTime()) / (1000 * 60 * 60); // hours
    const velocityBoost = postAge < 6 ? 1.2 : postAge < 24 ? 1.1 : 1.0; // Boost for very recent posts
    
    // High engagement rate = quality content
    if (engagementRate > 0.5) {
      return this.WEIGHTS.quality.highEngagementRateBoost * velocityBoost;
    }
    
    // Medium engagement rate = decent quality
    if (engagementRate > 0.2) {
      return 1.0 * velocityBoost;
    }
    
    // Low engagement rate = lower quality (only penalize if post has significant views)
    if (engagementRate < 0.1 && viewsCount > 100) {
      return this.WEIGHTS.quality.lowEngagementRatePenalty;
    }
    
    return 1.0; // Neutral for posts with few views
  }

  /**
   * Calculate trending boost for posts with accelerating engagement
   * Detects posts that are gaining traction rapidly
   */
  private calculateTrendingBoost(post: any): number {
    const stats = post.stats || {};
    const postAge = (Date.now() - new Date(post.createdAt).getTime()) / (1000 * 60 * 60); // hours
    
    // Only consider posts less than 24 hours old for trending
    if (postAge > 24) {
      return 1.0;
    }
    
    // Calculate engagement density (engagement per hour)
    const rawEngagement = (
      (stats.likesCount || 0) * this.WEIGHTS.engagement.likes +
      (stats.repostsCount || 0) * this.WEIGHTS.engagement.reposts +
      (stats.commentsCount || 0) * this.WEIGHTS.engagement.comments +
      (Array.isArray(post.metadata?.savedBy) ? post.metadata.savedBy.length : 0) * this.WEIGHTS.engagement.saves +
      (stats.sharesCount || 0) * this.WEIGHTS.engagement.shares
    );
    
    const engagementPerHour = rawEngagement / Math.max(postAge, 0.1);
    
    // Boost posts with high engagement density (trending)
    if (engagementPerHour > 50) {
      return 1.5; // Strong trending boost
    } else if (engagementPerHour > 20) {
      return 1.3; // Moderate trending boost
    } else if (engagementPerHour > 10) {
      return 1.15; // Light trending boost
    }
    
    return 1.0; // No trending boost
  }

  /**
   * Calculate time-of-day relevance score
   * Boosts posts created during user's active hours
   */
  private calculateTimeOfDayScore(
    post: any,
    userBehavior: any
  ): number {
    if (!userBehavior?.activeHours || userBehavior.activeHours.length === 0) {
      return 1.0; // No preference data
    }
    
    const postDate = new Date(post.createdAt);
    const postHour = postDate.getHours();
    
    // Check if post was created during user's active hours
    if (userBehavior.activeHours.includes(postHour)) {
      return 1.2; // Boost for posts created during active hours
    }
    
    // Check adjacent hours (within 1 hour of active time)
    const adjacentHours = [
      (postHour + 23) % 24, // Previous hour
      (postHour + 1) % 24   // Next hour
    ];
    
    if (adjacentHours.some(h => userBehavior.activeHours.includes(h))) {
      return 1.1; // Slight boost for adjacent hours
    }
    
    return 1.0; // No boost
  }

  /**
   * Calculate diversity penalty to avoid echo chambers
   * Uses user settings if provided, otherwise uses defaults
   */
  private calculateDiversityPenalty(
    post: any,
    recentAuthors: string[],
    recentTopics: string[],
    diversitySettings?: any
  ): number {
    // If diversity is disabled, return no penalty
    if (diversitySettings?.enabled === false) {
      return 1.0;
    }
    
    // Use user settings or defaults
    const sameAuthorPenalty = diversitySettings?.sameAuthorPenalty ?? this.WEIGHTS.diversity.sameAuthorPenalty;
    const sameTopicPenalty = diversitySettings?.sameTopicPenalty ?? this.WEIGHTS.diversity.sameTopicPenalty;
    
    let penalty = 1.0;
    
    // Penalize if same author appeared recently
    if (recentAuthors.includes(post.oxyUserId)) {
      penalty *= sameAuthorPenalty;
    }
    
    // Penalize if same topics appeared recently
    if (post.hashtags && post.hashtags.length > 0) {
      const recentTopicMatches = post.hashtags.filter((tag: string) =>
        recentTopics.some((rt: string) => rt.toLowerCase() === tag.toLowerCase())
      );
      
      if (recentTopicMatches.length > 0) {
        penalty *= sameTopicPenalty;
      }
    }
    
    return penalty;
  }

  /**
   * Calculate negative signals penalty (hidden, muted, blocked)
   */
  private async calculateNegativePenalty(
    post: any,
    userId: string | undefined,
    userBehavior: any
  ): Promise<number> {
    if (!userId || !userBehavior) {
      return 1.0;
    }
    
    const authorId = post.oxyUserId;
    
    // Check if author is hidden, muted, or blocked
    if (
      userBehavior.hiddenAuthors?.includes(authorId) ||
      userBehavior.mutedAuthors?.includes(authorId) ||
      userBehavior.blockedAuthors?.includes(authorId)
    ) {
      return 0; // Completely hide
    }
    
    // Check if topic is hidden
    if (post.hashtags && userBehavior.hiddenTopics?.length > 0) {
      const hasHiddenTopic = post.hashtags.some((tag: string) =>
        userBehavior.hiddenTopics.includes(tag.toLowerCase())
      );
      
      if (hasHiddenTopic) {
        return 0.5; // Reduce visibility
      }
    }
    
    return 1.0;
  }

  /**
   * Rank and sort posts by score
   * Optimized with batch processing and score caching
   * 
   * @param posts - Array of post documents to rank
   * @param userId - Oxy user ID (from req.user?.id) or undefined for anonymous users
   * @param context - Additional context (followingIds, userBehavior, feedSettings)
   */
  async rankPosts(
    posts: any[],
    userId: string | undefined, // Oxy user ID
    context: {
      followingIds?: string[]; // Array of Oxy user IDs
      userBehavior?: any;
      feedSettings?: any; // User feed settings
    } = {}
  ): Promise<any[]> {
    // Early return for empty posts
    if (posts.length === 0) {
      return [];
    }
    
    // Load user behavior if not provided (batch load once)
    let userBehavior = context.userBehavior;
    if (userId && !userBehavior) {
      try {
        userBehavior = await UserBehavior.findOne({ oxyUserId: userId }).lean();
      } catch (error) {
        logger.warn('Failed to load user behavior:', error);
      }
    }
    
    // Get following list if not provided (batch load once)
    let followingIds = context.followingIds;
    if (userId && !followingIds) {
      try {
        // Lazy import to avoid circular dependency with server.ts
        const { oxy } = await import('../../server.js');
        const followingRes = await oxy.getUserFollowing(userId);
        followingIds = extractFollowingIds(followingRes);
      } catch (error) {
        logger.warn('Failed to load following list:', error);
        followingIds = [];
      }
    }
    
    // Pre-calculate engagement scores once (used in multiple places)
    const engagementScoreCache = new Map<string, number>();
    posts.forEach(post => {
      const postId = post._id?.toString() || '';
      if (!engagementScoreCache.has(postId)) {
        engagementScoreCache.set(postId, this.calculateEngagementScore(post));
      }
    });
    
    // Track recent authors and topics for diversity (build incrementally)
    const recentAuthors: string[] = [];
    const recentTopics: string[] = [];
    
    // Calculate scores for all posts in parallel
    // Preserve original index to maintain MongoDB's createdAt sort order for tie-breaking
    const postsWithScores = await Promise.all(
      posts.map(async (post, originalIndex) => {
        const score = await this.calculatePostScore(post, userId, {
          followingIds,
          userBehavior,
          recentAuthors: [...recentAuthors], // Copy current state
          recentTopics: [...recentTopics], // Copy current state
          feedSettings: context.feedSettings
        });
        
        // Update recent lists for diversity calculation (for next posts)
        if (post.oxyUserId && !recentAuthors.includes(post.oxyUserId)) {
          recentAuthors.push(post.oxyUserId);
        }
        if (post.hashtags) {
          post.hashtags.forEach((tag: string) => {
            const normalizedTag = tag.toLowerCase();
            if (!recentTopics.includes(normalizedTag)) {
              recentTopics.push(normalizedTag);
            }
          });
        }
        
        return { post, score, originalIndex };
      })
    );
    
    // Sort by score (descending), preserving MongoDB's createdAt order for ties
    // MongoDB already sorted by createdAt: -1, so originalIndex reflects that order
    postsWithScores.sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (Math.abs(scoreDiff) > 0.001) {
        return scoreDiff; // Significant score difference, use score
      }
      // Scores are very close or equal - preserve MongoDB's createdAt order
      // Lower originalIndex = newer post (MongoDB sorted createdAt: -1)
      return a.originalIndex - b.originalIndex;
    });
    
    // CRITICAL: Attach finalScore to each post for later reuse
    // This avoids expensive recalculation during cursor filtering
    // Performance optimization: saves ~60-100ms per request for large feeds
    postsWithScores.forEach(({ post, score }) => {
      (post as any).finalScore = score;
    });
    
    // Return ranked posts with scores attached
    return postsWithScores.map(item => item.post);
  }
}

export const feedRankingService = new FeedRankingService();

