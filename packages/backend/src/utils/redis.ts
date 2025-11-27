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

  // Debug: Log what config we're using to diagnose connection issues
  if (isMainClient) {
    if (config.redisUrl) {
      logger.debug(`Redis config: Using URL (length: ${config.redisUrl.length}, starts with: ${config.redisUrl.substring(0, 8)})`);
    } else {
      logger.debug(`Redis config: Using host/port (${config.redisHost}:${config.redisPort}) - REDIS_URL not set or empty`);
      logger.debug(`Environment check: REDIS_URL=${process.env.REDIS_URL ? `"${process.env.REDIS_URL.substring(0, 20)}..."` : 'not set'}, REDIS_URI=${process.env.REDIS_URI ? 'set' : 'not set'}`);
    }
  }

  // CRITICAL: When using URL, we must NOT provide socket.host/port as that overrides the URL
  if (config.redisUrl) {
    // When using URL (especially rediss:// for TLS), let the URL handle TLS automatically
    // IMPORTANT: Do NOT set socket.host or socket.port when using URL - it will override the URL!
    const isTLS = config.redisUrl.startsWith('rediss://');
    const sanitizedUrl = config.redisUrl.replace(/:[^:@]+@/, ':****@');
    
    if (isMainClient) {
      logger.info(`Initializing Redis client with URL: ${sanitizedUrl} (TLS: ${isTLS ? 'enabled' : 'disabled'})`);
    }
    
    // When using URL, only set socket options that don't conflict (no host/port!)
    const urlOptions: RedisClientOptions = {
      url: config.redisUrl, // This is the key - URL contains all connection info
      commandsQueueMaxLength: 1000,
      disableOfflineQueue: true,
      socket: {
        // Only set reconnect strategy and timeouts - NO host/port!
        reconnectStrategy: (retries: number) => {
          if (retries > 10) {
            if (!hasLoggedRedisUnavailable && isMainClient) {
              logger.warn(`Redis connection unavailable after 10 retries (${sanitizedUrl}) - app will continue without Redis`);
              hasLoggedRedisUnavailable = true;
            }
            return false;
          }
          const delay = Math.min(retries * 50, 2000);
          if (retries <= 3 && isMainClient && !hasLoggedRedisUnavailable) {
            logger.debug(`Redis connection retry attempt ${retries}, waiting ${delay}ms`);
          }
          return delay;
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
    if (isMainClient) {
      logger.info(`Initializing Redis client with host/port: ${config.redisHost}:${config.redisPort}`);
    }
    const options = createRedisOptions();
    redisClient = createClient(options) as RedisClientType;
    // Mark that this client was created without URL
    (redisClient as any)._createdWithUrl = false;
  }

  // Set up event handlers
  if (redisClient) {
    redisClient.on('connect', () => {
      const config = getRedisConfig();
      const connectionInfo = config.redisUrl 
        ? (config.redisUrl.startsWith('rediss://') ? 'TLS' : 'non-TLS')
        : `Host: ${config.redisHost}, Port: ${config.redisPort}`;
      logger.debug(`Redis client connecting (${connectionInfo})...`);
    });

    redisClient.on('ready', () => {
      logger.info('Redis client ready and connected');
    });

    redisClient.on('error', (err: Error) => {
      // Only log connection errors once from main client to reduce spam
      // The app can continue without Redis (graceful degradation)
      const config = getRedisConfig();
      const connectionInfo = config.redisUrl 
        ? `URL: ${config.redisUrl.replace(/:[^:@]+@/, ':****@')}`
        : `Host: ${config.redisHost}, Port: ${config.redisPort}`;
      
      // Log detailed error information for debugging
      const errorDetails = {
        message: err.message,
        code: (err as any).code,
        errno: (err as any).errno,
        syscall: (err as any).syscall,
        address: (err as any).address,
        port: (err as any).port,
      };
      
      if (err.message.includes('ECONNREFUSED') || err.message.includes('ENOTFOUND')) {
        if (!hasLoggedRedisUnavailable && isMainClient) {
          const isTLS = config.redisUrl?.startsWith('rediss://');
          const troubleshooting = isTLS 
            ? ' (Check: 1) Your IP is in trusted sources, 2) VPN/firewall not blocking, 3) TLS enabled)'
            : '';
          logger.warn(`Redis connection unavailable (${connectionInfo})${troubleshooting} - app will continue without caching`, errorDetails);
          hasLoggedRedisUnavailable = true;
        }
      } else if (err.message.includes('certificate') || err.message.includes('TLS') || err.message.includes('SSL')) {
        // Log TLS/SSL errors with more detail for debugging
        if (!hasLoggedRedisUnavailable && isMainClient) {
          logger.error('Redis TLS connection error:', {
            ...errorDetails,
            stack: err.stack,
            connectionInfo,
            url: config.redisUrl ? (config.redisUrl.replace(/:[^:@]+@/, ':****@')) : 'not set'
          });
          hasLoggedRedisUnavailable = true;
        }
      } else if (err.message.includes('NOAUTH') || err.message.includes('AUTH')) {
        // Authentication errors - likely missing or incorrect password
        if (!hasLoggedRedisUnavailable && isMainClient) {
          logger.error(`Redis authentication error (${connectionInfo}): Check username/password in connection string`, errorDetails);
          hasLoggedRedisUnavailable = true;
        }
      } else {
        // Log other errors with full details for debugging
        if (isMainClient) {
          logger.error('Redis client error:', { ...errorDetails, connectionInfo, stack: err.stack });
        }
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
    redisClientPromise = redisClient.connect().then(async () => {
      // Wait for client to be ready, not just connected
      // Give it up to 2 seconds to become ready
      for (let i = 0; i < 20; i++) {
        if (redisClient!.isReady) {
          // Verify with ping to ensure connection is actually working
          try {
            await redisClient!.ping();
            hasLoggedRedisUnavailable = false; // Reset flag on successful connection
            isMainClient = true; // Reset flag
            const config = getRedisConfig();
            const sanitizedUrl = config.redisUrl?.replace(/:[^:@]+@/, ':****@') || 'local';
            logger.info(`Redis client ready and verified with ping (${sanitizedUrl})`);
            return redisClient!;
          } catch (pingError: any) {
            // Ping failed - connection not actually working
            if (isMainClient) {
              logger.warn('Redis client connected but ping failed:', pingError.message);
            }
            break;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      // If still not ready after 2 seconds, log a warning but continue
      if (isMainClient && !hasLoggedRedisUnavailable) {
        const config = getRedisConfig();
        const connectionInfo = config.redisUrl 
          ? `URL: ${config.redisUrl.replace(/:[^:@]+@/, ':****@')}`
          : `Host: ${config.redisHost}, Port: ${config.redisPort}`;
        logger.warn(`Redis client connected but not ready after 2s (${connectionInfo}) - may not be fully functional`);
      }
      return redisClient!;
    }).catch((error: any) => {
      // Log connection errors with details for debugging
      if (isMainClient) {
        const config = getRedisConfig();
        const connectionInfo = config.redisUrl 
          ? `URL: ${config.redisUrl.replace(/:[^:@]+@/, ':****@')}`
          : `Host: ${config.redisHost}, Port: ${config.redisPort}`;
        logger.debug(`Redis connect() failed (${connectionInfo}):`, {
          message: error.message,
          code: error.code,
          errno: error.errno,
          syscall: error.syscall,
        });
      }
      // Don't crash the app if Redis is unavailable
      // The app will gracefully degrade without Redis
      // Error logging is handled by the error event handler and reconnect strategy
      // Keep the client reference but mark promise as failed
      // This allows the app to continue and Redis operations will gracefully degrade
      redisClientPromise = null;
      // Don't throw - allow app to start without Redis
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
  } catch (error) {
    const config = getRedisConfig();
    const connectionInfo = config.redisUrl 
      ? `URL: ${config.redisUrl.replace(/:[^:@]+@/, ':****@')}`
      : `Host: ${config.redisHost}, Port: ${config.redisPort}`;
    logger.debug(`Redis health check failed (${connectionInfo}):`, error);
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
  
  // Silent reconnect strategy for pub/sub clients
  const reconnectStrategy = (retries: number) => {
    if (retries > 10) {
      return false; // Stop reconnecting silently
    }
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
    
    // Set up error handlers - gracefully handle connection issues
    let lastConnectionErrorTime = 0;
    const CONNECTION_ERROR_THROTTLE_MS = 10000; // Throttle connection error logs to once per 10 seconds
    
    client.on('error', (err: Error) => {
      const errorMessage = err.message || '';
      const errorName = err.name || '';
      const now = Date.now();
      
      // Don't log expected connection errors (already handled by main client)
      // These are normal during reconnection and should not spam logs
      const isConnectionError = 
        errorMessage.includes('ECONNREFUSED') ||
        errorMessage.includes('ENOTFOUND') ||
        errorMessage.includes('Socket closed unexpectedly') ||
        errorMessage.includes('SocketClosedUnexpectedlyError') ||
        errorName.includes('SocketClosed') ||
        errorName === 'SocketClosedUnexpectedlyError' ||
        errorMessage.includes('Connection closed') ||
        errorMessage.includes('Connection lost') ||
        errorMessage.includes('The socket closed unexpectedly');
      
      // Only log unexpected errors (not connection-related)
      if (!isConnectionError) {
        logger.error('Redis pub/sub error:', err);
      } else {
        // Throttle connection error logging (only log once per 10 seconds per client)
        if (now - lastConnectionErrorTime > CONNECTION_ERROR_THROTTLE_MS) {
          logger.debug(`Redis pub/sub connection issue (reconnecting automatically): ${errorName || errorMessage}`);
          lastConnectionErrorTime = now;
        }
        // Don't log as error - this is expected during reconnection, Redis client will auto-reconnect
      }
    });
    
    // Handle reconnection events gracefully
    client.on('reconnecting', () => {
      // Don't log - too noisy during normal reconnection
    });
    
    // Handle connection end gracefully
    client.on('end', () => {
      logger.debug('Redis pub/sub connection ended (will reconnect if needed)');
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
