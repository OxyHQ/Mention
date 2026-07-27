import { RedisClientType } from 'redis';
import { logger } from './logger';
import { reportRedisConnectionFailure } from './redis';

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
    (code && REDIS_CONNECTION_ERROR_CODES.has(code))
    || (name && REDIS_CONNECTION_ERROR_NAMES.has(name))
    || REDIS_CONNECTION_ERROR_MESSAGES.some((fragment) => message?.includes(fragment)),
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
  operationName?: string
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
