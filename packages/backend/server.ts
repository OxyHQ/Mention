// --- Imports ---
import http from "http";
import { hostname } from 'os';
import { Server as SocketIOServer, Namespace } from "socket.io";
import { PUBLIC_REALTIME_NAMESPACE } from "@mention/shared-types";
import { logger } from "./src/utils/logger";
import { config, validateEnvironment } from './src/config';
import { isAllowedOrigin } from "./src/utils/allowedOrigins";
import { closePostgres, connectPostgres, getPostgresClient } from "./src/db/postgres";
import { assertPostgresMigrationsCurrent } from "./src/db/migrationsFolder";
import { leaderElection } from "./src/services/LeaderElection";
import {
  markMigrationsComplete,
  markRuntimeNotReady,
  markRuntimeReady,
  markRuntimeShuttingDown,
} from './src/utils/runtimeHealth';
import {
  closeRedisConnection,
  createRedisPubSub,
  getRedisClient,
} from './src/utils/redis';
import { isRedisConnectionError } from './src/utils/redisHelpers';
import {
  startUserInvalidationSubscriber,
  type UserInvalidationSubscriber,
} from './src/services/userInvalidationSubscriber';
import { DistributedPresenceService } from './src/services/DistributedPresenceService';
import { registerGlobalErrorHandlers } from './src/runtime/globalErrorHandlers';
import { PresenceRegistry } from './src/runtime/presenceRegistry';
import { startSchedulers, stopSchedulers } from './src/runtime/schedulers';
import {
  registerSocketPresence,
  type AuthenticatedPresenceSocket as AuthenticatedSocket,
} from './src/services/SocketPresenceLifecycle';
import { registerContentRoomHandlers } from './src/services/ContentRoomLifecycle';
import { engagementOutboxDispatcher } from './src/services/EngagementOutboxDispatcher';
import { moderationOutboxDispatcher } from './src/services/moderation/ModerationOutboxDispatcher';

import { resolveNotificationInboxIds } from './src/services/notificationInbox';
import { createUserScopedOxyServices } from './src/utils/oxyHelpers';

// Models
import {
  markAllNotificationsRead,
  markNotificationRead,
} from "./src/services/notificationReadState";
import {
  clearRuntimeSocketServer,
  setRuntimeSocketServer,
} from './src/runtime/socketServer';

// MTN Protocol
import { registerAllModules } from './src/mtn/feed/engine';
import { createRuntimeApp } from './src/runtimeApp';

// Registered before bootstrap starts any asynchronous work; the imports above
// have finished, so the sanitizer and validated config are live in a handler.
registerGlobalErrorHandlers();

export const { app, oxy } = createRuntimeApp();

// --- Sockets ---
const server = http.createServer(app);

const presence = new PresenceRegistry({
  distributedPresence: new DistributedPresenceService(
    getRedisClient,
    `${hostname()}:${process.pid}`,
  ),
  isSocketConnected: (socketId) => io.sockets.sockets.get(socketId)?.connected === true,
  // Emit to users subscribed to this user's presence. Targeted emit only — no
  // global broadcast.
  emitPresence: (userId, payload) => {
    io.to(`presence:${userId}`).emit('user:presence', payload);
  },
});
presence.startHousekeeping();

type DisconnectReason =
  | "server disconnect" | "client disconnect" | "transport close" | "transport error" | "ping timeout" | "parse error" | "forced close" | "forced server close" | "server shutting down" | "client namespace disconnect" | "server namespace disconnect" | "unknown transport";

import { createSocketRateLimiter } from './src/middleware/socketRateLimit';

// Shared socket rate limiter instance
const socketRateLimiter = createSocketRateLimiter();

