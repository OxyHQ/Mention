import { getRedisClient } from '../utils/redis';
import { logger } from '../utils/logger';
import { ensureRedisConnected, withRedisFallback } from '../utils/redisHelpers';

/**
 * Custom Redis store for express-rate-limit
 * Implements the Store interface from express-rate-limit
 */
export class RedisStore {
  public redis: ReturnType<typeof getRedisClient>;
  public prefix: string;
  private windowMs: number;

  constructor(options: { prefix?: string; windowMs?: number } = {}) {
    this.redis = getRedisClient();
    this.prefix = options.prefix || 'rate-limit:';
    this.windowMs = options.windowMs || 15 * 60 * 1000; // Default 15 minutes
  }

  /**
   * Initialize the store with windowMs from rate limiter
   */
  init(options: { windowMs: number }): void {
    this.windowMs = options.windowMs;
  }

  /**
   * Get the value for a key
   * Returns ClientRateLimitInfo for express-rate-limit v7+
   */
  async get(key: string): Promise<{ totalHits: number; resetTime: Date | undefined } | undefined> {
    const fullKey = `${this.prefix}${key}`;
    
    return await withRedisFallback(
      this.redis,
      async () => {
        const value = await this.redis.get(fullKey);
        if (!value) {
          return undefined;
        }
        
        const totalHits = parseInt(value, 10);
        const ttl = await this.redis.ttl(fullKey);
        const resetTime = ttl > 0 ? new Date(Date.now() + ttl * 1000) : undefined;
        
        return { totalHits, resetTime };
      },
      undefined,
      'rate limit get'
    );
  }

  /**
   * Set a key with expiration
   */
  async set(key: string, value: number, ttl: number): Promise<void> {
    await withRedisFallback(
      this.redis,
      async () => {
        await this.redis.setEx(`${this.prefix}${key}`, Math.ceil(ttl / 1000), value.toString());
      },
      undefined,
      'rate limit set'
    );
  }

  /**
   * Increment a key's value
   * This is the main method used by express-rate-limit
   * Sets TTL on first increment if key doesn't exist
   */
  async increment(key: string): Promise<{ totalHits: number; resetTime: Date | undefined }> {
    const fullKey = `${this.prefix}${key}`;
    const fallback = { totalHits: 1, resetTime: undefined as Date | undefined };
    
    return await withRedisFallback(
      this.redis,
      async () => {
        // Check if key exists
        const exists = await this.redis.exists(fullKey);
        
        // Increment the key
        const value = await this.redis.incr(fullKey);
        
        // If key didn't exist before, set TTL now
        if (exists === 0) {
          const ttlSeconds = Math.ceil(this.windowMs / 1000);
          await this.redis.expire(fullKey, ttlSeconds);
        }
        
        // Get current TTL to determine reset time
        const ttl = await this.redis.ttl(fullKey);
        const resetTime = ttl > 0 ? new Date(Date.now() + ttl * 1000) : undefined;

        return { totalHits: value, resetTime };
      },
      fallback,
      'rate limit increment'
    );
  }

  /**
   * Decrement a key's value (optional method)
   */
  async decrement(key: string): Promise<void> {
    await withRedisFallback(
      this.redis,
      async () => {
        await this.redis.decr(`${this.prefix}${key}`);
      },
      undefined,
      'rate limit decrement'
    );
  }

  /**
   * Delete a key
   */
  async delete(key: string): Promise<void> {
    await withRedisFallback(
      this.redis,
      async () => {
        await this.redis.del([`${this.prefix}${key}`]);
      },
      undefined,
      'rate limit delete'
    );
  }

  /**
   * Reset a key (delete it)
   */
  async resetKey(key: string): Promise<void> {
    await this.delete(key);
  }

  /**
   * Shutdown the store
   */
  async shutdown(): Promise<void> {
    // Redis client is managed globally, no need to close here
  }
}

