import { getRedisClient } from '../utils/redis';
import { withRedisFallback } from '../utils/redisHelpers';

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
   *
   * Atomically increments and sets TTL using a Lua script. This avoids the race
   * condition in non-atomic implementations where a concurrent EXPIRE call could
   * leave the key without a TTL, causing rate limit hits to accumulate forever.
   *
   * The script also defensively re-applies the TTL if the key has somehow lost it
   * (e.g. if a previous version of this code created an unbounded key).
   */
  async increment(key: string): Promise<{ totalHits: number; resetTime: Date | undefined }> {
    const fullKey = `${this.prefix}${key}`;
    const fallback = { totalHits: 1, resetTime: undefined as Date | undefined };
    const ttlSeconds = Math.ceil(this.windowMs / 1000);

    // Atomic INCR + EXPIRE via Lua. Returns [hits, ttlSeconds].
    // - INCR creates the key with value 1 if it doesn't exist.
    // - On first creation (hits === 1) OR if the key has no TTL (-1),
    //   set the expiration. This fixes both the race condition and any
    //   stale unbounded keys from previous buggy code paths.
    const script = `
      local hits = redis.call('INCR', KEYS[1])
      local ttl = redis.call('TTL', KEYS[1])
      if hits == 1 or ttl == -1 then
        redis.call('EXPIRE', KEYS[1], ARGV[1])
        ttl = tonumber(ARGV[1])
      end
      return {hits, ttl}
    `;

    return await withRedisFallback(
      this.redis,
      async () => {
        const result = await this.redis.eval(script, {
          keys: [fullKey],
          arguments: [String(ttlSeconds)],
        }) as [number, number];

        const totalHits = result[0];
        const ttl = result[1];
        const resetTime = ttl > 0 ? new Date(Date.now() + ttl * 1000) : undefined;

        return { totalHits, resetTime };
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

