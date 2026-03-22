import { Post } from '../models/Post';
import UserBehavior from '../models/UserBehavior';
import mongoose from 'mongoose';
import { MtnConfig } from '@mention/shared-types';
import { extractFollowingIds } from '../utils/privacyHelpers';
import { logger } from '../utils/logger';
import { getRedisClient } from '../utils/redis';
import { withRedisFallback } from '../utils/redisHelpers';
import { metrics } from '../utils/metrics';
import { explainRanking } from '../mtn/feed/RankingExplainer';

interface BehaviorSets {
  hiddenAuthors: Set<string>;
  mutedAuthors: Set<string>;
  blockedAuthors: Set<string>;
  hiddenTopics: Set<string>;
  preferredTopicIds: Set<string>;
}

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
  private redis: ReturnType<typeof getRedisClient>;
  private readonly ENGAGEMENT_SCORE_CACHE_TTL = 5 * 60; // 5 minutes
  private readonly ENGAGEMENT_SCORE_CACHE_PREFIX = 'engagement:score:';
  private readonly LARGE_CANDIDATE_SET_THRESHOLD = 1000; // Use approximate ranking for sets larger than this
  private readonly TOP_K_FOR_APPROXIMATE = 500; // Top K posts to fully rank when using approximate method
  
  // Weight configuration sourced from MtnConfig (single source of truth)
  private readonly R = MtnConfig.ranking;

  // Shares weight is not in MtnConfig yet; keep a local constant until added
  private readonly SHARE_WEIGHT = 2.0;

  constructor() {
    this.redis = getRedisClient();
  }

  private buildBehaviorSets(userBehavior: any): BehaviorSets | undefined {
    if (!userBehavior) return undefined;
    return {
      hiddenAuthors: new Set<string>(userBehavior.hiddenAuthors || []),
      mutedAuthors: new Set<string>(userBehavior.mutedAuthors || []),
      blockedAuthors: new Set<string>(userBehavior.blockedAuthors || []),
      hiddenTopics: new Set<string>((userBehavior.hiddenTopics || []).map((t: string) => t.toLowerCase())),
      preferredTopicIds: new Set<string>(
        (userBehavior.preferredTopics || [])
          .filter((t: any) => t.topicId && t.weight > 0.3)
          .map((t: any) => t.topicId.toString()),
      ),
    };
  }

  /**
   * Get cached engagement score or calculate and cache
   */
  private async getCachedEngagementScore(postId: string, post: any): Promise<number> {
    const cacheKey = `${this.ENGAGEMENT_SCORE_CACHE_PREFIX}${postId}`;
    
    // Try to get from cache
    const cached = await withRedisFallback(
      this.redis,
      async () => {
        const data = await this.redis.get(cacheKey);
        return data ? parseFloat(data) : null;
      },
      null,
      'engagement score cache'
    );
    
    if (cached !== null) {
      return cached;
    }
    
    // Calculate and cache
    const score = this.calculateEngagementScore(post);
    await withRedisFallback(
      this.redis,
      async () => {
        await this.redis.setEx(cacheKey, this.ENGAGEMENT_SCORE_CACHE_TTL, score.toString());
      },
      undefined,
      'engagement score cache set'
    );
    
    return score;
  }

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
      engagementScoreCache?: Map<string, number>; // Optional pre-calculated engagement scores
      followingIdsSet?: Set<string>;
      recentAuthorsSet?: Set<string>;
      recentTopicsSet?: Set<string>;
      behaviorSets?: BehaviorSets;
    } = {}
  ): Promise<number> {
    // Helper to guard each sub-score against NaN/Infinity
    const safe = (score: number, fallback: number = 1): number =>
      Number.isFinite(score) ? score : fallback;

    // Resolve Sets for O(1) lookups (use pre-computed if available, else create from arrays)
    const followingIdsSet = context.followingIdsSet ?? new Set(context.followingIds || []);
    const recentAuthorsSet = context.recentAuthorsSet ?? new Set(context.recentAuthors || []);
    const recentTopicsSet = context.recentTopicsSet ?? new Set(context.recentTopics || []);

    // Base engagement score (use cache if available, otherwise calculate)
    const postId = post._id?.toString() || '';
    let engagementScore: number;
    if (context.engagementScoreCache?.has(postId)) {
      engagementScore = safe(context.engagementScoreCache.get(postId)!, 0);
    } else {
      engagementScore = safe(this.calculateEngagementScore(post), 0);
    }

    // Recency score with time decay (using user settings if provided)
    const recencyScore = safe(this.calculateRecencyScore(
      post.createdAt,
      context.feedSettings?.recency?.halfLifeHours,
      context.feedSettings?.recency?.maxAgeHours
    ));

    // Author relationship score
    const authorScore = safe(await this.calculateAuthorScore(
      post.oxyUserId,
      userId,
      followingIdsSet,
      context.userBehavior
    ));

    // Personalization score
    const personalizationScore = safe(await this.calculatePersonalizationScore(
      post,
      context.userBehavior,
      context.behaviorSets,
    ));

    // Content quality score (with improved metrics)
    const qualityScore = safe(this.calculateQualityScore(post));

    // Trending boost (for posts gaining traction)
    const trendingBoost = safe(this.calculateTrendingBoost(post));

    // Time-of-day relevance score
    const timeOfDayScore = safe(this.calculateTimeOfDayScore(post, context.userBehavior));

    // Diversity penalty (apply after all boosts, using user settings if provided)
    const diversityPenalty = safe(this.calculateDiversityPenalty(
      post,
      recentAuthorsSet,
      recentTopicsSet,
      context.feedSettings?.diversity
    ));

    // Apply negative signals
    const negativePenalty = safe(await this.calculateNegativePenalty(
      post,
      userId,
      context.userBehavior,
      context.behaviorSets
    ));

    // Thread boost: thread roots with replies get a bump (encourages thread engagement)
    const threadBoost = safe(this.calculateThreadBoost(post));

    // Combine all scores (each sub-score is already guarded)
    const finalScore = engagementScore
      * recencyScore
      * authorScore
      * personalizationScore
      * qualityScore
      * trendingBoost
      * timeOfDayScore
      * threadBoost
      * diversityPenalty
      * negativePenalty;

    const safeScore = Math.max(0, finalScore); // Ensure non-negative

    // Attach ranking factor breakdowns for RankingExplainer
    post._rankEngagement = engagementScore;
    post._rankRecency = recencyScore;
    post._rankRelationship = authorScore;
    post._rankPersonalization = personalizationScore;
    post._rankQuality = qualityScore * trendingBoost * timeOfDayScore * threadBoost;
    post._rankDiversity = diversityPenalty * negativePenalty;

    return safeScore;
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
      (stats.likesCount || 0) * this.R.engagement.likeWeight +
      (stats.repostsCount || 0) * this.R.engagement.repostWeight +
      (stats.commentsCount || 0) * this.R.engagement.commentWeight +
      savesCount * this.R.engagement.saveWeight +
      (stats.viewsCount || 0) * this.R.engagement.viewWeight +
      (stats.sharesCount || 0) * this.SHARE_WEIGHT
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
    if (isNaN(postDate.getTime())) {
      return 0; // Invalid date, treat as very old post
    }
    const now = new Date();
    const ageHours = (now.getTime() - postDate.getTime()) / (1000 * 60 * 60);

    const maxAge = maxAgeHours || this.R.recency.maxAgeMs / (1000 * 60 * 60);
    // If post is older than max age, return 0
    if (ageHours > maxAge) {
      return 0;
    }
    
    const halfLife = halfLifeHours || this.R.recency.halfLifeMs / (1000 * 60 * 60);
    
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
    followingIdsSet: Set<string>, // Set of Oxy user IDs
    userBehavior: any
  ): Promise<number> {
    if (!userId) {
      return 1.0; // No personalization for anonymous users
    }

    // Check if following
    const isFollowing = followingIdsSet.has(authorId);
    if (isFollowing) {
      return this.R.relationship.followBoost;
    }
    
    // Check relationship strength from behavior data
    if (userBehavior?.preferredAuthors) {
      const authorPreference = userBehavior.preferredAuthors.find(
        (a: any) => a.authorId === authorId
      );
      
      if (authorPreference) {
        // Strong relationship (weight > 0.7)
        if (authorPreference.weight > 0.7) {
          return this.R.relationship.strongRelation;
        }
        // Weak relationship (weight > 0.3)
        if (authorPreference.weight > 0.3) {
          return this.R.relationship.weakRelation;
        }
      }
    }
    
    // No relationship - slight penalty
    return this.R.relationship.noRelation;
  }

  /**
   * Calculate personalization score based on user preferences
   */
  private async calculatePersonalizationScore(
    post: any,
    userBehavior: any,
    behaviorSets?: BehaviorSets,
  ): Promise<number> {
    if (!userBehavior) {
      return 1.0;
    }
    
    let score = 1.0;
    
    // Topic matching (hashtags + AI-extracted topics)
    if (userBehavior.preferredTopics) {
      let matchCount = 0;

      // Match via hashtags (existing behavior)
      if (post.hashtags && post.hashtags.length > 0) {
        matchCount += post.hashtags.filter((tag: string) =>
          userBehavior.preferredTopics.some((t: any) =>
            t.topic.toLowerCase() === tag.toLowerCase() && t.weight > 0.3
          )
        ).length;
      }

      // Match via AI-extracted topic IDs (richer signal)
      const prefTopicIds = behaviorSets?.preferredTopicIds;
      if (post.extracted?.topics && post.extracted.topics.length > 0 && prefTopicIds && prefTopicIds.size > 0) {
        matchCount += post.extracted.topics.filter(
          (et: any) => et.topicId && prefTopicIds.has(et.topicId.toString()),
        ).length;
      }

      if (matchCount > 0) {
        score *= 1 + (matchCount * 0.1) * this.R.personalization.topicMatch;
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
          score *= this.R.personalization.postTypeMatch;
        }
      }
    }
    
    // Language preference
    if (post.language && userBehavior.preferredLanguages?.length > 0) {
      if (userBehavior.preferredLanguages.includes(post.language)) {
        score *= this.R.personalization.languageMatch;
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
      (stats.likesCount || 0) * this.R.engagement.likeWeight +
      (stats.repostsCount || 0) * this.R.engagement.repostWeight +
      (stats.commentsCount || 0) * this.R.engagement.commentWeight +
      (Array.isArray(post.metadata?.savedBy) ? post.metadata.savedBy.length : 0) * this.R.engagement.saveWeight +
      (stats.sharesCount || 0) * this.SHARE_WEIGHT
    );
    
    // Calculate engagement rate (engagement per view)
    const engagementRate = rawEngagement / viewsCount;
    
    // Calculate engagement velocity (recent engagement vs total)
    // Posts with recent engagement are more relevant
    const createdAtMs = new Date(post.createdAt).getTime();
    const postAge = isNaN(createdAtMs) ? Infinity : (Date.now() - createdAtMs) / (1000 * 60 * 60); // hours
    const velocityBoost = postAge < 6 ? 1.2 : postAge < 24 ? 1.1 : 1.0; // Boost for very recent posts
    
    // High engagement rate = quality content
    if (engagementRate > 0.5) {
      return this.R.quality.highEngagement * velocityBoost;
    }
    
    // Medium engagement rate = decent quality
    if (engagementRate > 0.2) {
      return 1.0 * velocityBoost;
    }
    
    // Low engagement rate = lower quality (only penalize if post has significant views)
    if (engagementRate < 0.1 && viewsCount > 100) {
      return this.R.quality.lowEngagement;
    }
    
    return 1.0; // Neutral for posts with few views
  }

  /**
   * Calculate trending boost for posts with accelerating engagement
   * Detects posts that are gaining traction rapidly
   */
  private calculateTrendingBoost(post: any): number {
    const stats = post.stats || {};
    const createdAtMs = new Date(post.createdAt).getTime();
    const postAge = isNaN(createdAtMs) ? Infinity : (Date.now() - createdAtMs) / (1000 * 60 * 60); // hours

    // Only consider posts less than 24 hours old for trending
    if (postAge > 24) {
      return 1.0;
    }
    
    // Calculate engagement density (engagement per hour)
    const rawEngagement = (
      (stats.likesCount || 0) * this.R.engagement.likeWeight +
      (stats.repostsCount || 0) * this.R.engagement.repostWeight +
      (stats.commentsCount || 0) * this.R.engagement.commentWeight +
      (Array.isArray(post.metadata?.savedBy) ? post.metadata.savedBy.length : 0) * this.R.engagement.saveWeight +
      (stats.sharesCount || 0) * this.SHARE_WEIGHT
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
   * Calculate thread boost for thread root posts with replies.
   * Thread roots that sparked conversation are more valuable feed items,
   * especially since they'll be displayed as grouped slices.
   */
  private calculateThreadBoost(post: any): number {
    const hasThread = post.threadId && !post.parentPostId;
    const hasReplies = (post.stats?.commentsCount || 0) > 0;

    if (hasThread && hasReplies) {
      return 1.1; // 10% boost for thread roots with conversation
    }
    return 1.0;
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
    recentAuthorsSet: Set<string>,
    recentTopicsSet: Set<string>,
    diversitySettings?: any
  ): number {
    // If diversity is disabled, return no penalty
    if (diversitySettings?.enabled === false) {
      return 1.0;
    }
    
    // Use user settings or defaults
    const sameAuthorPenalty = diversitySettings?.sameAuthorPenalty ?? this.R.diversity.sameAuthorPenalty;
    const sameTopicPenalty = diversitySettings?.sameTopicPenalty ?? this.R.diversity.sameTopicPenalty;
    
    let penalty = 1.0;
    
    // Penalize if same author appeared recently
    if (recentAuthorsSet.has(post.oxyUserId)) {
      penalty *= sameAuthorPenalty;
    }
    
    // Penalize if same topics appeared recently
    if (post.hashtags && post.hashtags.length > 0) {
      const recentTopicMatches = post.hashtags.filter((tag: string) =>
        recentTopicsSet.has(tag.toLowerCase())
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
    userBehavior: any,
    behaviorSets?: BehaviorSets
  ): Promise<number> {
    if (!userId || !userBehavior) {
      return 1.0;
    }

    const authorId = post.oxyUserId;

    // Use pre-computed Sets if available, else create from arrays
    const sets = behaviorSets ?? this.buildBehaviorSets(userBehavior)!;

    // Check if author is hidden, muted, or blocked
    if (
      sets.hiddenAuthors.has(authorId) ||
      sets.mutedAuthors.has(authorId) ||
      sets.blockedAuthors.has(authorId)
    ) {
      return 0; // Completely hide
    }

    // Check if topic is hidden (via hashtags or extracted topic names)
    if (sets.hiddenTopics.size > 0) {
      const hasHiddenHashtag = post.hashtags?.some((tag: string) =>
        sets.hiddenTopics.has(tag.toLowerCase())
      );

      const hasHiddenExtractedTopic = post.extracted?.topics?.some(
        (et: any) => sets.hiddenTopics.has(et.name?.toLowerCase()),
      );

      if (hasHiddenHashtag || hasHiddenExtractedTopic) {
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
    const rankingStartTime = Date.now();
    
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
    
    // Pre-compute Sets for O(1) lookups in scoring loop
    const followingIdsSet = new Set(followingIds || []);
    const behaviorSets = this.buildBehaviorSets(userBehavior);

    // Pre-calculate engagement scores with caching (batch load from cache)
    const engagementScoreCache = new Map<string, number>();
    const engagementScorePromises = posts.map(async (post) => {
      const postId = post._id?.toString() || '';
      if (!engagementScoreCache.has(postId)) {
        const score = await this.getCachedEngagementScore(postId, post);
        engagementScoreCache.set(postId, score);
      }
    });
    await Promise.all(engagementScorePromises);
    
    // For large candidate sets, use approximate ranking (top-k selection)
    let postsToRank = posts;
    if (posts.length > this.LARGE_CANDIDATE_SET_THRESHOLD) {
      logger.debug(`Using approximate ranking for large candidate set (${posts.length} posts)`);
      // Quick pre-ranking based on engagement score only (fast approximation)
      const quickScores = posts.map((post, index) => {
        const postId = post._id?.toString() || '';
        const engagementScore = engagementScoreCache.get(postId) || 0;
        // Simple recency boost
        const createdMs = new Date(post.createdAt).getTime();
        const postAge = isNaN(createdMs) ? Infinity : (Date.now() - createdMs) / (1000 * 60 * 60);
        const recencyBoost = postAge < 24 ? Math.exp(-postAge / 24) : 0.1;
        return {
          post,
          quickScore: engagementScore * recencyBoost,
          originalIndex: index
        };
      });
      
      // Sort by quick score and take top K
      quickScores.sort((a, b) => b.quickScore - a.quickScore);
      postsToRank = quickScores.slice(0, this.TOP_K_FOR_APPROXIMATE).map(item => item.post);
      logger.debug(`Reduced candidate set from ${posts.length} to ${postsToRank.length} posts for full ranking`);
    }
    
    // Calculate base scores for all posts in parallel (without diversity)
    // Preserve original index to maintain MongoDB's createdAt sort order for tie-breaking
    const postsWithBaseScores = await Promise.all(
      postsToRank.map(async (post, originalIndex) => {
        const score = await this.calculatePostScore(post, userId, {
          userBehavior,
          feedSettings: context.feedSettings,
          engagementScoreCache,
          followingIdsSet,
          behaviorSets,
        });
        return { post, score, originalIndex };
      })
    );

    // Apply diversity penalty sequentially — each post's penalty depends on previously seen authors/topics
    // Per-slice awareness: posts that will be grouped into the same thread slice
    // (same threadId + same oxyUserId) only penalize once for their author
    const recentAuthorsSet = new Set<string>();
    const recentTopicsSet = new Set<string>();
    const penalizedThreadIds = new Set<string>();
    const safe = (v: number, fallback: number = 1) => Number.isFinite(v) ? v : fallback;

    const postsWithScores = postsWithBaseScores.map((item) => {
      // For thread children by the same author, skip diversity penalty
      // if the thread root was already counted (they'll appear in the same slice)
      const threadKey = item.post.threadId && item.post.oxyUserId
        ? `${item.post.threadId}:${item.post.oxyUserId}`
        : null;
      const isAlreadyPenalizedThread = threadKey && penalizedThreadIds.has(threadKey);

      const diversityPenalty = isAlreadyPenalizedThread
        ? 1.0 // Skip penalty — this post will be grouped with its thread root
        : safe(this.calculateDiversityPenalty(
            item.post,
            recentAuthorsSet,
            recentTopicsSet,
            context.feedSettings?.diversity
          ));

      // Track this post's author/topics for subsequent posts
      if (item.post.oxyUserId && !isAlreadyPenalizedThread) {
        recentAuthorsSet.add(item.post.oxyUserId);
      }
      if (item.post.hashtags && !isAlreadyPenalizedThread) {
        item.post.hashtags.forEach((tag: string) => {
          recentTopicsSet.add(tag.toLowerCase());
        });
      }
      if (threadKey) {
        penalizedThreadIds.add(threadKey);
      }

      return { ...item, score: item.score * diversityPenalty };
    });
    
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
    
    // CRITICAL: Attach finalScore and ranking explanation to each post for later reuse
    // This avoids expensive recalculation during cursor filtering
    // Performance optimization: saves ~60-100ms per request for large feeds
    postsWithScores.forEach(({ post, score }) => {
      (post as any).finalScore = score;
      (post as any).rankingExplanation = explainRanking(post);
    });
    
    // Record ranking metrics
    const rankingDuration = Date.now() - rankingStartTime;
    metrics.recordLatency('feed_ranking_duration_ms', rankingDuration, { 
      post_count: posts.length.toString(),
      user_id: userId || 'anonymous'
    });
    metrics.setGauge('feed_ranking_posts_processed', posts.length);
    
    // Return ranked posts with scores attached
    return postsWithScores.map(item => item.post);
  }
}

export const feedRankingService = new FeedRankingService();

