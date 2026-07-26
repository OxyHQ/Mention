import { createClient, type RedisClientOptions, type RedisClientType } from 'redis';
import {
  getRedisConnectionConfig,
  type RedisConnectionConfig,
} from '../config';
import { logger } from './logger';

type RedisSupervisorStatus =
  | 'not_initialized'
  | 'connecting'
  | 'ready'
  | 'cooldown'
  | 'stopped';

export interface RedisStats {
  connected: boolean;
  status: RedisSupervisorStatus;
  attemptInFlight: boolean;
  failureCount: number;
  retryScheduled: boolean;
  nextRetryAt: number | null;
  lastFailureAt: number | null;
}

const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;
const RETRY_JITTER_RATIO = 0.2;

let sharedClient: RedisClientType | null = null;
let connectionAttempt: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let supervisorStatus: RedisSupervisorStatus = 'not_initialized';
let failureCount = 0;
let nextRetryAt: number | null = null;
let lastFailureAt: number | null = null;
let supervisorGeneration = 0;
let supervisorStopped = false;
let outageLogged = false;

/**
 * Pub/sub clients are intentionally separate because node-redis requires
 * dedicated connections for subscribed sockets. The process-wide command
 * client uses the local supervisor below instead.
 */
function pubSubReconnectStrategy(retries: number): number | false {
  if (retries > 3) return false;
  return Math.min(retries * 50, 2_000);
}

function createHostOptions(
  redisConfig: RedisConnectionConfig,
  supervised: boolean,
): RedisClientOptions {
  return {
    socket: {
      host: redisConfig.host,
      port: redisConfig.port,
      reconnectStrategy: supervised ? false : pubSubReconnectStrategy,
      connectTimeout: 10_000,
      keepAlive: true,
    },
    database: redisConfig.db,
    commandsQueueMaxLength: 1_000,
    disableOfflineQueue: true,
    ...(redisConfig.password && { password: redisConfig.password }),
  };
}

function createUrlOptions(url: string, supervised: boolean): RedisClientOptions {
  return {
    url,
    commandsQueueMaxLength: 1_000,
    disableOfflineQueue: true,
    socket: {
      reconnectStrategy: supervised ? false : pubSubReconnectStrategy,
      connectTimeout: url.startsWith('rediss://') ? 20_000 : 15_000,
      keepAlive: true,
    },
  };
}

function logRedisEndpoint(redisConfig: RedisConnectionConfig): void {
  if (!redisConfig.url) {
    logger.debug(`Connecting to Redis: ${redisConfig.host}:${redisConfig.port}`);
    return;
  }

  // Never print URL credentials, query values or database paths.
  const endpoint = new URL(redisConfig.url);
  const port = endpoint.port ? `:${endpoint.port}` : '';
  logger.info(`Connecting to Redis: ${endpoint.protocol}//${endpoint.hostname}${port}`);
}

function clearRetryTimer(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  nextRetryAt = null;
}

function retryDelayMs(attemptNumber: number): number {
  const exponentialDelay = Math.min(
    RETRY_MAX_DELAY_MS,
    RETRY_BASE_DELAY_MS * 2 ** Math.min(Math.max(attemptNumber - 1, 0), 10),
  );
  const jitter = Math.floor(exponentialDelay * RETRY_JITTER_RATIO * Math.random());
  return Math.min(RETRY_MAX_DELAY_MS, exponentialDelay + jitter);
}

function logConnectionFailure(error: unknown): void {
  if (outageLogged) return;

  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('NOAUTH') || message.includes('AUTH')) {
    logger.error('Redis authentication failed — check credentials');
  } else if (
    message.includes('certificate') ||
    message.includes('TLS') ||
    message.includes('SSL')
  ) {
    logger.error('Redis TLS error');
  } else {
    logger.warn('Redis not available — running without cache');
  }
  outageLogged = true;
}

function scheduleRetry(client: RedisClientType, generation: number): void {
  if (
    supervisorStopped ||
    generation !== supervisorGeneration ||
    sharedClient !== client ||
    retryTimer
  ) {
    return;
  }

  const delay = retryDelayMs(failureCount);
  nextRetryAt = Date.now() + delay;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    nextRetryAt = null;
    startConnectionAttempt(client, generation);
  }, delay);
  retryTimer.unref?.();
}

function recordConnectionFailure(
  client: RedisClientType,
  generation: number,
  error: unknown,
  destroySocket = false,
): void {
  if (
    supervisorStopped ||
    generation !== supervisorGeneration ||
    sharedClient !== client ||
    supervisorStatus === 'cooldown'
  ) {
    return;
  }

  failureCount += 1;
  lastFailureAt = Date.now();
  supervisorStatus = 'cooldown';
  logConnectionFailure(error);

  // State changes first so a synchronous `end` emitted by destroy cannot
  // record the same outage twice or create a second timer.
  if (destroySocket && client.isOpen) {
    try {
      client.destroy();
    } catch {
      logger.debug('Redis socket was already closed during recovery');
    }
  }
  scheduleRetry(client, generation);
}

