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
 * Returns true if connected and ready, false if unavailable
 * This function verifies the client is actually ready, not just connected
 */
export async function ensureRedisConnected(client: RedisClientType, timeoutMs: number = 2000): Promise<boolean> {
  // If already ready, verify with ping to ensure it's actually working
  if (client.isReady) {
    try {
      await client.ping();
      return true;
    } catch (error) {
      // If ping fails, client is not actually ready
      return false;
    }
  }

  // If socket is already open, wait for it to become ready
  if (client.isOpen) {
    const startTime = Date.now();
    const maxWait = timeoutMs;
    
    // Wait for ready state with timeout
    while (Date.now() - startTime < maxWait) {
      if (client.isReady) {
        // Verify with ping
        try {
          await client.ping();
          return true;
        } catch (error) {
          return false;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    // If still not ready after timeout, return false
    return false;
  }

  // Socket is not open, try to connect
  try {
    await client.connect();
    
    // Wait for ready state after connection
    const startTime = Date.now();
    const maxWait = timeoutMs;
    
    while (Date.now() - startTime < maxWait) {
      if (client.isReady) {
        // Verify with ping
        try {
          await client.ping();
          return true;
        } catch (error) {
          return false;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // If still not ready after timeout, return false
    return false;
  } catch (error: any) {
    // Handle "Socket already opened" error gracefully - this means connection is in progress
    if (error?.message?.includes('Socket already opened') || 
        error?.message?.includes('already open') ||
        error?.message?.includes('already connected')) {
      // Socket is already open/connecting, check if it becomes ready
      const startTime = Date.now();
      const maxWait = timeoutMs;
      
      while (Date.now() - startTime < maxWait) {
        if (client.isReady) {
          try {
            await client.ping();
            return true;
          } catch (pingError) {
            return false;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return false;
    }
    if (isRedisConnectionError(error)) {
      return false; // Redis unavailable, but not an error
    }
    throw error; // Re-throw unexpected errors
  }
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
      } catch (pingError: any) {
        error = `Ping failed: ${pingError.message}`;
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
  } catch (error: any) {
    return {
      connected: false,
      ready: false,
      ping: false,
      error: error.message
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