const SOCKET_CONFIG = {
  PING_TIMEOUT: config.socket.pingTimeout,
  PING_INTERVAL: config.socket.pingInterval,
  UPGRADE_TIMEOUT: config.socket.upgradeTimeout,
  CONNECT_TIMEOUT: config.socket.connectTimeout,
  MAX_BUFFER_SIZE: config.socket.maxBufferSize,
  COMPRESSION_THRESHOLD: config.socket.compressionThreshold,
  CHUNK_SIZE: 10 * 1024,
  WINDOW_BITS: 14,
  COMPRESSION_LEVEL: 6,
} as const;

const io = new SocketIOServer(server, {
  transports: ["websocket", "polling"],
  path: "/socket.io",
  pingTimeout: SOCKET_CONFIG.PING_TIMEOUT,
  pingInterval: SOCKET_CONFIG.PING_INTERVAL,
  upgradeTimeout: SOCKET_CONFIG.UPGRADE_TIMEOUT,
  maxHttpBufferSize: SOCKET_CONFIG.MAX_BUFFER_SIZE,
  connectTimeout: SOCKET_CONFIG.CONNECT_TIMEOUT,
  cors: {
    origin: (origin, callback) => {
      if (!origin || isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token", "X-Requested-With", "Accept", "Accept-Version", "Content-Length", "Content-MD5", "Date", "X-Api-Version"]
  },
  perMessageDeflate: {
    threshold: SOCKET_CONFIG.COMPRESSION_THRESHOLD,
    zlibInflateOptions: { chunkSize: SOCKET_CONFIG.CHUNK_SIZE, windowBits: SOCKET_CONFIG.WINDOW_BITS },
    zlibDeflateOptions: { chunkSize: SOCKET_CONFIG.CHUNK_SIZE, windowBits: SOCKET_CONFIG.WINDOW_BITS, level: SOCKET_CONFIG.COMPRESSION_LEVEL },
  },
});
setRuntimeSocketServer(io);

let socketRedisClients: ReturnType<typeof createRedisPubSub> | null = null;
let userInvalidationSubscriber: UserInvalidationSubscriber | null = null;

// Setup Redis adapter for Socket.IO horizontal scaling
// Note: @socket.io/redis-adapter v8+ supports node-redis
async function setupRedisAdapter(): Promise<void> {
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
    if (socketRedisClients) {
      const { publisher, subscriber } = socketRedisClients;
      await Promise.allSettled([
        publisher.isOpen ? publisher.quit() : Promise.resolve(),
        subscriber.isOpen ? subscriber.quit() : Promise.resolve(),
      ]);
      socketRedisClients = null;
    }
    // If Redis is unavailable, continue without adapter (single-instance mode)
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (isRedisConnectionError(error) || errorMessage.includes('timeout') || errorMessage.includes('not ready')) {
      logger.info('Redis unavailable - Socket.IO running in single-instance mode (no horizontal scaling)');
    } else {
      logger.warn('Failed to setup Socket.IO Redis adapter, running in single-instance mode:', error);
    }
  }
}

const configureNamespaceErrorHandling = (namespace: Namespace) => {
  namespace.on("connection_error", (error: Error) => {
    logger.error(`Connection error in namespace ${namespace.name}`, error);
  });
  namespace.on("connect_error", (error: Error) => {
    logger.error(`Connect error in namespace ${namespace.name}`, error);
  });
  namespace.on("connect_timeout", () => {
    logger.warn(`Connection timeout in namespace ${namespace.name}`);
  });
};

const notificationsNamespace = io.of("/notifications");
const postsNamespace = io.of("/posts");

/**
 * The one namespace on this server with NO auth middleware.
 *
 * It exists because trending is a public surface: a signed-out visitor sees the
 * widget, and every other namespace here rejects a client with no session, so
 * anonymous readers had no push path at all. The admission rule for what may be
 * emitted here — public by definition, broadcast to everyone, notice not payload
 * — is documented with `PUBLIC_REALTIME_NAMESPACE` in `@mention/shared-types`.
 * Read it before adding an event.
 *
 * There are no rooms here and no inbound message handlers, deliberately: with no
 * `socket.user.id` to derive a room from, any room key would have to come from
 * client input, which is exactly the shape this codebase forbids.
 */
const publicNamespace = io.of(PUBLIC_REALTIME_NAMESPACE);

// --- Socket Auth Middleware ---
// Use oxy.authSocket() which validates tokens via jwtDecode + Oxy API session validation.
// This matches how oxy.auth() works for HTTP — no local JWT_SECRET needed.
// `publicNamespace` is intentionally absent from this list; see its doc comment.
const oxySocketAuth = oxy.authSocket();
const authTargets: Array<Namespace | SocketIOServer> = [notificationsNamespace, postsNamespace, io];
authTargets.forEach((namespaceOrServer) => {
  if (namespaceOrServer && typeof namespaceOrServer.use === "function") {
    namespaceOrServer.use(oxySocketAuth);
  }
});

// --- Socket Namespace Config ---

// Configure notifications namespace
notificationsNamespace.on("connection", (socket: AuthenticatedSocket) => {
  logger.info('Client connected to notifications namespace');

  if (!socket.user?.id) {
    logger.warn("Unauthenticated client attempted to connect to notifications namespace");
    socket.disconnect(true);
    return;
  }

  const userRoom = `user:${socket.user.id}`;
  const userId = socket.user.id;
  socket.join(userRoom);
  logger.debug('Authenticated client joined notification room');

  // Also join the room of every CHANNEL this person operates.
  //
  // A channel has no session, so nothing ever joined `user:<channelId>` and the
  // emit `createNotification` already makes for a channel-addressed row went to
  // an empty room. Joining here is what delivers it live, with NO change to the
  // write path — and the notifications socket is the only live path the client
  // has (it applies targeted cache patches and never polls), so without this a
  // channel's engagement would not surface until a manual refresh.
  //
  // The room is derived from Oxy's answer for this socket's own verified bearer,
  // never from anything the client sent. Fail-soft: a resolve failure leaves the
  // operator with their personal room, exactly as before.
  //
  // Resolved ONCE, at connect. A membership revoked mid-connection therefore
  // keeps delivering live rows until this socket reconnects — every DURABLE
  // surface (list, unread count, mark-read, delete) re-resolves within the
  // `notificationInbox` cache TTL and cuts off much sooner. The payload is
  // engagement metadata on a public post, which is why that window is acceptable
  // here and would not be for the read routes.
  const socketBearer = typeof socket.handshake.auth?.token === 'string'
    ? socket.handshake.auth.token
    : undefined;
  if (socketBearer) {
    void resolveNotificationInboxIds(userId, createUserScopedOxyServices({ accessToken: socketBearer }))
      .then((recipientIds) => {
        if (!socket.connected) return;
        for (const recipientId of recipientIds) {
          if (recipientId !== userId) socket.join(`user:${recipientId}`);
        }
      })
      .catch((error: unknown) => {
        logger.warn('[Notifications] failed to join operated-channel rooms', {
          error: error instanceof Error ? error.message : 'unknown',
        });
      });
  }

  socket.on("error", (error: Error) => {
    logger.error("Notifications socket error", error);
  });

  // THE TWO READ-STATE HANDLERS BELOW STAY SCOPED TO THE PERSON, NOT TO THE
  // CHANNEL ROOMS JOINED ABOVE — deliberately, and this is the one place that
  // says so.
  //
  // The app never emits either of them: `useRealtimeNotifications` only LISTENS,
  // and mark-read/mark-all-read go over HTTP (`PATCH /notifications/:id/read`,
  // `PATCH /notifications/read-all`), where the scope is re-resolved per request
  // and covers a channel's rows. Widening these would mean authorizing a WRITE
  // from a set resolved once at connect, which a long-lived socket can outlive by
  // hours — a worse staleness window than the one the HTTP routes have, spent on
  // handlers nothing calls. Left narrow, they simply find no channel row and
  // no-op, which is the direction that fails closed.
  socket.on("markNotificationRead", socketRateLimiter.wrap(socket, 'markNotificationRead', async ({ notificationId }: { notificationId?: string }) => {
    try {
      if (!socket.user?.id) return;
      if (!notificationId) return;
      // Postgres, through the SAME helper the REST route uses. This used to
      // write the Mongoose model, which nothing has read since notifications
      // moved — so a notification marked read over the socket came back unread
      // on the next load, for every user, with nothing in any log.
      // `[userId]` — the narrowing the block comment above argues for, spelled
      // out. The signature takes the recipient SCOPE so this stays a decision
      // somebody made rather than a default nobody noticed.
      const notification = await markNotificationRead([userId], notificationId);
      if (notification) {
        notificationsNamespace
          .to(userRoom)
          .emit("notificationUpdated", notification);
      }
    } catch (error) {
      logger.error("Error marking notification as read", error);
    }
  }));

  socket.on("markAllNotificationsRead", socketRateLimiter.wrap(socket, 'markAllNotificationsRead', async () => {
    try {
      if (!socket.user?.id) return;
      await markAllNotificationsRead([userId]);
      notificationsNamespace.to(userRoom).emit("allNotificationsRead");
    } catch (error) {
      logger.error("Error marking all notifications as read", error);
    }
  }));

  socket.on("disconnect", (reason: DisconnectReason, description?: unknown) => {
    socketRateLimiter.cleanup(socket.id);
    logger.debug('Client disconnected from notifications namespace', {
      reason,
      description,
    });
    socket.leave(userRoom);
  });
});

// Configure postsNamespace events
postsNamespace.on("connection", (socket: AuthenticatedSocket) => {
  logger.info('Client connected to posts namespace');

  if (!socket.user?.id) {
    logger.warn("Unauthenticated client attempted to connect to posts namespace");
    socket.disconnect(true);
    return;
  }

  socket.on("error", (error: Error) => {
    logger.error("Posts socket error", error);
  });
  registerContentRoomHandlers(socket, socketRateLimiter);

  socket.on("disconnect", (reason: DisconnectReason) => {
    socketRateLimiter.cleanup(socket.id);
    logger.debug('Client disconnected from posts namespace', { reason });
  });
});

// Public namespace: broadcasts only. No auth, no rooms, and no inbound message
// handlers at all — a connection here is a subscription to server-wide public
// notices and nothing else. Nothing a client sends is ever read, which is why
// there is no rate-limited handler to register or clean up.
publicNamespace.on("connection", (socket) => {
  logger.debug('Client connected to public namespace');
  socket.on("disconnect", (reason: DisconnectReason) => {
    logger.debug('Client disconnected from public namespace', { reason });
  });
});

// Apply verification middleware to all namespaces
[
  notificationsNamespace,
  postsNamespace,
  publicNamespace,
].forEach((namespace) => {
  configureNamespaceErrorHandling(namespace);
});

// Configure main namespace with enhanced error handling
io.on("connection", (socket: AuthenticatedSocket) => {
  logger.info('Client connected');

  // registerSocketPresence installs disconnect cleanup synchronously before its
  // first Redis await. Do not await it here: every other socket listener must
  // also be attached in the same connection turn.
  void registerSocketPresence(socket, {
    onlineUsers: presence.onlineUsers,
    distributedPresence: presence.distributedPresence,
    broadcastPresence: (presenceUserId, online) => {
      presence.broadcastPresence(presenceUserId, online);
      logger.debug('User presence changed', { online });
    },
  }).catch((error) => {
    logger.warn('Failed to initialize socket presence', {
      reason: error instanceof Error ? error.message : String(error),
    });
  });

  // Enhanced error handling
  socket.on("error", (error: Error) => {
    logger.error("Socket error", error);
    // Attempt to reconnect on error
    if (socket.connected) {
      socket.disconnect();
    }
  });
  registerContentRoomHandlers(socket, socketRateLimiter);

  socket.on("disconnect", (reason: DisconnectReason, description?: unknown) => {
    socketRateLimiter.cleanup(socket.id);
    logger.debug('Client disconnected', { reason, description });

    // Handle specific disconnect reasons
    if (reason === "server disconnect") {
      // Reconnect if server initiated the disconnect
      socket.disconnect();
    }
    if (reason === "transport close" || reason === "transport error") {
      logger.debug("Transport issue detected, attempting reconnection...");
    }
  });

  socket.on("connect_error", (error: Error) => {
    logger.error("Connection error", error);
  });

  socket.on("reconnect_attempt", (attemptNumber: number) => {
    logger.debug(`Reconnection attempt ${attemptNumber}`);
  });

  socket.on("reconnect_error", (error: Error) => {
    logger.error("Reconnection error", error);
  });

  socket.on("reconnect_failed", () => {
    logger.error("Failed to reconnect");
  });

  // Get online status of a single user
  socket.on("getPresence", socketRateLimiter.wrap(socket, 'getPresence', async (targetUserId: string, callback?: (data: { online: boolean }) => void) => {
    if (!targetUserId || typeof targetUserId !== 'string') return;
    const online = await presence.isOnline(targetUserId);
    if (typeof callback === 'function') {
      callback({ online });
    } else {
      socket.emit('user:presence', { userId: targetUserId, online });
    }
  }));

  // Get online status of multiple users
  socket.on("getPresenceBulk", socketRateLimiter.wrap(socket, 'getPresenceBulk', async (userIds: string[], callback?: (data: Record<string, boolean>) => void) => {
    const result = Array.isArray(userIds)
      ? await presence.getBulk(userIds)
      : {};
    if (typeof callback === 'function') {
      callback(result);
    } else {
      socket.emit('user:presenceBulk', result);
    }
  }));

  // Subscribe to a user's presence changes
  socket.on("subscribePresence", socketRateLimiter.wrap(socket, 'subscribePresence', async (targetUserId: string) => {
    if (!targetUserId || typeof targetUserId !== 'string') return;
    socket.join(`presence:${targetUserId}`);
    const online = await presence.isOnline(targetUserId);
    socket.emit('user:presence', { userId: targetUserId, online });
  }));

  // Unsubscribe from a user's presence changes
  socket.on("unsubscribePresence", socketRateLimiter.wrap(socket, 'unsubscribePresence', (targetUserId: string) => {
    if (!targetUserId || typeof targetUserId !== 'string') return;
    socket.leave(`presence:${targetUserId}`);
  }));
});

// --- Expose namespaces for use in routes ---
app.set("io", io);
app.set("notificationsNamespace", notificationsNamespace);
app.set("postsNamespace", postsNamespace);

// --- Server Listen ---
const PORT = config.runtime.port;
const bootServer = async () => {
  validateEnvironment();
  markRuntimeNotReady('booting');
  // ONE store opens here, and it is Postgres. `getDb()` throws until this
  // resolves, so a task that skipped it would answer the health check and then
  // fail every query.
  //
  // Mongo used to open FIRST, on this line, on every task — so a web task could
  // not boot without it even though no runtime read or write had gone to Mongo
  // since the cutover. That connection went first, and the rest of the surface
  // (driver, models, the Mongo→Postgres copier) followed: there is no Mongo
  // left in this package for any entry point to open.
  await connectPostgres();

  // Production migrations run as a deployment one-shot with the exact image
  // that will be rolled out. Web tasks never mutate schema during a scale-out;
  // they only refuse readiness until that one-shot has completed.
  //
  // This assert is load-bearing rather than defence in depth: the drizzle
  // migrations are applied by the deploy's one-shot, and a task that boots
  // against a database that one-shot never reached becomes ready and then
  // fails every Postgres query — after traffic has been routed to it. Outside
  // production the migrator is a developer command (`bun run db:migrate`), so
  // there is nothing here to assert against.
  if (config.runtime.isProduction) {
    await assertPostgresMigrationsCurrent(getPostgresClient());
  }
  markMigrationsComplete();

  // Setup Redis adapter before accepting connections to ensure
  // cross-instance broadcasts work from the first connection
  await setupRedisAdapter();

  // Drop cached Oxy identity as soon as Oxy says it changed, instead of waiting
  // out the user-summary TTL. Runs on EVERY task: the SDK response caches it
  // sweeps are per-process, so a leader-only subscriber would leave the rest of
  // the fleet stale. Inert (and non-fatal) when Redis is unavailable.
  userInvalidationSubscriber = await startUserInvalidationSubscriber();

  // Start BullMQ federation queue workers on EVERY task (inbox + delivery
  // throughput should scale with the fleet; BullMQ delivers each job to exactly
  // one worker). No-op when Redis is not configured — federation then falls
  // back to inline inbox processing + the in-process delivery scheduler, which
  // drains the Postgres `federation_delivery_queue` table.
  // Periodic repeatable-job REGISTRATION is leader-only (FederationJobScheduler,
  // driven by leaderElection); only the consuming workers run everywhere.
  try {
    const { startWorkers } = require("./src/queue/workers");
    startWorkers();
  } catch (error) {
    logger.warn("Failed to start federation queue workers", error);
  }

  // Register MTN Protocol feed engine modules (sources / signals / filters)
  registerAllModules();

  // Lease-claimed workers may run on every task: the claim is an atomic Postgres
  // update and does not depend on Redis leadership, so committed engagement
  // effects keep draining even while Redis is degraded.
  engagementOutboxDispatcher.start();
  // Same reasoning for moderation: a report and its delivery event committed
  // together, and the lease-based claim means every task can drain the queue.
  // No-ops when CROWDSOURCE_ENABLED=false, leaving the durable rows for later.
  moderationOutboxDispatcher.start();

  // Singleton jobs start only after the schema is ready. Leader election fails
  // closed when Redis is unavailable, while the HTTP API can remain degraded.
  await leaderElection.start(startSchedulers, stopSchedulers);

  // Start server after all async setup is complete
  server.listen(PORT, '0.0.0.0', () => {
    markRuntimeReady();
    logger.info(`Server running at http://localhost:${PORT}`);
  });
};

// --- Graceful Shutdown ---
// ECS sends SIGTERM on task stop (and again SIGKILL after the stop timeout).
// Readiness is cleared and HTTP stops accepting immediately. Producers and
// workers then drain while Postgres/Redis are still available, and the scheduler
// leadership lock is released only after singleton schedulers have stopped.
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
  }, 10_000);
  hardTimeout.unref();

  void (async () => {
    presence.stopHousekeeping();

    const queueShutdown = async (): Promise<void> => {
      try {
        const { shutdownQueues } = require("./src/queue/workers");
        await shutdownQueues();
      } catch (error) {
        logger.error("Error shutting down federation queues", error);
      }
    };

    const socketShutdown = new Promise<void>((resolve) => {
      io.close(() => {
        clearRuntimeSocketServer(io);
        resolve();
      });
    });

    const invalidationShutdown = async (): Promise<void> => {
      if (!userInvalidationSubscriber) return;
      const handle = userInvalidationSubscriber;
      userInvalidationSubscriber = null;
      await handle.stop();
    };

    const pubSubShutdown = async (): Promise<void> => {
      if (!socketRedisClients) return;
      const { publisher, subscriber } = socketRedisClients;
      socketRedisClients = null;
      await Promise.allSettled([
        publisher.isOpen ? publisher.quit() : Promise.resolve(),
        subscriber.isOpen ? subscriber.quit() : Promise.resolve(),
      ]);
    };

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
      invalidationShutdown(),
      pubSubShutdown(),
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

if (require.main === module) {
  void bootServer().catch((error) => {
    markRuntimeNotReady('boot_failed');
    logger.error('Backend boot failed', error);
    process.exit(1);
  });
}

export { io, notificationsNamespace };
export default server;
