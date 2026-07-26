import { RedisClientType } from 'redis';
import { logger } from './logger';

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
 * Return whether the shared Redis client is ready for an operation.
 *
 * Request hot paths must not PING, connect, or wait for reconnect here: doing so
 * adds a network round-trip (or a two-second stall during an outage) before
 * every cache/rate-limit command. The Redis singleton owns its connection
 * lifecycle. A readiness race is handled by {@link withRedisFallback}, which
 * catches connection errors from the actual operation.
 *
 * `timeoutMs` remains in the signature for backwards compatibility with callers
 * that used to configure the old wait loop.
 */
export async function ensureRedisConnected(
  client: RedisClientType,
  _timeoutMs: number = 2000,
): Promise<boolean> {
  return client.isReady;
}

/**
 * Verify Redis connection with detailed diagnostics
 * Returns diagnostic information about the connection state
 */
export async function verifyRedisConnectionWithDiagnostics(client: RedisClientType): Promise<{
  connected: boolean;
  ready: boolean;
  ping: boolean;
  error?: string;
}> {
  try {
    const connected = client.isOpen;
    const ready = client.isReady;
    let ping = false;
    let error: string | undefined;

    if (ready) {
      try {
        await Promise.race([
          client.ping(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Ping timeout')), 2000)
          )
        ]);
        ping = true;
      } catch (pingError: unknown) {
        error = `Ping failed: ${errorFields(pingError).message ?? 'unknown error'}`;
      }
    } else if (connected) {
      error = 'Client connected but not ready';
    } else {
      error = 'Client not connected';
    }

    return {
      connected,
      ready,
      ping,
      error
    };
  } catch (error: unknown) {
    return {
      connected: false,
      ready: false,
      ping: false,
      error: errorFields(error).message ?? 'unknown error'
    };
  }
}

/**
 * Execute a Redis operation with automatic connection handling and graceful degradation
 * Returns the result or a fallback value if Redis is unavailable
 */
export async function withRedisFallback<T>(
  client: RedisClientType,
  operation: () => Promise<T>,
  fallback: T,
  operationName?: string
): Promise<T> {
  try {
    const connected = await ensureRedisConnected(client);
    if (!connected) {
      return fallback;
    }
    return await operation();
  } catch (error: unknown) {
    if (isRedisConnectionError(error)) {
      if (operationName) {
        logger.debug(`Redis unavailable for ${operationName}, using fallback`);
      }
      return fallback;
    }
    // Re-throw unexpected errors
    throw error;
  }
}
