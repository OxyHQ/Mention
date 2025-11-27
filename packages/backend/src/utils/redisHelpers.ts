import { RedisClientType } from 'redis';
import { logger } from './logger';

/**
 * Check if an error is a Redis connection error
 */
export function isRedisConnectionError(error: any): boolean {
  return error?.code === 'ECONNREFUSED' || error?.code === 'ENOTFOUND' || 
         error?.message?.includes('ECONNREFUSED') || error?.message?.includes('ENOTFOUND');
}

/**
 * Ensure Redis client is connected, with graceful error handling
 * Returns true if connected, false if unavailable
 */
export async function ensureRedisConnected(client: RedisClientType): Promise<boolean> {
  if (client.isReady) {
    return true;
  }

  try {
    await client.connect();
    return true;
  } catch (error: any) {
    if (isRedisConnectionError(error)) {
      return false; // Redis unavailable, but not an error
    }
    throw error; // Re-throw unexpected errors
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
  } catch (error: any) {
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

