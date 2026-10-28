import type http from 'node:http';
import type { Server as SocketIOServer } from 'socket.io';
import { closePostgres } from '../db/postgres';
import { shutdownQueues } from '../queue/workers';
import { stopBackgroundJobs } from './backgroundJobs';
import { config } from '../config';
import { closeRedisConnection } from '../utils/redis';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';
import { markRuntimeShuttingDown } from '../utils/runtimeHealth';
import type { PresenceRegistry } from './presenceRegistry';
import { drainBackgroundWork } from './backgroundWork';
import { clearRuntimeSocketServer } from './socketServer';
import { closeSocketRedisAdapter } from './socketRedisAdapter';

/** Hard ceiling on the whole drain; open connections are then forced closed. */
const SHUTDOWN_DEADLINE_MS = 10_000;

export interface GracefulShutdownDeps {
  stopActivity?: () => Promise<void>;
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

      const closeSockets = () =>
        new Promise<void>((resolve) => {
          io.close(() => {
            clearRuntimeSocketServer(io);
            resolve();
          });
        });
      // HTTP roles stop client admission immediately. A worker has no clients;
      // keep its Redis emitter alive until the last claimed job has drained.
      const socketShutdown = config.runtime.processRole === 'worker' ? undefined : closeSockets();

      await presence.drainOffline();
      // Stop every producer/worker while Redis and Postgres are still available.
      // LeaderElection releases its owner-checked lock only after onLose has
      // stopped singleton schedulers.
      //
      // `drainBackgroundWork` belongs in THIS phase for the same reason the
      // dispatchers do: detached request work (the post-create socket broadcast)
      // still needs the database it hydrates from and the socket server it emits
      // on, and both close in the phase below. It is bounded well under
      // SHUTDOWN_DEADLINE_MS and resolves rather than rejects on timeout, so it
      // can delay this drain but never block it.
      await Promise.allSettled([
        config.runtime.processRole === 'backend' ? shutdownQueues() : stopBackgroundJobs(),
        drainBackgroundWork(),
      ]);

      await Promise.allSettled([
        httpClosed,
        socketShutdown ?? closeSockets(),
        stopUserInvalidationSubscriber(),
        closeSocketRedisAdapter(),
        closeRedisConnection(),
        closePostgres(),
      ]);

      await deps.stopActivity?.();
      // Last: the final interval includes everything the drain above recorded.
      metrics.stop();
      clearTimeout(hardTimeout);
      logger.info('HTTP, sockets, queues, Redis and PostgreSQL closed');
      process.exit(0);
    })();
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}
