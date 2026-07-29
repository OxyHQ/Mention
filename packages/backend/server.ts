// --- Imports ---
import http from "http";
import mongoose from "mongoose";
import { hostname } from 'os';
import { connectToDatabase } from "./src/utils/database";
import { Server as SocketIOServer, Namespace } from "socket.io";
import { PUBLIC_REALTIME_NAMESPACE } from "@mention/shared-types";
import { logger, sanitizeLogValue } from "./src/utils/logger";
import { config, validateEnvironment } from './src/config';
import { isAllowedOrigin } from "./src/utils/allowedOrigins";
import { assertMigrationsApplied, runMigrations } from "./src/migrations/runner";
import { assertMongoTransactionalTopology } from "./src/utils/mongoTopology";
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
import { DistributedPresenceService } from './src/services/DistributedPresenceService';
import {
  registerSocketPresence,
  type AuthenticatedPresenceSocket as AuthenticatedSocket,
} from './src/services/SocketPresenceLifecycle';
import { engagementOutboxDispatcher } from './src/services/EngagementOutboxDispatcher';
import { moderationOutboxDispatcher } from './src/services/moderation/ModerationOutboxDispatcher';

// Models
import Notification from "./src/models/Notification";
import {
  clearRuntimeSocketServer,
  setRuntimeSocketServer,
} from './src/runtime/socketServer';

// MTN Protocol
import { registerAllModules } from './src/mtn/feed/engine';
import { createRuntimeApp } from './src/runtimeApp';

// --- Global Error Handlers ---
// Register before bootstrap starts any asynchronous work. Imports must finish
// first so the sanitizer and validated configuration bindings are initialized
// when a handler runs.
process.on('unhandledRejection', (reason: unknown, _promise: Promise<unknown>) => {
  // Keep this fallback independent from the logger transport, but sanitize the
  // payload with the same central policy before writing it.
  console.error('Unhandled promise rejection', sanitizeLogValue(reason));
  // In production, exit to let the process manager restart cleanly
  if (config.runtime.isProduction) {
    process.exit(1);
  }
});

process.on('uncaughtException', (error: Error) => {
  console.error('Uncaught exception', sanitizeLogValue(error));
  // Always exit on uncaught exceptions — the process state is unreliable
  process.exit(1);
});

export const { app, oxy } = createRuntimeApp();

// --- Sockets ---
const server = http.createServer(app);

// Presence tracking - Map of userId to Set of socket IDs (user can have multiple connections)
const onlineUsers = new Map<string, Set<string>>();
const distributedPresence = new DistributedPresenceService(
  getRedisClient,
  `${hostname()}:${process.pid}`,
);

// Helper to check if user is online
const isUserOnline = (userId: string): boolean => {
  const sockets = onlineUsers.get(userId);
  return sockets !== undefined && sockets.size > 0;
};

// Helper to broadcast user online status
const broadcastPresence = (io: SocketIOServer, userId: string, online: boolean) => {
  const presenceData = { userId, online, timestamp: new Date().toISOString() };
  // Emit to users subscribed to this user's presence
  io.to(`presence:${userId}`).emit('user:presence', presenceData);
  // Targeted emit only — no global broadcast
};

// Periodic cleanup of stale online user entries (every 5 minutes)
// Validates that tracked socket IDs are still actually connected to the server
const presenceCleanupInterval = setInterval(() => {
  let cleanedUsers = 0;
  let cleanedSockets = 0;
  for (const [userId, sockets] of onlineUsers.entries()) {
    // Remove socket IDs that are no longer connected
    for (const socketId of sockets) {
      const activeSocket = io.sockets.sockets.get(socketId);
      if (!activeSocket || !activeSocket.connected) {
        sockets.delete(socketId);
        cleanedSockets++;
      }
    }
    // Remove user entry if no valid sockets remain
    if (sockets.size === 0) {
      onlineUsers.delete(userId);
      void distributedPresence.markOffline(userId).then(async () => {
        if (!await distributedPresence.isOnline(userId, false)) {
          broadcastPresence(io, userId, false);
        }
      });
      cleanedUsers++;
    }
  }
  if (cleanedUsers > 0 || cleanedSockets > 0) {
    logger.debug(`Presence cleanup: removed ${cleanedSockets} stale sockets, ${cleanedUsers} users now offline`);
  }
}, 5 * 60 * 1000);
// Never keep the event loop (or a test run) alive solely for this housekeeping timer.
presenceCleanupInterval.unref?.();