function markReady(client: RedisClientType, generation: number): boolean {
  if (
    supervisorStopped ||
    generation !== supervisorGeneration ||
    sharedClient !== client
  ) {
    return false;
  }

  clearRetryTimer();
  supervisorStatus = 'ready';
  failureCount = 0;
  outageLogged = false;
  return true;
}

function startConnectionAttempt(
  client: RedisClientType,
  generation: number,
): void {
  if (
    supervisorStopped ||
    generation !== supervisorGeneration ||
    sharedClient !== client ||
    client.isReady ||
    connectionAttempt
  ) {
    return;
  }

  clearRetryTimer();
  supervisorStatus = 'connecting';

  // A rejected connection normally closes its socket. Destroy a half-open
  // socket defensively before retrying the same stable client instance.
  if (client.isOpen) {
    client.destroy();
  }

  let connectPromise: Promise<unknown>;
  try {
    connectPromise = client.connect();
  } catch (error) {
    recordConnectionFailure(client, generation, error);
    return;
  }

  let attempt: Promise<void>;
  attempt = connectPromise
    .then(() => {
      if (
        supervisorStopped ||
        generation !== supervisorGeneration ||
        sharedClient !== client
      ) {
        if (client.isOpen) client.destroy();
        return;
      }
      if (!client.isReady) {
        recordConnectionFailure(
          client,
          generation,
          new Error('Redis connect completed before the client became ready'),
        );
        return;
      }
      markReady(client, generation);
    })
    .catch((error: unknown) => {
      recordConnectionFailure(client, generation, error);
    })
    .finally(() => {
      if (connectionAttempt === attempt) {
        connectionAttempt = null;
      }
    });
  connectionAttempt = attempt;
}

function registerClientHandlers(
  client: RedisClientType,
  generation: number,
): void {
  client.on('ready', () => {
    if (markReady(client, generation)) {
      logger.info('Redis connected');
    }
  });

  client.on('error', (error: Error) => {
    if (
      supervisorStopped ||
      generation !== supervisorGeneration ||
      sharedClient !== client
    ) {
      return;
    }
    logConnectionFailure(error);
  });

  client.on('end', () => {
    if (
      supervisorStopped ||
      generation !== supervisorGeneration ||
      sharedClient !== client ||
      supervisorStatus !== 'ready'
    ) {
      return;
    }
    recordConnectionFailure(client, generation, new Error('Redis connection ended'));
  });
}

/** Get the stable process-wide command client without blocking a request. */
export function getRedisClient(): RedisClientType {
  if (sharedClient) return sharedClient;

  const redisConfig = getRedisConnectionConfig();
  logRedisEndpoint(redisConfig);

  const client = createClient(
    redisConfig.url
      ? createUrlOptions(redisConfig.url, true)
      : createHostOptions(redisConfig, true),
  ) as RedisClientType;
  sharedClient = client;
  const generation = supervisorGeneration;

  registerClientHandlers(client, generation);
  startConnectionAttempt(client, generation);
  return client;
}

/**
 * Open the command-client circuit after a hot-path transport failure.
 *
 * Only the supervised shared client may affect lifecycle state. Foreign
 * pub/sub/test clients, shutdown, in-flight connects and an already-open
 * cooldown are deliberately ignored.
 */
export function reportRedisConnectionFailure(
  client: RedisClientType,
  error: unknown,
): void {
  if (
    supervisorStopped ||
    sharedClient !== client ||
    supervisorStatus !== 'ready'
  ) {
    return;
  }
  recordConnectionFailure(client, supervisorGeneration, error, true);
}

/** Local connection state for health reporting; this performs no network IO. */
export function getRedisStats(): RedisStats {
  const client = sharedClient;
  return {
    connected: Boolean(client?.isReady) && !supervisorStopped,
    status: supervisorStatus,
    attemptInFlight: connectionAttempt !== null,
    failureCount,
    retryScheduled: retryTimer !== null,
    nextRetryAt,
    lastFailureAt,
  };
}

/**
 * Stop the supervisor before closing the socket so no timer or late event can
 * reconnect during process shutdown. Shutdown is terminal for this module.
 */
export async function closeRedisConnection(): Promise<void> {
  if (supervisorStopped) return;

  supervisorStopped = true;
  supervisorGeneration += 1;
  supervisorStatus = 'stopped';
  clearRetryTimer();
  connectionAttempt = null;
  const client = sharedClient;

  if (!client) return;

  try {
    if (client.isReady) {
      await client.quit();
    } else if (client.isOpen) {
      client.destroy();
    }
    logger.info('Redis connection closed');
  } catch (error) {
    if (client.isOpen) client.destroy();
    logger.warn('Redis connection close failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Create independent publisher/subscriber clients. Callers own connect/close.
 * These are not used by request hot paths and are required by the Socket.IO
 * adapter's dedicated pub/sub protocol.
 */
export function createRedisPubSub(): {
  publisher: RedisClientType;
  subscriber: RedisClientType;
} {
  const redisConfig = getRedisConnectionConfig();

  const createPubSubClient = (): RedisClientType => {
    const client = createClient(
      redisConfig.url
        ? createUrlOptions(redisConfig.url, false)
        : createHostOptions(redisConfig, false),
    ) as RedisClientType;
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
