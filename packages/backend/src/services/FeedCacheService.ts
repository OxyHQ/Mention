import { Post } from '../models/Post';
import UserBehavior from '../models/UserBehavior';
import { feedRankingService } from './FeedRankingService';
import mongoose from 'mongoose';
import { extractFollowingIds } from '../utils/privacyHelpers';

/**
 * FeedCacheService - Caches precomputed feeds for performance
 * Similar to how Twitter precomputes timelines
 * 
 * Strategy:
 * - Cache personalized feeds for active users
 * - Refresh cache periodically via background jobs
 * - Invalidate on new interactions
 * - Use MongoDB for cache storage (can be replaced with Redis)
 */

interface CachedFeed {
  userId: string;
  feedType: string;
  posts: any[];
  scores: Map<string, number>;
  nextCursor?: string;
  cachedAt: Date;
  expiresAt: Date;
}

export class FeedCacheService {
  private cache: Map<string, CachedFeed> = new Map();
  private readonly CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
  private readonly MAX_CACHE_SIZE = 1000; // Max cached feeds

  /**
   * Get cached feed or compute and cache
   */
  async getOrComputeFeed(
    userId: string | undefined,
    feedType: string,
    computeFn: () => Promise<any[]>
  ): Promise<any[]> {
    if (!userId) {
      // No cache for anonymous users
      return await computeFn();
    }

    const cacheKey = this.getCacheKey(userId, feedType);
    const cached = this.cache.get(cacheKey);

    // Check if cache is valid
    if (cached && cached.expiresAt > new Date()) {
      return cached.posts;
    }

    // Compute and cache
    const posts = await computeFn();
    await this.setCache(cacheKey, userId, feedType, posts);

    return posts;
  }

  /**
   * Invalidate cache for user (when user interacts with content)
   */
  async invalidateUserCache(userId: string, feedType?: string): Promise<void> {
    if (feedType) {
      const cacheKey = this.getCacheKey(userId, feedType);
      this.cache.delete(cacheKey);
    } else {
      // Invalidate all feeds for user
      const keysToDelete: string[] = [];
      this.cache.forEach((feed, key) => {
        if (feed.userId === userId) {
          keysToDelete.push(key);
        }
      });
      keysToDelete.forEach(key => this.cache.delete(key));
    }
  }

  /**
   * Precompute and cache feed for user (for background jobs)
   * 
   * @param userId - Oxy user ID
   * @param feedType - Type of feed to precompute
   * @param limit - Number of posts to precompute
   */
  async precomputeFeed(
    userId: string, // Oxy user ID
    feedType: 'for_you' | 'following' | 'explore',
    limit: number = 50
  ): Promise<void> {
    try {
      let posts: any[] = [];

      switch (feedType) {
        case 'for_you':
          posts = await this.precomputeForYouFeed(userId, limit);
          break;
        case 'following':
          posts = await this.precomputeFollowingFeed(userId, limit);
          break;
        case 'explore':
          posts = await this.precomputeExploreFeed(userId, limit);
          break;
      }

      const cacheKey = this.getCacheKey(userId, feedType);
      await this.setCache(cacheKey, userId, feedType, posts);
    } catch (error) {
      console.error(`Error precomputing feed for user ${userId}:`, error);
    }
  }