const presenceHeartbeatInterval = setInterval(() => {
  void distributedPresence.heartbeat(onlineUsers.keys());
}, 30_000);
presenceHeartbeatInterval.unref?.();

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

  socket.on("error", (error: Error) => {
    logger.error("Notifications socket error", error);
  });

  socket.on("markNotificationRead", socketRateLimiter.wrap(socket, 'markNotificationRead', async ({ notificationId }: { notificationId?: string }) => {
    try {
      if (!socket.user?.id) return;
      const notification = await Notification.findOneAndUpdate(
        { _id: notificationId, recipientId: userId },
        { read: true },
        { new: true }
      ).populate("actorId", "username name avatar");
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
      await Notification.updateMany({ recipientId: userId }, { read: true });
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

function registerContentRoomHandlers(socket: AuthenticatedSocket): void {
  socket.on("joinPost", socketRateLimiter.wrap(socket, 'joinPost', (postId: string) => {
    if (!postId || typeof postId !== 'string') return;
    socket.join(`post:${postId}`);
  }));

  socket.on("leavePost", socketRateLimiter.wrap(socket, 'leavePost', (postId: string) => {
    if (!postId || typeof postId !== 'string') return;
    socket.leave(`post:${postId}`);
  }));

  socket.on("joinFeed", socketRateLimiter.wrap(socket, 'joinFeed', (data: { feedType?: string }) => {
    const feedType = data?.feedType;
    if (feedType && typeof feedType === 'string') {
      socket.join(`feed:${feedType}`);
    }
    const selfId = socket.user?.id;
    if (selfId) socket.join(`feed:user:${selfId}`);
  }));

  socket.on("leaveFeed", socketRateLimiter.wrap(socket, 'leaveFeed', (data: { feedType?: string }) => {
    const feedType = data?.feedType;
    if (feedType && typeof feedType === 'string') {
      socket.leave(`feed:${feedType}`);
    }
    const selfId = socket.user?.id;
    if (selfId) socket.leave(`feed:user:${selfId}`);
  }));
}

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
  registerContentRoomHandlers(socket);

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
    onlineUsers,
    distributedPresence,
    broadcastPresence: (presenceUserId, online) => {
      broadcastPresence(io, presenceUserId, online);
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
  registerContentRoomHandlers(socket);

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
    const online = await distributedPresence.isOnline(
      targetUserId,
      isUserOnline(targetUserId),
    );
    if (typeof callback === 'function') {
      callback({ online });
    } else {
      socket.emit('user:presence', { userId: targetUserId, online });
    }
  }));

  // Get online status of multiple users
  socket.on("getPresenceBulk", socketRateLimiter.wrap(socket, 'getPresenceBulk', async (userIds: string[], callback?: (data: Record<string, boolean>) => void) => {
    const result = Array.isArray(userIds)
      ? await distributedPresence.getBulk(userIds, isUserOnline)
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
    const online = await distributedPresence.isOnline(
      targetUserId,
      isUserOnline(targetUserId),
    );
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

// --- MongoDB Connection ---
const db = mongoose.connection;
let hasLoggedMongoError = false;
db.on("error", (error: Error & { code?: string; syscall?: string }) => {
  // Only log connection errors once to reduce spam
  if (error.code === 'ECONNREFUSED' || error.syscall === 'querySrv') {
    // Connection errors are already logged by connectToDatabase retry logic
    // Don't log them again here to avoid duplicate messages
    if (!hasLoggedMongoError) {
      hasLoggedMongoError = true;
      logger.debug("MongoDB connection error:", error.message);
    }
  } else {
    logger.error("MongoDB connection error", error);
  }
});

// Reset error flag and load models on successful connection.
// Note: connectToDatabase() in src/utils/database.ts already logs the success message.
db.once("open", () => {
  hasLoggedMongoError = false;

  // Load models
  require("./src/models/Post");
  require("./src/models/UserBehavior"); // Load UserBehavior model
});

/**
 * Start all in-process schedulers. Invoked by LeaderElection ONLY on the task
 * that holds the scheduler leadership lock. Redis failure pauses all singleton
 * schedulers; the HTTP API may degrade, but no task self-elects without a
 * lease. Each service logs its own startup status.
 */
function startSchedulers(): void {
  // Feed job scheduler
  try {
    const { feedJobScheduler } = require("./src/services/FeedJobScheduler");
    feedJobScheduler.start();
  } catch (error) {
    logger.warn("Failed to start feed job scheduler", error);
  }

  // Trending Service (30-min calculation interval)
  try {
    const { trendingService } = require("./src/services/TrendingService");
    trendingService.initialize();
  } catch (error) {
    logger.warn("Failed to initialize trending service", error);
  }

  // Post Classification Service (5-min interval; no-ops unless enabled + Alia configured)
  try {
    const { postClassificationService } = require("./src/services/PostClassificationService");
    postClassificationService.start();
  } catch (error) {
    logger.warn("Failed to start post classification service", error);
  }

  // Topic Service (daily AI enrichment of topic metadata)
  try {
    const { topicService } = require("./src/services/TopicService");
    topicService.start();
  } catch (error) {
    logger.warn("Failed to initialize topic service", error);
  }

  // Federation Job Scheduler (also owns the media-cache worker + eviction jobs)
  try {
    const { federationJobScheduler } = require("./src/services/FederationJobScheduler");
    federationJobScheduler.start();
  } catch (error) {
    logger.warn("Failed to start federation job scheduler", error);
  }

  // MTN Node Scheduler (B3 bidirectional node sync: leader-gated liveness probes
  // + ingest of pull nodes / export to push nodes). Background only — NEVER on a
  // request path; the feed/hydration hot path never queries a node.
  try {
    const { mentionNodeScheduler } = require("./src/services/mtn/MentionNodeScheduler");
    mentionNodeScheduler.start();
  } catch (error) {
    logger.warn("Failed to start MTN node scheduler", error);
  }

  // Follower Snapshot Job (leader-gated + env-gated on REDIS_URL): samples
  // follower counts for active authors, powering the `risingCreators` feed
  // source's follower-growth delta. Timers are unref'd; inline no-op without Redis.
  try {
    const { followerSnapshotJob } = require("./src/services/followerSnapshotJob");
    followerSnapshotJob.start();
  } catch (error) {
    logger.warn("Failed to start follower snapshot job", error);
  }

  // CrowdSource reconciliation (leader-gated, env-gated on CROWDSOURCE_ENABLED):
  // finds reports whose durable delivery event is missing or dead-lettered. The
  // outbox DISPATCHER runs on every task (Mongo-leased); this sweep scans the whole
  // collection, so one task is enough.
  try {
    const { moderationReconciliationJob } = require("./src/services/moderation/ModerationReconciliationJob");
    moderationReconciliationJob.start();
  } catch (error) {
    logger.warn("Failed to start moderation reconciliation job", error);
  }
}

/**
 * Stop all in-process schedulers. Invoked by LeaderElection when this task
 * loses leadership (another task took over) or during graceful shutdown.
 * Each stop is isolated so one failure does not prevent stopping the rest.
 *
 * NOTE: FeedSeenPostsService's in-memory cleanup interval is intentionally NOT
 * stopped here — it is per-process memory hygiene for a request-time fallback
 * cache, not a shared cron job, so every task (leader or not) must keep it.
 */
function stopSchedulers(): void {
  try {
    const { feedJobScheduler } = require("./src/services/FeedJobScheduler");
    feedJobScheduler.stop();
  } catch (error) {
    logger.warn("Failed to stop feed job scheduler", error);
  }

  try {
    const { trendingService } = require("./src/services/TrendingService");
    trendingService.cleanup();
  } catch (error) {
    logger.warn("Failed to stop trending service", error);
  }

  try {
    const { postClassificationService } = require("./src/services/PostClassificationService");
    postClassificationService.stop();
  } catch (error) {
    logger.warn("Failed to stop post classification service", error);
  }

  try {
    const { topicService } = require("./src/services/TopicService");
    topicService.stop();
  } catch (error) {
    logger.warn("Failed to stop topic service", error);
  }

  try {
    const { federationJobScheduler } = require("./src/services/FederationJobScheduler");
    federationJobScheduler.stop();
  } catch (error) {
    logger.warn("Failed to stop federation job scheduler", error);
  }

  try {
    const { mentionNodeScheduler } = require("./src/services/mtn/MentionNodeScheduler");
    mentionNodeScheduler.stop();
  } catch (error) {
    logger.warn("Failed to stop MTN node scheduler", error);
  }

  try {
    const { followerSnapshotJob } = require("./src/services/followerSnapshotJob");
    followerSnapshotJob.stop();
  } catch (error) {
    logger.warn("Failed to stop follower snapshot job", error);
  }

  try {
    const { moderationReconciliationJob } = require("./src/services/moderation/ModerationReconciliationJob");
    moderationReconciliationJob.stop();
  } catch (error) {
    logger.warn("Failed to stop moderation reconciliation job", error);
  }
}

// --- Server Listen ---
const PORT = config.runtime.port;
const bootServer = async () => {
  validateEnvironment();
  markRuntimeNotReady('booting');
  await connectToDatabase();

  // Production migrations run as a deployment one-shot with the exact image
  // that will be rolled out. Web tasks never mutate schema during a scale-out;
  // they only refuse readiness until that one-shot has completed. The one-shot
  // is the primary topology barrier; this startup check is defense in depth if
  // a task is launched outside the normal deployment workflow. It is not run in
  // the readiness endpoint, avoiding a Mongo command on every health probe.
  if (config.runtime.isProduction) {
    await assertMongoTransactionalTopology();
    await assertMigrationsApplied();
  } else {
    await runMigrations();
  }
  markMigrationsComplete();

  // Setup Redis adapter before accepting connections to ensure
  // cross-instance broadcasts work from the first connection
  await setupRedisAdapter();

  // Start BullMQ federation queue workers on EVERY task (inbox + delivery
  // throughput should scale with the fleet; BullMQ delivers each job to exactly
  // one worker). No-op when Redis is not configured — federation then falls
  // back to inline inbox processing + the in-process Mongo delivery scheduler.
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

  // Mongo-leased workers may run on every task: claims are atomic and do not
  // depend on Redis leadership, so committed engagement effects keep draining
  // even while Redis is degraded.
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
// workers then drain while Mongo/Redis are still available, and the scheduler
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
    clearInterval(presenceCleanupInterval);
    clearInterval(presenceHeartbeatInterval);

    const presenceShutdown = async (): Promise<void> => {
      await Promise.allSettled(
        [...onlineUsers.keys()].map((userId) => distributedPresence.markOffline(userId)),
      );
      onlineUsers.clear();
    };

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

    const pubSubShutdown = async (): Promise<void> => {
      if (!socketRedisClients) return;
      const { publisher, subscriber } = socketRedisClients;
      socketRedisClients = null;
      await Promise.allSettled([
        publisher.isOpen ? publisher.quit() : Promise.resolve(),
        subscriber.isOpen ? subscriber.quit() : Promise.resolve(),
      ]);
    };

    await presenceShutdown();
    // Stop every producer/worker while Redis and Mongo are still available.
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
      pubSubShutdown(),
      closeRedisConnection(),
      mongoose.disconnect(),
    ]);

    clearTimeout(hardTimeout);
    logger.info('HTTP, sockets, queues, Redis, and MongoDB closed');
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
