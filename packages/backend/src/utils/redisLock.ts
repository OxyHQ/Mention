import { randomUUID } from 'node:crypto';
import { getRedisClient } from './redis';
import { logger } from './logger';

/**
 * A short-lived, owner-fenced Redis mutex — `SET key token NX PX ttl` to take it,
 * an atomic compare-and-delete to give it back.
 *
 * This is for work that is EXPENSIVE rather than for work that must be correct:
 * the caller still has to be safe when two holders overlap, because a lock with a
 * TTL cannot promise mutual exclusion (a holder paused past its TTL loses the key
 * while still running). What it buys is that the common case — two backend tasks
 * asked the same question within a second of each other — pays once.
 *
 * FAIL-OPEN: an unavailable Redis answers `unavailable` rather than throwing or
 * blocking, so the caller degrades to doing the work unguarded. Every command is
 * time-boxed for the same reason: a Redis that accepts the connection but never
 * answers must not hold a request open.
 */

/** The subset of the node-redis client this lock uses (a fake implements it in tests). */
export interface RedisLockClient {
  readonly isReady: boolean;
  set(
    key: string,
    value: string,
    options: { condition: 'NX'; expiration: { type: 'PX'; value: number } },
  ): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export type LockAttempt =
  | { status: 'acquired'; release: () => Promise<void> }
  | { status: 'held' }
  | { status: 'unavailable' };

export interface DistributedLock {
  tryAcquire(key: string, ttlMs: number): Promise<LockAttempt>;
}

/** Delete the key only while it still holds OUR token — never another holder's lock. */
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

const REDIS_COMMAND_TIMEOUT_MS = 1_000;

function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Redis lock command timed out')), REDIS_COMMAND_TIMEOUT_MS);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

export function createRedisLock(
  getClient: () => RedisLockClient = () => getRedisClient() as unknown as RedisLockClient,
): DistributedLock {
  return {
    async tryAcquire(key: string, ttlMs: number): Promise<LockAttempt> {
      let client: RedisLockClient;
      try {
        client = getClient();
        if (!client.isReady) return { status: 'unavailable' };
      } catch (error) {
        logger.warn('[redisLock] Redis client unavailable', error);
        return { status: 'unavailable' };
      }

      const token = randomUUID();
      try {
        const result = await withTimeout(client.set(key, token, {
          condition: 'NX',
          expiration: { type: 'PX', value: ttlMs },
        }));
        if (result !== 'OK') return { status: 'held' };
      } catch (error) {
        logger.warn('[redisLock] Failed to acquire lock', { key, error });
        return { status: 'unavailable' };
      }

      return {
        status: 'acquired',
        release: async () => {
          try {
            await withTimeout(client.eval(RELEASE_SCRIPT, { keys: [key], arguments: [token] }));
          } catch (error) {
            // The TTL frees it; a failed release only delays the next holder.
            logger.warn('[redisLock] Failed to release lock', { key, error });
          }
        },
      };
    },
  };
}
