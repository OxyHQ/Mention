import { Post } from '../models/Post';
import UserBehavior from '../models/UserBehavior';
import { feedRankingService } from './FeedRankingService';
import mongoose from 'mongoose';
import { extractFollowingIds } from '../utils/privacyHelpers';
import { getRedisClient, createRedisPubSub } from '../utils/redis';
import { logger } from '../utils/logger';
import { isRedisConnectionError, ensureRedisConnected, withRedisFallback } from '../utils/redisHelpers';
import { metrics } from '../utils/metrics';

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
  private readonly CACHE_TTL_SECONDS = 15 * 60; // 15 minutes in seconds (L2 Redis cache)
  private readonly L1_CACHE_TTL_SECONDS = 60; // 1 minute for L1 in-memory cache
  private readonly CACHE_KEY_PREFIX = 'feed:cache:';
  private readonly INVALIDATION_CHANNEL = 'feed:invalidate';
  private redis: ReturnType<typeof getRedisClient>;
  private pubSub: { publisher: ReturnType<typeof createRedisPubSub>['publisher']; subscriber: ReturnType<typeof createRedisPubSub>['subscriber'] } | null = null;
  
  // L1 Cache: In-memory cache for ultra-fast access (per-process)
  // Structure: Map<userId:feedType, { data: CachedFeed, expiresAt: number }>
  private l1Cache: Map<string, { data: CachedFeed; expiresAt: number }> = new Map();
  private readonly L1_MAX_SIZE = 1000; // Maximum entries in L1 cache
  private lastInvalidationTime: string = new Date(0).toISOString(); // Track last invalidation timestamp

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

      // Verify both clients are actually ready before proceeding
      const publisherReady = await ensureRedisConnected(publisher);
      const subscriberReady = await ensureRedisConnected(subscriber);
      
      if (!publisherReady || !subscriberReady) {
        // Clients connected but not ready, skip pub/sub setup
        logger.debug('Redis pub/sub clients connected but not ready, skipping setup');
        return;
      }

      // Verify with ping to ensure connection is actually working
      try {
        await Promise.all([
          publisher.ping(),
          subscriber.ping()
        ]);
      } catch (pingError: any) {
        logger.debug('Redis pub/sub ping failed, skipping setup:', pingError.message);
        return;
      }

      this.pubSub = { publisher, subscriber };

      // Subscribe to invalidation channel using pattern subscribe
      // In node-redis v5, pSubscribe uses callback pattern
      try {
        await subscriber.pSubscribe(this.INVALIDATION_CHANNEL, (message: string, channel: string) => {
          try {
            const { userId, feedType } = JSON.parse(message);
            this.handleRemoteInvalidation(userId, feedType);
          } catch (error) {
            logger.error('Error handling cache invalidation message:', error);
          }
        });

        logger.info('Subscribed to cache invalidation channel');
      } catch (subscribeError: any) {
        // Handle subscription errors gracefully
        if (subscribeError.message?.includes('Socket') || subscribeError.message?.includes('Connection')) {
          logger.debug('Redis pub/sub subscription failed (connection issue, will retry):', subscribeError.message);
        } else {
          logger.warn('Redis pub/sub subscription failed:', subscribeError.message);
        }
        // Don't throw - pub/sub is optional, cache invalidation will work locally
      }
      
      // Set up reconnection handling for pub/sub clients
      // Note: Error handlers are set up in createRedisPubSub, but we add specific handlers here
      // to prevent error spam during normal reconnection cycles
      let lastErrorTime = 0;
      const ERROR_THROTTLE_MS = 5000; // Only log same error type once per 5 seconds
      
      subscriber.on('error', (err: Error) => {
        const errorMessage = err.message || '';
        const errorName = err.name || '';
        const now = Date.now();
        
        // Check if this is a connection-related error (expected during reconnection)
        const isConnectionError = 
          errorMessage.includes('Socket closed unexpectedly') || 
          errorMessage.includes('Connection closed') ||
          errorMessage.includes('Connection lost') ||
          errorName.includes('SocketClosed');
        
        if (isConnectionError) {
          // Throttle logging of connection errors (only log once per 5 seconds)
          if (now - lastErrorTime > ERROR_THROTTLE_MS) {
            logger.debug('Redis pub/sub subscriber reconnecting (connection issue)');
            lastErrorTime = now;
          }
          // Don't log as error - this is expected during reconnection
          return;
        }
        
        // Log unexpected errors
        logger.error('Redis pub/sub subscriber error:', err);
      });
      
      publisher.on('error', (err: Error) => {
        const errorMessage = err.message || '';
        const errorName = err.name || '';
        const now = Date.now();
        
        // Check if this is a connection-related error (expected during reconnection)
        const isConnectionError = 
          errorMessage.includes('Socket closed unexpectedly') || 
          errorMessage.includes('Connection closed') ||
          errorMessage.includes('Connection lost') ||
          errorName.includes('SocketClosed');
        
        if (isConnectionError) {
          // Throttle logging of connection errors (only log once per 5 seconds)
          if (now - lastErrorTime > ERROR_THROTTLE_MS) {
            logger.debug('Redis pub/sub publisher reconnecting (connection issue)');
            lastErrorTime = now;
          }
          // Don't log as error - this is expected during reconnection
          return;
        }
        
        // Log unexpected errors
        logger.error('Redis pub/sub publisher error:', err);
      });
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
   * Get cached feed or compute and cache (multi-layer: L1 -> L2 -> compute)
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
    
    // L1 Cache: Check in-memory cache first (fastest)
    const l1Key = `${userId}:${feedType}`;
    const l1Entry = this.l1Cache.get(l1Key);
    if (l1Entry && l1Entry.expiresAt > Date.now()) {
      // Verify cache version matches (for invalidation)
      if (l1Entry.data.cachedAt && this.isCacheVersionValid(l1Entry.data.cachedAt)) {
        logger.debug(`L1 cache hit for ${cacheKey}`);
        metrics.incrementCounter('feed_cache_hits_total', 1, { cache_layer: 'l1', feed_type: feedType });
        return l1Entry.data.posts;
      } else {
        // Cache version mismatch, remove from L1
        this.l1Cache.delete(l1Key);
      }
    }
    
    // L2 Cache: Check Redis cache
    const cacheStartTime = Date.now();
    const cachedData = await withRedisFallback(
      this.redis,
      async () => {
        const data = await this.redis.get(cacheKey);
        if (!data) return null;

        let cached: CachedFeed;
        try {
          cached = JSON.parse(data);
        } catch (parseError) {
          logger.warn(`Corrupted cache data for ${cacheKey}, ignoring`, parseError);
          await this.redis.del(cacheKey);
          return null;
        }
        const expiresAt = new Date(cached.expiresAt);
        // Check if still valid (Redis TTL should handle this, but double-check)
        if (expiresAt > new Date() && this.isCacheVersionValid(cached.cachedAt)) {
          // Promote to L1 cache
          this.setL1Cache(l1Key, cached);
          return cached.posts;
        }
        return null;
      },
      null,
      'feed cache get'
    );
    const cacheDuration = Date.now() - cacheStartTime;
    metrics.recordLatency('feed_cache_lookup_duration_ms', cacheDuration, { cache_layer: 'l2', feed_type: feedType });

    if (cachedData) {
      logger.debug(`L2 cache hit for ${cacheKey}`);
      metrics.incrementCounter('feed_cache_hits_total', 1, { cache_layer: 'l2', feed_type: feedType });
      return cachedData;
    }

    // Cache miss: Compute and cache in both layers
    logger.debug(`Cache miss for ${cacheKey}, computing feed...`);
    metrics.incrementCounter('feed_cache_misses_total', 1, { feed_type: feedType });
    const posts = await computeFn();
    await this.setCache(cacheKey, userId, feedType, posts);

    return posts;
  }
  
  /**
   * Set L1 (in-memory) cache entry
   */
  private setL1Cache(key: string, cached: CachedFeed): void {
    // Evict oldest entries if cache is full (LRU-like behavior)
    if (this.l1Cache.size >= this.L1_MAX_SIZE) {
      // Remove 10% of oldest entries
      const entriesToRemove = Math.floor(this.L1_MAX_SIZE * 0.1);
      const sortedEntries = Array.from(this.l1Cache.entries())
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      
      for (let i = 0; i < entriesToRemove && i < sortedEntries.length; i++) {
        this.l1Cache.delete(sortedEntries[i][0]);
      }
    }
    
    this.l1Cache.set(key, {
      data: cached,
      expiresAt: Date.now() + (this.L1_CACHE_TTL_SECONDS * 1000)
    });
  }
  
  /**
   * Check if cache entry is still valid based on cache version
   */
  private isCacheVersionValid(cachedAt: string): boolean {
    // Cache entry is valid if it was created after the last invalidation
    return new Date(cachedAt).getTime() >= new Date(this.lastInvalidationTime).getTime();
  }

  /**
   * Invalidate cache for user (when user interacts with content)
   * Invalidates both L1 (in-memory) and L2 (Redis) caches
   */
  async invalidateUserCache(userId: string, feedType?: string): Promise<void> {
    // Invalidate L1 cache (in-memory)
    if (feedType) {
      const l1Key = `${userId}:${feedType}`;
      this.l1Cache.delete(l1Key);
    } else {
      // Invalidate all feeds for user in L1 cache
      const pattern = `${userId}:`;
      for (const key of this.l1Cache.keys()) {
        if (key.startsWith(pattern)) {
          this.l1Cache.delete(key);
        }
      }
    }
    
    // Update invalidation timestamp for cache version checking
    this.lastInvalidationTime = new Date().toISOString();
    
    // Invalidate L2 cache (Redis) with graceful fallback
    await withRedisFallback(
      this.redis,
      async () => {
        if (feedType) {
          const cacheKey = this.getCacheKey(userId, feedType);
          await this.redis.del([cacheKey]);
          logger.debug(`Invalidated L2 cache for ${cacheKey}`);
        } else {
          // Invalidate all feeds for user (use pattern matching)
          const pattern = `${this.CACHE_KEY_PREFIX}${userId}:*`;
          const keys = await this.redis.keys(pattern);
          if (keys.length > 0) {
            await this.redis.del(keys);
            logger.debug(`Invalidated ${keys.length} L2 cache entries for user ${userId}`);
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
              JSON.stringify({ userId, feedType, invalidatedAt: this.lastInvalidationTime })
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
   * Set cache entry in both L1 (in-memory) and L2 (Redis) caches
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

    // Set L1 cache (in-memory)
    const l1Key = `${userId}:${feedType}`;
    this.setL1Cache(l1Key, cachedFeed);

    // Set L2 cache (Redis)
    await withRedisFallback(
      this.redis,
      async () => {
        await this.redis.setEx(
          cacheKey,
          this.CACHE_TTL_SECONDS,
          JSON.stringify(cachedFeed)
        );
        logger.debug(`Cached feed in L2 for ${cacheKey} with TTL ${this.CACHE_TTL_SECONDS}s`);
      },
      undefined,
      'feed cache set'
    );
  }
  
  /**
   * Warm cache for active users (called by background jobs)
   */
  async warmCache(userId: string, feedTypes: string[] = ['for_you', 'following', 'explore']): Promise<void> {
    logger.debug(`Warming cache for user ${userId}, feed types: ${feedTypes.join(', ')}`);
    
    // This will trigger cache computation if not already cached
    // The actual computation happens in the feed controller
    // This method is a placeholder for cache warming logic
    for (const feedType of feedTypes) {
      try {
        await this.precomputeFeed(userId, feedType as any, 50);
      } catch (error) {
        logger.warn(`Failed to warm cache for user ${userId}, feed type ${feedType}:`, error);
      }
    }
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
              let cached: CachedFeed;
              try {
                cached = JSON.parse(data);
              } catch {
                logger.warn(`Corrupted cache entry for key ${key}`);
                return null;
              }
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
  /**
   * Evict expired entries from L1 in-memory cache
   * Redis TTL handles L2 expiration automatically
   */
  evictExpiredEntries(): number {
    const now = Date.now();
    let evicted = 0;

    for (const [key, entry] of this.l1Cache.entries()) {
      if (entry.expiresAt <= now || !this.isCacheVersionValid(entry.data.cachedAt)) {
        this.l1Cache.delete(key);
        evicted++;
      }
    }

    if (evicted > 0) {
      logger.debug(`Evicted ${evicted} expired L1 cache entries`);
    }

    return evicted;
  }
}

export const feedCacheService = new FeedCacheService();

