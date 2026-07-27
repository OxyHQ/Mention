import IORedis, { type RedisOptions } from 'ioredis';
import {
  getRedisConnectionConfig,
  isRedisRuntimeConfigured,
} from '../config';
import { logger } from '../utils/logger';

/**
 * Dedicated ioredis connection for BullMQ.
 *
 * BullMQ MUST own its own Redis connection and that connection MUST set
 * `maxRetriesPerRequest: null` (BullMQ uses blocking commands like BRPOPLPUSH
 * whose lifetime exceeds a single request budget). We therefore do NOT reuse
 * the app's node-redis client in `src/utils/redis.ts`; we build a separate
 * ioredis connection here using the SAME env resolution as `getRedisConfig()`
 * (REDIS_URL/REDIS_URI first, then host/port/password/db).
 *
 * The connection is created lazily on first access so that merely importing the
 * queue module is side-effect free (important for unit tests that run without a
 * Redis server). When Redis is not configured, {@link isQueueEnabled} returns
 * false and the connection is never created.
 */

/** Connection timeout for the initial BullMQ Redis connect (ms). */
const REDIS_CONNECT_TIMEOUT_MS = 15_000;

/** Connection timeout when using a TLS (`rediss://`) URL (ms). */
const REDIS_TLS_CONNECT_TIMEOUT_MS = 20_000;

/**
 * Whether a usable Redis target is configured. True when an explicit
 * REDIS_URL/REDIS_URI is set, OR when an explicit REDIS_HOST is provided. A bare
 * default `localhost` (no env at all) is NOT considered configured so that local
 * dev without Redis cleanly falls back to the in-process scheduler + Mongo
 * delivery queue instead of crash-looping against a non-existent server.
 */
export function isQueueEnabled(): boolean {
  return isRedisRuntimeConfigured();
}

let connection: IORedis | null = null;

/**
 * Get (lazily creating) the shared ioredis connection used by every BullMQ
 * Queue/Worker in this process. Callers MUST guard with {@link isQueueEnabled}
 * first; calling this when Redis is not configured still returns a connection
 * bound to the localhost default, which is only appropriate for an environment
 * that actually runs Redis there.
 */
export function getQueueConnection(): IORedis {
  if (connection) return connection;

  const redisConfig = getRedisConnectionConfig();

  if (redisConfig.url) {
    const isTls = redisConfig.url.startsWith('rediss://');
    connection = new IORedis(redisConfig.url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      connectTimeout: isTls ? REDIS_TLS_CONNECT_TIMEOUT_MS : REDIS_CONNECT_TIMEOUT_MS,
      lazyConnect: false,
    });
  } else {
    const options: RedisOptions = {
      host: redisConfig.host,
      port: redisConfig.port,
      db: redisConfig.db,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
      lazyConnect: false,
    };
    if (redisConfig.password) {
      options.password = redisConfig.password;
    }
    connection = new IORedis(options);
  }

  connection.on('ready', () => {
    logger.info('BullMQ Redis connection ready');
  });
  connection.on('error', (err: Error) => {
    logger.warn('BullMQ Redis connection error', { error: err });
  });

  return connection;
}

/**
 * Close the shared ioredis connection (graceful shutdown). Safe to call when no
 * connection was ever created.
 */
export async function closeQueueConnection(): Promise<void> {
  if (!connection) return;
  try {
    await connection.quit();
  } catch (err) {
    logger.warn('BullMQ Redis connection close failed', { error: err });
  } finally {
    connection = null;
  }
}
