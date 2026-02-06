import { getRedisClient } from '../utils/redis';
import { logger } from '../utils/logger';
import { withRedisFallback, ensureRedisConnected } from '../utils/redisHelpers';

/**
 * FeedSeenPostsService - Tracks seen post IDs per user session in Redis
 * Industry-standard approach used by Twitter/X, Instagram, Facebook
 * 
 * Strategy:
 * - Store seen post IDs in Redis SET for O(1) lookups
 * - Session-based TTL (30 minutes)
 * - Automatic size limiting (last 1000 posts)
 * - In-memory fallback if Redis unavailable (per-process, suitable for dev/single-instance)
 */
export class FeedSeenPostsService {
  private readonly TTL_SECONDS = 30 * 60; // 30 minutes session TTL
  private readonly TTL_MS = this.TTL_SECONDS * 1000;
  private readonly MAX_SEEN_POSTS = 1000; // Limit to last 1000 seen posts
  private readonly KEY_PREFIX = 'user:';
  private readonly KEY_SUFFIX = ':feed:for_you:seen';
  private redis: ReturnType<typeof getRedisClient>;
  
  // In-memory fallback when Redis is unavailable
  // Structure: Map<userId, { posts: Set<postId>, lastUpdated: timestamp }>
  private memoryCache: Map<string, { posts: Set<string>; lastUpdated: number }> = new Map();
  private memoryCacheCleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.redis = getRedisClient();
    // Start periodic cleanup of expired in-memory entries
    this.startMemoryCacheCleanup();
  }

  /**
   * Start periodic cleanup of expired in-memory cache entries
   */
  private startMemoryCacheCleanup(): void {
    // Clean up every 5 minutes
    this.memoryCacheCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [userId, data] of this.memoryCache.entries()) {
        if (now - data.lastUpdated > this.TTL_MS) {
          this.memoryCache.delete(userId);
        }
      }
    }, 5 * 60 * 1000) as unknown as ReturnType<typeof setInterval>;
  }

  /**
   * Get or create in-memory cache entry for user
   */
  private getMemoryEntry(userId: string): Set<string> {
    let entry = this.memoryCache.get(userId);
    if (!entry || Date.now() - entry.lastUpdated > this.TTL_MS) {
      // Entry doesn't exist or expired
      entry = { posts: new Set(), lastUpdated: Date.now() };
      this.memoryCache.set(userId, entry);
    }
    return entry.posts;
  }

  /**
   * Update in-memory cache entry timestamp
   */
  private touchMemoryEntry(userId: string): void {
    const entry = this.memoryCache.get(userId);
    if (entry) {
      entry.lastUpdated = Date.now();
    }
  }

  /**
   * Get Redis key for user's seen posts
   */
  private getKey(userId: string): string {
    return `${this.KEY_PREFIX}${userId}${this.KEY_SUFFIX}`;
  }

  /**
   * Get all seen post IDs for a user
   * Uses Redis if available, falls back to in-memory cache
   */
  async getSeenPostIds(userId: string): Promise<string[]> {
    return withRedisFallback(
      this.redis,
      async () => {
        const connected = await ensureRedisConnected(this.redis);
        if (!connected) {
          // Fallback to in-memory cache
          const memoryPosts = this.getMemoryEntry(userId);
          return Array.from(memoryPosts);
        }

        const key = this.getKey(userId);
        const members = await this.redis.zRange(key, 0, -1);
        return members || [];
      },
      // Fallback to in-memory cache if Redis throws
      Array.from(this.getMemoryEntry(userId)),
      'getSeenPostIds'
    );
  }

  /**
   * Check if a post ID has been seen
   * Returns false if Redis unavailable (graceful degradation)
   */
  async isPostSeen(userId: string, postId: string): Promise<boolean> {
    return withRedisFallback(
      this.redis,
      async () => {
        const connected = await ensureRedisConnected(this.redis);
        if (!connected) {
          return false; // If Redis unavailable, assume not seen (per-request fallback)
        }

        const key = this.getKey(userId);
        const score = await this.redis.zScore(key, postId);
        return score !== null;
      },
      false, // Fallback: assume not seen if Redis unavailable
      'isPostSeen'
    );
  }

  /**
   * Mark multiple post IDs as seen (batch operation)
   * Automatically trims to MAX_SEEN_POSTS if needed
   * Uses Redis if available, falls back to in-memory cache
   */
  async markPostsAsSeen(userId: string, postIds: string[]): Promise<void> {
    if (!postIds || postIds.length === 0) {
      return;
    }

    // Always update in-memory cache (used as fallback and sync point)
    const memoryPosts = this.getMemoryEntry(userId);
    for (const postId of postIds) {
      memoryPosts.add(postId);
    }
    // Trim in-memory cache if needed
    if (memoryPosts.size > this.MAX_SEEN_POSTS) {
      const excess = memoryPosts.size - this.MAX_SEEN_POSTS;
      const iterator = memoryPosts.values();
      for (let i = 0; i < excess; i++) {
        const next = iterator.next();
        if (!next.done) {
          memoryPosts.delete(next.value);
        }
      }
    }
    this.touchMemoryEntry(userId);

    // Try to persist to Redis as well
    await withRedisFallback(
      this.redis,
      async () => {
        const connected = await ensureRedisConnected(this.redis);
        if (!connected) {
          // Redis unavailable - in-memory cache already updated above
          return;
        }

        const key = this.getKey(userId);

        // Batch add all post IDs to Sorted Set with timestamp scores (LRU ordering)
        if (postIds.length > 0) {
          const now = Date.now();
          const members = postIds.map(postId => ({
            score: now,
            value: postId
          }));
          await this.redis.zAdd(key, members);
        }

        // Set/refresh TTL
        await this.redis.expire(key, this.TTL_SECONDS);

        // Trim to MAX_SEEN_POSTS if needed (evict oldest by lowest score)
        const currentSize = await this.redis.zCard(key);
        if (currentSize > this.MAX_SEEN_POSTS) {
          const excess = currentSize - this.MAX_SEEN_POSTS;
          // Remove the oldest entries (lowest scores = oldest timestamps)
          await this.redis.zRemRangeByRank(key, 0, excess - 1);
        }
      },
      undefined, // Fallback: in-memory cache already updated
      'markPostsAsSeen'
    );
  }

  /**
   * Clear seen posts for a user (useful for testing or manual refresh)
   */
  async clearSeenPosts(userId: string): Promise<void> {
    // Clear in-memory cache
    this.memoryCache.delete(userId);

    // Try to clear Redis as well
    await withRedisFallback(
      this.redis,
      async () => {
        const connected = await ensureRedisConnected(this.redis);
        if (!connected) {
          return;
        }

        const key = this.getKey(userId);
        await this.redis.del(key);
      },
      undefined,
      'clearSeenPosts'
    );
  }

  /**
   * Get count of seen posts for a user (for monitoring/debugging)
   */
  async getSeenPostsCount(userId: string): Promise<number> {
    return withRedisFallback(
      this.redis,
      async () => {
        const connected = await ensureRedisConnected(this.redis);
        if (!connected) {
          // Fallback to in-memory cache
          const memoryPosts = this.getMemoryEntry(userId);
          return memoryPosts.size;
        }

        const key = this.getKey(userId);
        const count = await this.redis.zCard(key);
        return count || 0;
      },
      this.getMemoryEntry(userId).size,
      'getSeenPostsCount'
    );
  }
}

export const feedSeenPostsService = new FeedSeenPostsService();

