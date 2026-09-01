import type { Server as SocketIOServer } from 'socket.io';
import { createRedisPubSub } from '../utils/redis';
import { isRedisConnectionError } from '../utils/redisHelpers';
import { logger } from '../utils/logger';

let socketRedisClients: ReturnType<typeof createRedisPubSub> | null = null;

/**
 * Setup the Redis adapter for Socket.IO horizontal scaling.
 *
 * Note: @socket.io/redis-adapter v8+ supports node-redis.
 *
 * Never throws: if Redis is unavailable the server keeps running in
 * single-instance mode, which is also the local-development shape.
 */
export async function attachSocketRedisAdapter(io: SocketIOServer): Promise<void> {
  try {
    const { createAdapter } = require('@socket.io/redis-adapter');
    const { publisher, subscriber } = createRedisPubSub();
    socketRedisClients = { publisher, subscriber };

    // Connect both clients with timeout to avoid hanging
    await Promise.race([
      Promise.all([
        publisher.connect(),
        subscriber.connect()
      ]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Redis connection timeout')), 5000)
      )
    ]);

    // Verify both clients are actually ready before proceeding
    if (!publisher.isReady || !subscriber.isReady) {
      throw new Error('Redis clients connected but not ready');
    }

    io.adapter(createAdapter(publisher, subscriber));
    logger.info('Socket.IO Redis adapter configured for horizontal scaling');
  } catch (error: unknown) {
    await closeSocketRedisAdapter();
    // If Redis is unavailable, continue without adapter (single-instance mode)
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (isRedisConnectionError(error) || errorMessage.includes('timeout') || errorMessage.includes('not ready')) {
      logger.info('Redis unavailable - Socket.IO running in single-instance mode (no horizontal scaling)');
    } else {
      logger.warn('Failed to setup Socket.IO Redis adapter, running in single-instance mode:', error);
    }
  }
}

/** Idempotent: a no-op when the adapter never connected or is already closed. */
export async function closeSocketRedisAdapter(): Promise<void> {
  if (!socketRedisClients) return;
  const { publisher, subscriber } = socketRedisClients;
  socketRedisClients = null;
  await Promise.allSettled([
    publisher.isOpen ? publisher.quit() : Promise.resolve(),
    subscriber.isOpen ? subscriber.quit() : Promise.resolve(),
  ]);
}
