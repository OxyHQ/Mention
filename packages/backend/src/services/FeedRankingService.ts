import { Post } from '../models/Post';
import UserBehavior from '../models/UserBehavior';
import mongoose from 'mongoose';
import { extractFollowingIds } from '../utils/privacyHelpers';

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
    } = {}
  ): Promise<number> {
    // Base engagement score
    const engagementScore = this.calculateEngagementScore(post);
    
    // Recency score with time decay
    const recencyScore = this.calculateRecencyScore(post.createdAt);
    
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
    
    // Content quality score
    const qualityScore = this.calculateQualityScore(post);
    
    // Diversity penalty (apply after all boosts)
    const diversityPenalty = this.calculateDiversityPenalty(
      post,
      context.recentAuthors || [],
      context.recentTopics || []
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
      * diversityPenalty
      * negativePenalty;
    
    return Math.max(0, finalScore); // Ensure non-negative
  }

  /**
   * Calculate engagement score from post stats
   */
  private calculateEngagementScore(post: any): number {
    const stats = post.stats || {};
    const metadata = post.metadata || {};
    
    // Get saves count from metadata.savedBy array
    const savesCount = Array.isArray(metadata.savedBy) 
      ? metadata.savedBy.length 
      : 0;
    
    return (
      (stats.likesCount || 0) * this.WEIGHTS.engagement.likes +
      (stats.repostsCount || 0) * this.WEIGHTS.engagement.reposts +
      (stats.commentsCount || 0) * this.WEIGHTS.engagement.comments +
      savesCount * this.WEIGHTS.engagement.saves +
      (stats.viewsCount || 0) * this.WEIGHTS.engagement.views +
      (stats.sharesCount || 0) * this.WEIGHTS.engagement.shares
    );
  }

  /**
   * Calculate recency score with exponential decay
   * Uses half-life formula: value = base * (0.5 ^ (age / halfLife))
   */
  private calculateRecencyScore(createdAt: Date | string): number {
    const postDate = new Date(createdAt);
    const now = new Date();
    const ageHours = (now.getTime() - postDate.getTime()) / (1000 * 60 * 60);
    
    // If post is older than max age, return 0
    if (ageHours > this.WEIGHTS.recency.maxAgeHours) {
      return 0;
    }
    
    // Exponential decay with half-life
    const halfLife = this.WEIGHTS.recency.halfLifeHours;
    const decayFactor = Math.pow(0.5, ageHours / halfLife);
    
    // Ensure minimum value for very recent posts (within 1 hour)
    return ageHours < 1 ? 1.0 : Math.max(0.1, decayFactor);
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
   * Calculate content quality score
   */
  private calculateQualityScore(post: any): number {
    const stats = post.stats || {};
    const viewsCount = stats.viewsCount || 1; // Avoid division by zero
    
    // Calculate engagement rate (engagement per view)
    const engagementScore = this.calculateEngagementScore(post);
    const engagementRate = engagementScore / viewsCount;
    
    // High engagement rate = quality content
    if (engagementRate > 0.5) {
      return this.WEIGHTS.quality.highEngagementRateBoost;
    }
    
    // Low engagement rate = lower quality
    if (engagementRate < 0.1 && viewsCount > 100) {
      return this.WEIGHTS.quality.lowEngagementRatePenalty;
    }
    
    return 1.0; // Neutral
  }

  /**
   * Calculate diversity penalty to avoid echo chambers
   */
  private calculateDiversityPenalty(
    post: any,
    recentAuthors: string[],
    recentTopics: string[]
  ): number {
    let penalty = 1.0;
    
    // Penalize if same author appeared recently
    if (recentAuthors.includes(post.oxyUserId)) {
      penalty *= this.WEIGHTS.diversity.sameAuthorPenalty;
    }
    
    // Penalize if same topics appeared recently
    if (post.hashtags && post.hashtags.length > 0) {
      const recentTopicMatches = post.hashtags.filter((tag: string) =>
        recentTopics.some((rt: string) => rt.toLowerCase() === tag.toLowerCase())
      );
      
      if (recentTopicMatches.length > 0) {
        penalty *= this.WEIGHTS.diversity.sameTopicPenalty;
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
   * 
   * @param posts - Array of post documents to rank
   * @param userId - Oxy user ID (from req.user?.id) or undefined for anonymous users
   * @param context - Additional context (followingIds, userBehavior)
   */
  async rankPosts(
    posts: any[],
    userId: string | undefined, // Oxy user ID
    context: {
      followingIds?: string[]; // Array of Oxy user IDs
      userBehavior?: any;
    } = {}
  ): Promise<any[]> {
    // Load user behavior if not provided
    let userBehavior = context.userBehavior;
    if (userId && !userBehavior) {
      try {
        userBehavior = await UserBehavior.findOne({ oxyUserId: userId }).lean();
      } catch (error) {
        console.warn('Failed to load user behavior:', error);
      }
    }
    
    // Get following list if not provided
    let followingIds = context.followingIds;
    if (userId && !followingIds) {
      try {
        const { oxy } = require('../../server');
        const followingRes = await oxy.getUserFollowing(userId);
        followingIds = extractFollowingIds(followingRes);
      } catch (error) {
        console.warn('Failed to load following list:', error);
        followingIds = [];
      }
    }
    
    // Track recent authors and topics for diversity
    const recentAuthors: string[] = [];
    const recentTopics: string[] = [];
    
    // Calculate scores for all posts
    const postsWithScores = await Promise.all(
      posts.map(async (post) => {
        const score = await this.calculatePostScore(post, userId, {
          followingIds,
          userBehavior,
          recentAuthors,
          recentTopics
        });
        
        // Update recent lists for diversity calculation
        if (post.oxyUserId && !recentAuthors.includes(post.oxyUserId)) {
          recentAuthors.push(post.oxyUserId);
        }
        if (post.hashtags) {
          post.hashtags.forEach((tag: string) => {
            if (!recentTopics.includes(tag.toLowerCase())) {
              recentTopics.push(tag.toLowerCase());
            }
          });
        }
        
        return { post, score };
      })
    );
    
    // Sort by score (descending)
    postsWithScores.sort((a, b) => b.score - a.score);
    
    // Return ranked posts
    return postsWithScores.map(item => item.post);
  }
}

export const feedRankingService = new FeedRankingService();

