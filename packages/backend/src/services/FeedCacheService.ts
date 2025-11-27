import { Post } from '../models/Post';
import UserBehavior from '../models/UserBehavior';
import { feedRankingService } from './FeedRankingService';
import mongoose from 'mongoose';
import { extractFollowingIds } from '../utils/privacyHelpers';
import { getRedisClient, createRedisPubSub } from '../utils/redis';
import { logger } from '../utils/logger';
import { isRedisConnectionError, ensureRedisConnected, withRedisFallback } from '../utils/redisHelpers';

/**
 * FeedCacheService - Caches precomputed feeds for performance using Redis
 * Similar to how Twitter precomputes timelines
 * 
 * Strategy:
 * - Cache personalized feeds for active users in Redis
 * - Refresh cache periodically via background jobs
 * - Invalidate on new interactions (with pub/sub for multi-instance)
 * - Distributed cache for horizontal scaling
 */

interface CachedFeed {
  userId: string;
  feedType: string;
  posts: any[];
  nextCursor?: string;
  cachedAt: string; // ISO string for JSON serialization
  expiresAt: string; // ISO string for JSON serialization
}

export class FeedCacheService {
  private readonly CACHE_TTL_SECONDS = 15 * 60; // 15 minutes in seconds
  private readonly CACHE_KEY_PREFIX = 'feed:cache:';
  private readonly INVALIDATION_CHANNEL = 'feed:invalidate';
  private redis: ReturnType<typeof getRedisClient>;
  private pubSub: { publisher: ReturnType<typeof createRedisPubSub>['publisher']; subscriber: ReturnType<typeof createRedisPubSub>['subscriber'] } | null = null;

  constructor() {
    this.redis = getRedisClient();
    this.setupPubSub();
  }

