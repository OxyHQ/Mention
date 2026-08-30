import type http from 'http';
import type { Server as SocketIOServer } from 'socket.io';
import { closePostgres } from '../db/postgres';
import { shutdownQueues } from '../queue/workers';
import { engagementOutboxDispatcher } from '../services/EngagementOutboxDispatcher';
import { leaderElection } from '../services/LeaderElection';
import { moderationOutboxDispatcher } from '../services/moderation/ModerationOutboxDispatcher';
import { closeRedisConnection } from '../utils/redis';
import { logger } from '../utils/logger';
import { markRuntimeShuttingDown } from '../utils/runtimeHealth';
import type { PresenceRegistry } from './presenceRegistry';
import { clearRuntimeSocketServer } from './socketServer';
import { closeSocketRedisAdapter } from './socketRedisAdapter';

/** Hard ceiling on the whole drain; open connections are then forced closed. */
const SHUTDOWN_DEADLINE_MS = 10_000;

export interface GracefulShutdownDeps {
  server: http.Server;
  io: SocketIOServer;
  presence: PresenceRegistry;
  /** Stop the Oxy user-cache invalidation subscriber boot started, if any. */
  stopUserInvalidationSubscriber: () => Promise<void>;
}

/**
 * Install the SIGTERM/SIGINT drain.
 *
 * ECS sends SIGTERM on task stop (and again SIGKILL after the stop timeout).
 * Readiness is cleared and HTTP stops accepting immediately. Producers and
 * workers then drain while Postgres/Redis are still available, and the scheduler
 * leadership lock is released only after singleton schedulers have stopped.
 */
export function registerGracefulShutdown(deps: GracefulShutdownDeps): void {
  const { server, io, presence, stopUserInvalidationSubscriber } = deps;
  let isShuttingDown = false;

  const gracefulShutdown = (signal: string): void => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    markRuntimeShuttingDown();
    logger.info(`Received ${signal} - shutting down gracefully`);

    // Stop accepting HTTP immediately. All dependency cleanup then runs
    // concurrently under a hard deadline.
    const httpClosed = new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((error) => {
        if (error) logger.warn('HTTP server close reported an error', error);
        resolve();
      });
    });

    const hardTimeout = setTimeout(() => {
      logger.warn('Shutdown timed out - forcing open connections closed');
      server.closeAllConnections?.();
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    hardTimeout.unref();

    void (async () => {
      presence.stopHousekeeping();

      const queueShutdown = async (): Promise<void> => {
        try {
          await shutdownQueues();
        } catch (error) {
          logger.error("Error shutting down federation queues", error);
        }
      };

      // Constructed here rather than awaited later on purpose: `io.close()` runs
      // the moment this executor does, so sockets stop accepting alongside HTTP.
      const socketShutdown = new Promise<void>((resolve) => {
        io.close(() => {
          clearRuntimeSocketServer(io);
          resolve();
        });
      });

      await presence.drainOffline();
      // Stop every producer/worker while Redis and Postgres are still available.
      // LeaderElection releases its owner-checked lock only after onLose has
      // stopped singleton schedulers.
      await Promise.allSettled([
        leaderElection.stop(),
        engagementOutboxDispatcher.stop(),
        moderationOutboxDispatcher.stop(),
        queueShutdown(),
      ]);

      await Promise.allSettled([
        httpClosed,
        socketShutdown,
        stopUserInvalidationSubscriber(),
        closeSocketRedisAdapter(),
        closeRedisConnection(),
        closePostgres(),
      ]);

      clearTimeout(hardTimeout);
      logger.info('HTTP, sockets, queues, Redis and PostgreSQL closed');
      process.exit(0);
    })();
  };

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}