  /**
   * Precompute For You feed
   */
  private async precomputeForYouFeed(userId: string, limit: number): Promise<any[]> {
    // userId is an Oxy user ID, query UserBehavior using oxyUserId field
    const userBehavior = await UserBehavior.findOne({ oxyUserId: userId }).lean();

    // Get following list
    const { oxy } = require('../../../server');
    let followingIds: string[] = [];
    try {
      const followingRes = await oxy.getUserFollowing(userId);
      followingIds = extractFollowingIds(followingRes);
    } catch (error) {
      console.warn('Failed to load following list:', error);
    }

    // Get candidate posts (public posts, not replies/reposts initially)
    const candidatePosts = await Post.find({
      visibility: 'public',
      $and: [
        { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
        { $or: [{ repostOf: null }, { repostOf: { $exists: false } }] }
      ]
    })
      .sort({ createdAt: -1 })
      .limit(limit * 3) // Get 3x to allow for ranking and filtering
      .lean();

    // Rank posts using ranking service
    const rankedPosts = await feedRankingService.rankPosts(
      candidatePosts,
      userId,
      {
        followingIds,
        userBehavior
      }
    );

    // Return top N posts
    return rankedPosts.slice(0, limit);
  }

  /**
   * Precompute Following feed
   */
  private async precomputeFollowingFeed(userId: string, limit: number): Promise<any[]> {
    // Get following list
    const { oxy } = require('../../../server');
    let followingIds: string[] = [];
    try {
      const followingRes = await oxy.getUserFollowing(userId);
      followingIds = extractFollowingIds(followingRes);
      // Include user's own posts
      followingIds.push(userId);
    } catch (error) {
      console.warn('Failed to load following list:', error);
      followingIds = [userId]; // At least include own posts
    }

    const posts = await Post.find({
      oxyUserId: { $in: followingIds },
      visibility: 'public',
      $and: [
        { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
        { $or: [{ repostOf: null }, { repostOf: { $exists: false } }] }
      ]
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return posts;
  }

  /**
   * Precompute Explore feed
   */
  private async precomputeExploreFeed(userId: string, limit: number): Promise<any[]> {
    // Get user behavior for personalization
    const userBehavior = await UserBehavior.findOne({ oxyUserId: userId }).lean();

    // Get candidate posts (all public posts)
    const candidatePosts = await Post.find({
      visibility: 'public',
      $and: [
        { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
        { $or: [{ repostOf: null }, { repostOf: { $exists: false } }] }
      ]
    })
      .sort({ createdAt: -1 })
      .limit(limit * 3)
      .lean();

    // Rank by engagement score
    const rankedPosts = await feedRankingService.rankPosts(
      candidatePosts,
      userId,
      { userBehavior }
    );

    return rankedPosts.slice(0, limit);
  }

  /**
   * Set cache entry
   */
  private async setCache(
    cacheKey: string,
    userId: string,
    feedType: string,
    posts: any[]
  ): Promise<void> {
    // Clean old cache entries if at capacity
    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      this.cleanExpiredCache();
    }

    const cachedFeed: CachedFeed = {
      userId,
      feedType,
      posts,
      scores: new Map(),
      cachedAt: new Date(),
      expiresAt: new Date(Date.now() + this.CACHE_TTL_MS)
    };

    this.cache.set(cacheKey, cachedFeed);
  }

  /**
   * Clean expired cache entries
   */
  private cleanExpiredCache(): void {
    const now = new Date();
    const keysToDelete: string[] = [];

    this.cache.forEach((feed, key) => {
      if (feed.expiresAt <= now) {
        keysToDelete.push(key);
      }
    });

    keysToDelete.forEach(key => this.cache.delete(key));

    // If still at capacity, remove oldest entries
    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      const sortedEntries = Array.from(this.cache.entries())
        .sort((a, b) => a[1].cachedAt.getTime() - b[1].cachedAt.getTime());
      
      const toRemove = sortedEntries.slice(0, this.MAX_CACHE_SIZE / 10); // Remove 10%
      toRemove.forEach(([key]) => this.cache.delete(key));
    }
  }

  /**
   * Get cache key
   */
  private getCacheKey(userId: string, feedType: string): string {
    return `${userId}:${feedType}`;
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    size: number;
    entries: Array<{ userId: string; feedType: string; cachedAt: Date; expiresAt: Date }>;
  } {
    const entries = Array.from(this.cache.values()).map(feed => ({
      userId: feed.userId,
      feedType: feed.feedType,
      cachedAt: feed.cachedAt,
      expiresAt: feed.expiresAt
    }));

    return {
      size: this.cache.size,
      entries
    };
  }
}

export const feedCacheService = new FeedCacheService();