  /**
   * Setup Redis pub/sub for cache invalidation across instances
   */
  private async setupPubSub(): Promise<void> {
    try {
      const { publisher, subscriber } = createRedisPubSub();
      
      // Connect both clients with timeout
      try {
        await Promise.race([
          Promise.all([
            publisher.connect(),
            subscriber.connect()
          ]),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Redis pub/sub connection timeout')), 5000)
          )
        ]);
      } catch (connectError: any) {
        // If Redis unavailable, skip pub/sub setup silently
        // Main client already logged the unavailability
        if (isRedisConnectionError(connectError) || connectError.message?.includes('timeout')) {
          return;
        }
        throw connectError;
      }

      this.pubSub = { publisher, subscriber };

      // Subscribe to invalidation channel using pattern subscribe
      // In node-redis v5, pSubscribe uses callback pattern
      await subscriber.pSubscribe(this.INVALIDATION_CHANNEL, (message: string, channel: string) => {
        try {
          const { userId, feedType } = JSON.parse(message);
          this.handleRemoteInvalidation(userId, feedType);
        } catch (error) {
          logger.error('Error handling cache invalidation message:', error);
        }
      });

      logger.info('Subscribed to cache invalidation channel');
    } catch (error: any) {
      // Silently handle Redis unavailability (main client already logged it)
      if (isRedisConnectionError(error)) {
        return;
      }
      logger.warn('Failed to setup Redis pub/sub, cache invalidation will be local only:', error);
    }
  }

  /**
   * Handle cache invalidation from another instance
   */
  private async handleRemoteInvalidation(userId: string, feedType?: string): Promise<void> {
    // This is handled by Redis TTL, but we can log it for monitoring
    logger.debug(`Cache invalidation received for user ${userId}, feedType: ${feedType || 'all'}`);
  }

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
    
    // Try to get from cache with graceful fallback
    const cachedData = await withRedisFallback(
      this.redis,
      async () => {
        const data = await this.redis.get(cacheKey);
        if (!data) return null;
        
        const cached: CachedFeed = JSON.parse(data);
        const expiresAt = new Date(cached.expiresAt);
        // Check if still valid (Redis TTL should handle this, but double-check)
        return expiresAt > new Date() ? cached.posts : null;
      },
      null,
      'feed cache get'
    );

    if (cachedData) {
      logger.debug(`Cache hit for ${cacheKey}`);
      return cachedData;
    }

    // Compute and cache
    logger.debug(`Cache miss for ${cacheKey}, computing feed...`);
    const posts = await computeFn();
    await this.setCache(cacheKey, userId, feedType, posts);

    return posts;
  }

  /**
   * Invalidate cache for user (when user interacts with content)
   */
  async invalidateUserCache(userId: string, feedType?: string): Promise<void> {
    // Invalidate cache with graceful fallback
    await withRedisFallback(
      this.redis,
      async () => {
        if (feedType) {
          const cacheKey = this.getCacheKey(userId, feedType);
          await this.redis.del([cacheKey]);
          logger.debug(`Invalidated cache for ${cacheKey}`);
        } else {
          // Invalidate all feeds for user (use pattern matching)
          const pattern = `${this.CACHE_KEY_PREFIX}${userId}:*`;
          const keys = await this.redis.keys(pattern);
          if (keys.length > 0) {
            await this.redis.del(keys);
            logger.debug(`Invalidated ${keys.length} cache entries for user ${userId}`);
          }
        }
      },
      undefined,
      'cache invalidation'
    );

    // Publish invalidation message to other instances (non-blocking)
    if (this.pubSub?.publisher) {
      ensureRedisConnected(this.pubSub.publisher)
        .then(async (connected) => {
          if (connected) {
            await this.pubSub!.publisher.publish(
              this.INVALIDATION_CHANNEL,
              JSON.stringify({ userId, feedType })
            );
          }
        })
        .catch(() => {
          // Silently fail - pub/sub is optional
        });
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
      logger.error(`Error precomputing feed for user ${userId}:`, error);
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
      logger.warn('Failed to load following list:', error);
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
      logger.warn('Failed to load following list:', error);
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
   * Set cache entry in Redis
   */
  private async setCache(
    cacheKey: string,
    userId: string,
    feedType: string,
    posts: any[]
  ): Promise<void> {
    const cachedFeed: CachedFeed = {
      userId,
      feedType,
      posts,
      cachedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.CACHE_TTL_SECONDS * 1000).toISOString()
    };

    await withRedisFallback(
      this.redis,
      async () => {
        await this.redis.setEx(
          cacheKey,
          this.CACHE_TTL_SECONDS,
          JSON.stringify(cachedFeed)
        );
        logger.debug(`Cached feed for ${cacheKey} with TTL ${this.CACHE_TTL_SECONDS}s`);
      },
      undefined,
      'feed cache set'
    );
  }

  /**
   * Get cache key
   */
  private getCacheKey(userId: string, feedType: string): string {
    return `${this.CACHE_KEY_PREFIX}${userId}:${feedType}`;
  }

  /**
   * Get cache statistics
   */
  async getCacheStats(): Promise<{
    size: number;
    hitRate?: number;
    entries: Array<{ userId: string; feedType: string; cachedAt: string; expiresAt: string }>;
  }> {
    return await withRedisFallback(
      this.redis,
      async () => {
        const pattern = `${this.CACHE_KEY_PREFIX}*`;
        const keys = await this.redis.keys(pattern);
        const entries: Array<{ userId: string; feedType: string; cachedAt: string; expiresAt: string }> = [];

        // Get a sample of entries (limit to 100 for performance)
        const sampleKeys = keys.slice(0, 100);
        const results = await Promise.allSettled(
          sampleKeys.map(async (key) => {
            const data = await this.redis.get(key);
            if (data) {
              const cached: CachedFeed = JSON.parse(data);
              return {
                userId: cached.userId,
                feedType: cached.feedType,
                cachedAt: cached.cachedAt,
                expiresAt: cached.expiresAt
              };
            }
            return null;
          })
        );

        results.forEach(result => {
          if (result.status === 'fulfilled' && result.value) {
            entries.push(result.value);
          }
        });

        return {
          size: keys.length,
          entries
        };
      },
      { size: 0, entries: [] },
      'cache stats'
    );
  }
}

export const feedCacheService = new FeedCacheService();

