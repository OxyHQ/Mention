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
  // Get URL and trim whitespace - empty strings should be treated as undefined
  const redisUrl = (process.env.REDIS_URL || process.env.REDIS_URI)?.trim();
  
  return {
    redisUrl: redisUrl && redisUrl.length > 0 ? redisUrl : undefined,
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
        if (retries > 3) {
          hasLoggedRedisUnavailable = true;
          return false;
        }
        return Math.min(retries * 50, 2000);
      },
      connectTimeout: 10000,
      keepAlive: true,
    },
    database: config.redisDb,
    commandsQueueMaxLength: 1000,
    disableOfflineQueue: true,
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
  const config = getRedisConfig();
  
  // If we have an existing client, check if config matches
  // This handles the case where dotenv loads after the first call to getRedisClient()
  if (redisClient) {
    // Check if we need to recreate the client due to config change
    // This can happen if dotenv loads after the first call
    const wasCreatedWithUrl = (redisClient as any)._createdWithUrl;
    const shouldUseUrl = !!config.redisUrl;
    
    // If config changed (URL now available but client was created without URL, or vice versa)
    if (wasCreatedWithUrl !== shouldUseUrl) {
      // Config changed - need to recreate client
      if (isMainClient) {
        logger.warn(`Redis config changed (was ${wasCreatedWithUrl ? 'URL' : 'host/port'}, now ${shouldUseUrl ? 'URL' : 'host/port'}) - recreating client`);
        logger.info('This can happen if dotenv loads after Redis client initialization');
      }
      // Close and reset the old client
      if (redisClient.isOpen) {
        redisClient.quit().catch(() => {}); // Ignore errors when closing
      }
      redisClient = null;
      redisClientPromise = null;
    } else if (redisClient.isReady) {
      // Config matches and client is ready
      return redisClient;
    }
  }

  // If connection is in progress, return existing client
  if (redisClientPromise && redisClient) {
    return redisClient as RedisClientType;
  }

  // Mark this as the main client for logging purposes
  isMainClient = true;

  // Log connection config once
  if (isMainClient && !hasLoggedRedisUnavailable) {
    if (config.redisUrl) {
      const sanitized = config.redisUrl.replace(/:[^:@]+@/, ':****@');
      logger.info(`Connecting to Redis: ${sanitized}`);
    } else {
      logger.debug(`Connecting to Redis: ${config.redisHost}:${config.redisPort}`);
    }
  }

  // CRITICAL: When using URL, we must NOT provide socket.host/port as that overrides the URL
  if (config.redisUrl) {
    // When using URL (especially rediss:// for TLS), let the URL handle TLS automatically
    // IMPORTANT: Do NOT set socket.host or socket.port when using URL - it will override the URL!
    const isTLS = config.redisUrl.startsWith('rediss://');
    const sanitizedUrl = config.redisUrl.replace(/:[^:@]+@/, ':****@');
    
    // Config already logged above
    
    // When using URL, only set socket options that don't conflict (no host/port!)
    const urlOptions: RedisClientOptions = {
      url: config.redisUrl, // This is the key - URL contains all connection info
      commandsQueueMaxLength: 1000,
      disableOfflineQueue: true,
      socket: {
        // Only set reconnect strategy and timeouts - NO host/port!
        reconnectStrategy: (retries: number) => {
          if (retries > 3) {
            hasLoggedRedisUnavailable = true;
            return false;
          }
          return Math.min(retries * 50, 2000);
        },
        connectTimeout: isTLS ? 20000 : 15000, // Longer timeout for TLS connections
        keepAlive: true,
        // CRITICAL: Do NOT set host or port here - the URL handles that!
        // For rediss:// URLs, node-redis will automatically enable TLS
      },
    };
    redisClient = createClient(urlOptions) as RedisClientType;
    // Mark that this client was created with URL
    (redisClient as any)._createdWithUrl = true;
  } else {
    // No URL provided - use host/port configuration
    const options = createRedisOptions();
    redisClient = createClient(options) as RedisClientType;
    // Mark that this client was created without URL
    (redisClient as any)._createdWithUrl = false;
  }

  // Set up event handlers
  if (redisClient) {
    redisClient.on('connect', () => {
      // Silent — we log on 'ready' instead
    });

    redisClient.on('ready', () => {
      logger.info('Redis connected');
    });

    redisClient.on('error', (err: Error) => {
      if (hasLoggedRedisUnavailable) return; // Already logged, stay quiet

      const isConnectionError =
        err.message.includes('ECONNREFUSED') ||
        err.message.includes('ENOTFOUND') ||
        err.message.includes('Socket closed unexpectedly') ||
        err.message.includes('Connection closed');

      if (isConnectionError) {
        if (!hasLoggedRedisUnavailable && isMainClient) {
          logger.warn('Redis not available — running without cache');
          hasLoggedRedisUnavailable = true;
        }
      } else if (err.message.includes('NOAUTH') || err.message.includes('AUTH')) {
        logger.error('Redis authentication failed — check credentials');
        hasLoggedRedisUnavailable = true;
      } else if (err.message.includes('certificate') || err.message.includes('TLS') || err.message.includes('SSL')) {
        logger.error('Redis TLS error:', err.message);
        hasLoggedRedisUnavailable = true;
      } else if (isMainClient) {
        logger.error('Redis error:', err.message);
      }
    });

    redisClient.on('end', () => {
      redisClient = null;
      redisClientPromise = null;
    });

    redisClient.on('reconnecting', () => {
      // Silent
    });

    // Connect the client (non-blocking - app can start without Redis)
    redisClientPromise = redisClient.connect().then(async () => {
      // Wait for client to be ready
      for (let i = 0; i < 20; i++) {
        if (redisClient!.isReady) {
          try {
            await redisClient!.ping();
            hasLoggedRedisUnavailable = false;
            return redisClient!;
          } catch {
            break;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return redisClient!;
    }).catch(() => {
      // Connection failed — error handler already logged it
      redisClientPromise = null;
      return redisClient!;
    });
  }

  return redisClient!;
}

/**
 * Check if Redis is connected and healthy
 * This performs an actual ping to verify the connection is working
 */
export async function isRedisConnected(): Promise<boolean> {
  try {
    const client = getRedisClient();
    if (!client) {
      return false;
    }
    
    // Check if client is ready
    if (!client.isReady) {
      return false;
    }
    
    // Perform actual ping to verify connection is working
    await client.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify Redis connection with detailed diagnostics
 * Returns connection status and diagnostic information
 */
export async function verifyRedisConnection(): Promise<{
  connected: boolean;
  ready: boolean;
  ping: boolean;
  details: {
    host?: string;
    port?: number;
    url?: string;
    error?: string;
  };
}> {
  const config = getRedisConfig();
  const details: any = {};
  
  if (config.redisUrl) {
    details.url = config.redisUrl.replace(/:[^:@]+@/, ':****@');
  } else {
    details.host = config.redisHost;
    details.port = config.redisPort;
  }
  
  try {
    const client = getRedisClient();
    if (!client) {
      return {
        connected: false,
        ready: false,
        ping: false,
        details: { ...details, error: 'Client not initialized' }
      };
    }
    
    const ready = client.isReady;
    let ping = false;
    
    if (ready) {
      try {
        await client.ping();
        ping = true;
      } catch (pingError: any) {
        details.error = `Ping failed: ${pingError.message}`;
      }
    } else {
      details.error = 'Client not ready';
    }
    
    return {
      connected: client.isOpen,
      ready,
      ping,
      details
    };
  } catch (error: any) {
    return {
      connected: false,
      ready: false,
      ping: false,
      details: { ...details, error: error.message }
    };
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
  
  const reconnectStrategy = (retries: number) => {
    if (retries > 3) return false;
    return Math.min(retries * 50, 2000);
  };

  const createPubSubClient = (): RedisClientType => {
    let client: RedisClientType;
    
    if (config.redisUrl) {
      // When using URL (especially rediss:// for TLS), let URL handle TLS automatically
      const isTLS = config.redisUrl.startsWith('rediss://');
      client = createClient({
        url: config.redisUrl,
        disableOfflineQueue: true,
        socket: {
          reconnectStrategy,
          connectTimeout: isTLS ? 20000 : 15000, // Longer timeout for TLS connections
          keepAlive: true,
          // Don't override TLS settings - let the URL handle it
          // For rediss:// URLs, node-redis will automatically enable TLS
        },
      }) as RedisClientType;
    } else {
      client = createClient({
        ...createRedisOptions(),
        disableOfflineQueue: true,
        socket: {
          ...createRedisOptions().socket,
          reconnectStrategy,
        },
      }) as RedisClientType;
    }
    
    // Suppress all connection errors — main client already handles logging
    client.on('error', () => {});
    client.on('reconnecting', () => {});
    client.on('end', () => {});
    
    return client;
  };

  return {
    publisher: createPubSubClient(),
    subscriber: createPubSubClient(),
  };
}

// Export the client for direct use if needed
export { redisClient };
