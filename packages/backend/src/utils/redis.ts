import { createClient, RedisClientType, RedisClientOptions } from 'redis';
import { logger } from './logger';

/**
 * Shared Redis configuration options
 */
function getRedisConfig(): {
  redisUrl?: string;
  redisHost: string;
  redisPort: number;
  redisPassword?: string;
  redisDb: number;
} {
  return {
    redisUrl: process.env.REDIS_URL || process.env.REDIS_URI,
    redisHost: process.env.REDIS_HOST || 'localhost',
    redisPort: parseInt(process.env.REDIS_PORT || '6379'),
    redisPassword: process.env.REDIS_PASSWORD,
    redisDb: parseInt(process.env.REDIS_DB || '0'),
  };
}

/**
 * Create base Redis client options
 */
function createRedisOptions(): RedisClientOptions {
  const config = getRedisConfig();
  
  return {
    socket: {
      host: config.redisHost,
      port: config.redisPort,
      reconnectStrategy: (retries: number) => {
        // Stop retrying after 10 attempts, but don't throw error
        // Return false to stop reconnecting gracefully
        if (retries > 10) {
          if (!hasLoggedRedisUnavailable && isMainClient) {
            logger.warn('Redis connection unavailable after 10 retries - app will continue without Redis');
            hasLoggedRedisUnavailable = true;
          }
          return false; // Stop reconnecting, but don't crash
        }
        const delay = Math.min(retries * 50, 2000);
        // Only log retry attempts from main client to reduce spam
        if (retries <= 3 && isMainClient && !hasLoggedRedisUnavailable) {
          logger.debug(`Redis connection retry attempt ${retries}, waiting ${delay}ms`);
        }
        return delay;
      },
      connectTimeout: 10000,
      keepAlive: 30000,
    },
    database: config.redisDb,
    commandsQueueMaxLength: 1000,
    enableOfflineQueue: false,
    enableAutoPipelining: true,
    ...(config.redisPassword && { password: config.redisPassword }),
  };
}

let redisClient: RedisClientType | null = null;
let redisClientPromise: Promise<RedisClientType> | null = null;
let hasLoggedRedisUnavailable = false; // Track if we've already logged Redis unavailability
let isMainClient = true; // Track if this is the main client (for logging)

/**
 * Get or create Redis client singleton
 */
export function getRedisClient(): RedisClientType {
  if (redisClient && redisClient.isReady) {
    return redisClient;
  }

  if (redisClientPromise) {
    // Return existing client if connection is in progress
    return redisClient as RedisClientType;
  }

  // Mark this as the main client for logging purposes
  isMainClient = true;
  
  const config = getRedisConfig();
  const options = createRedisOptions();

  if (config.redisUrl) {
    redisClient = createClient({ url: config.redisUrl, ...options });
  } else {
    redisClient = createClient(options);
  }

  // Set up event handlers
  redisClient.on('connect', () => {
    logger.info('Redis client connecting...');
  });

  redisClient.on('ready', () => {
    logger.info('Redis client ready');
  });

  redisClient.on('error', (err: Error) => {
    // Only log connection errors once from main client to reduce spam
    // The app can continue without Redis (graceful degradation)
    if (err.message.includes('ECONNREFUSED') || err.message.includes('ENOTFOUND')) {
      if (!hasLoggedRedisUnavailable && isMainClient) {
        logger.warn('Redis connection unavailable - app will continue without caching');
        hasLoggedRedisUnavailable = true;
      }
    } else {
      logger.error('Redis client error:', err);
    }
  });

  redisClient.on('end', () => {
    logger.warn('Redis client connection ended');
    redisClient = null;
    redisClientPromise = null;
  });

  redisClient.on('reconnecting', () => {
    // Don't log reconnecting - it's too noisy when Redis is unavailable
    // The reconnect strategy will handle logging
  });

  // Connect the client (non-blocking - app can start without Redis)
  redisClientPromise = redisClient.connect().then(() => {
    hasLoggedRedisUnavailable = false; // Reset flag on successful connection
    isMainClient = true; // Reset flag
    return redisClient!;
  }).catch((error: any) => {
    // Don't crash the app if Redis is unavailable
    // The app will gracefully degrade without Redis
    // Error logging is handled by the error event handler and reconnect strategy
    // Keep the client reference but mark promise as failed
    // This allows the app to continue and Redis operations will gracefully degrade
    redisClientPromise = null;
    // Don't throw - allow app to start without Redis
    return redisClient!;
  });

  return redisClient;
}

/**
 * Check if Redis is connected and healthy
 */
export async function isRedisConnected(): Promise<boolean> {
  try {
    const client = getRedisClient();
    if (!client.isReady) {
      return false;
    }
    await client.ping();
    return true;
  } catch (error) {
    logger.error('Redis health check failed:', error);
    return false;
  }
}

/**
 * Get Redis connection statistics
 */
export function getRedisStats() {
  const client = redisClient;
  if (!client) {
    return {
      connected: false,
      status: 'not_initialized',
    };
  }

  return {
    connected: client.isReady,
    status: client.isReady ? 'ready' : client.isOpen ? 'connecting' : 'disconnected',
  };
}

/**
 * Gracefully close Redis connection
 */
export async function closeRedisConnection(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    redisClientPromise = null;
    logger.info('Redis connection closed');
  }
}

/**
 * Create a Redis client for pub/sub (separate connection)
 * Note: These clients need to be connected before use
 */
export function createRedisPubSub(): { publisher: RedisClientType; subscriber: RedisClientType } {
  const config = getRedisConfig();
  
  // Create options for pub/sub clients with silent reconnect strategy
  const baseOptions: RedisClientOptions = {
    ...createRedisOptions(),
    // Pub/sub clients don't need command queuing
    enableOfflineQueue: false,
    socket: {
      ...createRedisOptions().socket,
      // Silent reconnect strategy for pub/sub clients (main client already logs)
      reconnectStrategy: (retries: number) => {
        if (retries > 10) {
          return false; // Stop reconnecting silently
        }
        return Math.min(retries * 50, 2000);
      },
    },
  };

  const createPubSubClient = (): RedisClientType => {
    const client = config.redisUrl 
      ? createClient({ url: config.redisUrl, ...baseOptions })
      : createClient(baseOptions);
    
    // Set up error handlers - don't log connection errors (already logged by main client)
    client.on('error', (err: Error) => {
      // Only log non-connection errors for pub/sub
      if (!err.message.includes('ECONNREFUSED') && !err.message.includes('ENOTFOUND')) {
        logger.error('Redis pub/sub error:', err);
      }
    });
    
    return client;
  };

  return {
    publisher: createPubSubClient(),
    subscriber: createPubSubClient(),
  };
}

// Export the client for direct use if needed
export { redisClient };
