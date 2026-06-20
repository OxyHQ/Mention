import IORedis, { type RedisOptions } from 'ioredis';
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

/** Default Redis host when no URL is provided. */
const DEFAULT_REDIS_HOST = 'localhost';

/** Default Redis port when no URL is provided. */
const DEFAULT_REDIS_PORT = 6379;

/** Default Redis logical database index. */
const DEFAULT_REDIS_DB = 0;

/** Connection timeout for the initial BullMQ Redis connect (ms). */
const REDIS_CONNECT_TIMEOUT_MS = 15_000;

/** Connection timeout when using a TLS (`rediss://`) URL (ms). */
const REDIS_TLS_CONNECT_TIMEOUT_MS = 20_000;

interface ResolvedRedisConfig {
  redisUrl?: string;
  redisHost: string;
  redisPort: number;
  redisPassword?: string;
  redisDb: number;
}

/**
 * Resolve Redis configuration from the environment. Mirrors the resolution in
 * `src/utils/redis.ts#getRedisConfig` so BullMQ talks to the same Redis the
 * rest of the app uses. Empty/whitespace URLs are treated as unset.
 */
function resolveRedisConfig(): ResolvedRedisConfig {
  const rawUrl = (process.env.REDIS_URL || process.env.REDIS_URI)?.trim();
  return {
    redisUrl: rawUrl && rawUrl.length > 0 ? rawUrl : undefined,
    redisHost: process.env.REDIS_HOST || DEFAULT_REDIS_HOST,
    redisPort: Number.parseInt(process.env.REDIS_PORT || String(DEFAULT_REDIS_PORT), 10),
    redisPassword: process.env.REDIS_PASSWORD,
    redisDb: Number.parseInt(process.env.REDIS_DB || String(DEFAULT_REDIS_DB), 10),
  };
}

/**
 * Whether a usable Redis target is configured. True when an explicit
 * REDIS_URL/REDIS_URI is set, OR when an explicit REDIS_HOST is provided. A bare
 * default `localhost` (no env at all) is NOT considered configured so that local
 * dev without Redis cleanly falls back to the in-process scheduler + Mongo
 * delivery queue instead of crash-looping against a non-existent server.
 */
export function isQueueEnabled(): boolean {
  const rawUrl = (process.env.REDIS_URL || process.env.REDIS_URI)?.trim();
  if (rawUrl && rawUrl.length > 0) return true;
  return Boolean(process.env.REDIS_HOST && process.env.REDIS_HOST.trim().length > 0);
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

  const config = resolveRedisConfig();

  if (config.redisUrl) {
    const isTls = config.redisUrl.startsWith('rediss://');
    connection = new IORedis(config.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      connectTimeout: isTls ? REDIS_TLS_CONNECT_TIMEOUT_MS : REDIS_CONNECT_TIMEOUT_MS,
      lazyConnect: false,
    });
  } else {
    const options: RedisOptions = {
      host: config.redisHost,
      port: config.redisPort,
      db: config.redisDb,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
      lazyConnect: false,
    };
    if (config.redisPassword) {
      options.password = config.redisPassword;
    }
    connection = new IORedis(options);
  }

  connection.on('ready', () => {
    logger.info('BullMQ Redis connection ready');
  });
  connection.on('error', (err: Error) => {
    logger.warn(`BullMQ Redis connection error: ${err.message}`);
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
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`BullMQ Redis connection close failed: ${message}`);
  } finally {
    connection = null;
  }
}
