import { logger } from './logger';
import { reportRedisConnectionFailure, type RedisClientType } from './redis';

/** Read common fields of an unknown error without assuming its shape. */
function errorFields(error: unknown): { code?: string; message?: string; name?: string } {
  if (!error || typeof error !== 'object') return {};
  const record = error as Record<string, unknown>;
  return {
    code: typeof record.code === 'string' ? record.code : undefined,
    message: typeof record.message === 'string' ? record.message : undefined,
    name: typeof record.name === 'string' ? record.name : undefined,
  };
}

const REDIS_CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
]);

const REDIS_CONNECTION_ERROR_NAMES: ReadonlySet<string> = new Set([
  'ClientClosedError',
  'ClientOfflineError',
  'CommandTimeoutError',
  'ConnectionTimeoutError',
  'DisconnectsClientError',
  'SocketClosedUnexpectedlyError',
  'SocketTimeoutError',
]);

const REDIS_CONNECTION_ERROR_MESSAGES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'Socket closed unexpectedly',
  'Socket timeout',
  'Connection closed',
  'Connection timeout',
  'The client is closed',
  'The client is not open',
] as const;

/**
 * Check if an error is a Redis connection error
 */
export function isRedisConnectionError(error: unknown): boolean {
  const { code, message, name } = errorFields(error);
  return Boolean(
    (code && REDIS_CONNECTION_ERROR_CODES.has(code)) ||
      (name && REDIS_CONNECTION_ERROR_NAMES.has(name)) ||
      REDIS_CONNECTION_ERROR_MESSAGES.some((fragment) => message?.includes(fragment)),
  );
}

/**
 * Execute a Redis operation only when the shared client is already ready.
 * Connection and recovery belong to the singleton supervisor; hot paths never
 * PING, call connect, or wait for a cooldown.
 */
export async function withRedisFallback<T>(
  client: RedisClientType,
  operation: () => Promise<T>,
  fallback: T,
  operationName?: string,
): Promise<T> {
  if (!client.isReady) {
    return fallback;
  }

  try {
    return await operation();
  } catch (error: unknown) {
    if (isRedisConnectionError(error)) {
      reportRedisConnectionFailure(client, error);
      if (operationName) {
        logger.debug(`Redis unavailable for ${operationName}, using fallback`);
      }
      return fallback;
    }
    // Re-throw unexpected errors
    throw error;
  }
}

/**
 * The most commands one write batch puts on the client's queue at once.
 *
 * The shared command client caps its queue at 1000 (`commandsQueueMaxLength`
 * in `utils/redis.ts`); a batch near that size crowds out every request's
 * commands on the same task. 200 keeps a batch a small share of it.
 */
export const REDIS_WRITE_BATCH_COMMANDS = 200;

/**
 * Write independent `SETEX`s in bounded, NON-transactional pipelines.
 *
 * Never a `MULTI` for writes that need no atomicity. node-redis (6.2.1 and
 * 6.3.0) enqueues `MULTI`, the commands, then `EXEC`; when the queue fills
 * part-way it rejects the rest but has already sent `MULTI`, so the server
 * keeps the connection inside a transaction: from then on every command on
 * that task's shared client answers `QUEUED` and none ever runs, until the
 * process restarts. A cache write of ~1000 keys did exactly that in production
 * ("The queue is full", 2026-10-12). A pipeline that overflows only fails
 * itself; the connection stays usable.
 */
export async function setExInBatches(
  client: Pick<RedisClientType, 'multi'>,
  entries: ReadonlyArray<readonly [string, string]>,
  ttlSeconds: number,
): Promise<void> {
  for (let start = 0; start < entries.length; start += REDIS_WRITE_BATCH_COMMANDS) {
    const batch = client.multi();
    for (const [key, value] of entries.slice(start, start + REDIS_WRITE_BATCH_COMMANDS)) {
      batch.setEx(key, ttlSeconds, value);
    }
    await batch.execAsPipeline();
  }
}
