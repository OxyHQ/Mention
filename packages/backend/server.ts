// --- Config ---
// CRITICAL: Load environment variables FIRST, before any other imports
// Use require() so it executes immediately, before ES6 imports are processed
// This ensures REDIS_URL and other env vars are available when modules are imported
require('dotenv').config();

// --- Global Error Handlers ---
// Must be registered early, before any async work begins
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  // Use console.error as a fallback since logger may not be initialized yet
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error(`Unhandled promise rejection: ${message}`);
  // In production, exit to let the process manager restart cleanly
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  }
});

process.on('uncaughtException', (error: Error) => {
  console.error(`Uncaught exception: ${error.stack || error.message}`);
  // Always exit on uncaught exceptions — the process state is unreliable
  process.exit(1);
});

// --- Imports ---
import express from "express";
import http from "http";
import mongoose from "mongoose";
import compression from "compression";
import { connectToDatabase, isDatabaseConnected } from "./src/utils/database";
import { Server as SocketIOServer, Socket, Namespace } from "socket.io";
import { logger } from "./src/utils/logger";

// Models
import { Post } from "./src/models/Post";
import Notification from "./src/models/Notification";

// Routers
import postsRouter from "./src/routes/posts";
import notificationsRouter from "./src/routes/notifications";
import listsRoutes from "./src/routes/lists";
import hashtagsRoutes from "./src/routes/hashtags";
import searchRoutes from "./src/routes/search";
import analyticsRoutes from "./src/routes/analytics.routes";
import feedRoutes from './src/routes/feed.routes';
import pollsRoutes from './src/routes/polls';
import customFeedsRoutes from './src/routes/customFeeds.routes';
import statisticsRoutes from './src/routes/statistics.routes';
import { OxyServices } from '@oxyhq/core';
import testRoutes from "./src/routes/test";
import profileSettingsRoutes from './src/routes/profileSettings';
import profileDesignRoutes from './src/routes/profileDesign';
import subscriptionsRoutes from './src/routes/subscriptions';
import gifsRoutes from './src/routes/gifs';
import articlesRoutes from './src/routes/articles';
import imagesRoutes from './src/routes/images';
import linksRoutes from './src/routes/links';
import followsRoutes from './src/routes/follows';
import muteRoutes from './src/routes/mute.routes';
import reportsRoutes from './src/routes/reports.routes';
import trendingRoutes from './src/routes/trending.routes';
import spacesRoutes from './src/routes/spaces.routes';

// Middleware
import { rateLimiter, bruteForceProtection } from "./src/middleware/security";
import { feedRateLimiter } from "./src/middleware/rateLimiter";

const app = express();

// Enable trust proxy for proper IP handling (required for rate limiting with IPv6)
// This ensures req.ip is properly set when behind a proxy/load balancer
app.set('trust proxy', true);

export const oxy = new OxyServices({ baseURL: process.env.OXY_API_URL || 'https://api.oxy.so' });


// --- Middleware ---
// Response compression - compress responses > 1KB
app.use(compression({
  filter: (req, res) => {
    // Don't compress if client doesn't support it
    if (req.headers['x-no-compression']) {
      return false;
    }
    // Use compression filter function
    return compression.filter(req, res);
  },
  level: 6, // Compression level (0-9, 6 is a good balance)
  threshold: 1024, // Only compress responses > 1KB
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware to parse nested query parameters (e.g., filters[authors]=user1,user2)
app.use((req, res, next) => {
  if (req.query && typeof req.query === 'object') {
    const filters: any = {};
    Object.keys(req.query).forEach(key => {
      const match = key.match(/^filters\[(.+)\]$/);
      if (match) {
        const filterKey = match[1];
        if (!filters[filterKey]) {
          filters[filterKey] = req.query[key];
        }
      }
    });
    if (Object.keys(filters).length > 0) {
      (req.query as any).filters = filters;
    }
  }
  next();
});

app.use(async (req, res, next) => {
  // Try to ensure database connection, but don't block requests if it fails
  try {
    await connectToDatabase();
  } catch (error) {
    // Database unavailable - log once but allow request to continue
    // Individual operations will handle database errors gracefully
    logger.debug("MongoDB connection unavailable for request");
  }
  next();
});

// CORS and security headers
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL || "https://mention.earth",
  "http://localhost:8081",
  "http://localhost:8082",
  "http://192.168.86.44:8081",
] as const;

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin as typeof ALLOWED_ORIGINS[number])) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (process.env.FRONTEND_URL) {
    res.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND_URL);
  }
  // In production, don't set Access-Control-Allow-Origin for unknown origins (no wildcard fallback)
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Date, X-Api-Version");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

// --- Sockets ---
const server = http.createServer(app);

interface AuthenticatedSocket extends Socket {
  user?: { id: string; [key: string]: any };
}

// Presence tracking - Map of userId to Set of socket IDs (user can have multiple connections)
const onlineUsers = new Map<string, Set<string>>();

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
  // Also emit globally for profile pages etc.
  io.emit('user:presence', presenceData);
};

// Periodic cleanup of stale online user entries (every 5 minutes)
setInterval(() => {
  const staleThreshold = Date.now() - 5 * 60 * 1000;
  let cleanedCount = 0;
  for (const [userId, sockets] of onlineUsers.entries()) {
    // Remove entries with empty socket sets
    if (sockets.size === 0) {
      onlineUsers.delete(userId);
      cleanedCount++;
    }
  }
  if (cleanedCount > 0) {
    logger.debug(`Cleaned ${cleanedCount} stale entries from onlineUsers map`);
  }
}, 5 * 60 * 1000);

type DisconnectReason =
  | "server disconnect" | "client disconnect" | "transport close" | "transport error" | "ping timeout" | "parse error" | "forced close" | "forced server close" | "server shutting down" | "client namespace disconnect" | "server namespace disconnect" | "unknown transport";

interface SocketError extends Error { description?: string; context?: any; }

import { config, validateEnvironment } from './src/config';
import { createSocketRateLimiter } from './src/middleware/socketRateLimit';

// Validate environment on startup
validateEnvironment();

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
    origin: [process.env.FRONTEND_URL || "https://mention.earth", "http://localhost:8081", "http://localhost:8082"],
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

// Setup Redis adapter for Socket.IO horizontal scaling
// Note: @socket.io/redis-adapter v8+ supports node-redis
async function setupRedisAdapter(): Promise<void> {
  try {
    const { createRedisPubSub } = require('./src/utils/redis');
    const { createAdapter } = require('@socket.io/redis-adapter');
    const { ensureRedisConnected } = require('./src/utils/redisHelpers');
    const { publisher, subscriber } = createRedisPubSub();

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
    const publisherReady = await ensureRedisConnected(publisher);
    const subscriberReady = await ensureRedisConnected(subscriber);

    if (!publisherReady || !subscriberReady) {
      throw new Error('Redis clients connected but not ready');
    }

    // Verify with ping to ensure connection is actually working
    await Promise.all([
      publisher.ping(),
      subscriber.ping()
    ]);

    io.adapter(createAdapter(publisher, subscriber));
    logger.info('Socket.IO Redis adapter configured for horizontal scaling');
  } catch (error: unknown) {
    // If Redis is unavailable, continue without adapter (single-instance mode)
    const { isRedisConnectionError } = require('./src/utils/redisHelpers');
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

// Import and initialize spaces socket namespace
import { initializeSpaceSocket } from './src/sockets/spaceSocket';
const spacesNamespace = initializeSpaceSocket(io);

// --- Socket Auth Middleware ---
// Authenticate socket connections using JWT token or userId from handshake
[notificationsNamespace, postsNamespace, spacesNamespace, io].forEach((namespaceOrServer: any) => {
  if (namespaceOrServer && typeof namespaceOrServer.use === "function") {
    namespaceOrServer.use(async (socket: AuthenticatedSocket, next: (err?: any) => void) => {
      try {
        const auth = socket.handshake?.auth as any;
        const token = auth?.token;

        // Try JWT verification first if token is provided
        if (token && typeof token === 'string') {
          try {
            const jwt = require('jsonwebtoken');
            const jwtSecret = process.env.JWT_SECRET || process.env.OXY_JWT_SECRET;
            if (!jwtSecret) {
              logger.warn('JWT_SECRET not configured - rejecting token authentication');
              return next();
            }
            const decoded = jwt.verify(token, jwtSecret);
            const userId = decoded?.userId || decoded?.id || decoded?.sub;
            if (userId && typeof userId === 'string') {
              socket.user = { id: userId };
              return next();
            }
          } catch (jwtError) {
            logger.debug('Socket JWT verification failed, falling back to userId auth');
          }
        }

        // Fallback: accept userId from client handshake (for backward compatibility)
        const userId = auth?.userId || auth?.id || auth?.user?.id;
        if (userId && typeof userId === "string") {
          socket.user = { id: userId };
        }
      } catch (_) {
        // ignore – will be handled by connection handlers if user missing
      }
      return next();
    });
  }
});

// --- Socket Namespace Config ---

// Configure notifications namespace
notificationsNamespace.on("connection", (socket: AuthenticatedSocket) => {
  logger.info(
    `Client connected to notifications namespace from ip: ${socket.handshake.address}`
  );

  if (!socket.user?.id) {
    logger.warn("Unauthenticated client attempted to connect to notifications namespace");
    socket.disconnect(true);
    return;
  }

  const userRoom = `user:${socket.user.id}`;
  const userId = socket.user.id;
  socket.join(userRoom);
  logger.debug(`Client ${socket.id} joined notification room: ${userRoom}`);

  socket.on("error", (error: Error) => {
    logger.error("Notifications socket error", error);
  });

  socket.on("markNotificationRead", socketRateLimiter.wrap(socket, 'markNotificationRead', async ({ notificationId }) => {
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

  socket.on("disconnect", (reason: DisconnectReason, description?: any) => {
    socketRateLimiter.cleanup(socket.id);
    logger.debug(
      `Client ${socket.id} disconnected from notifications namespace: ${reason}${description ? ` - ${description}` : ""}`
    );
    socket.leave(userRoom);
  });
});

// Configure postsNamespace events
postsNamespace.on("connection", (socket: AuthenticatedSocket) => {
  logger.info(`Client connected to posts namespace from ip: ${socket.handshake.address}`);

  if (!socket.user?.id) {
    logger.warn("Unauthenticated client attempted to connect to posts namespace");
    socket.disconnect(true);
    return;
  }

  socket.on("error", (error: Error) => {
    logger.error("Posts socket error", error);
  });

  socket.on("joinPost", socketRateLimiter.wrap(socket, 'joinPost', (postId: string) => {
    if (!postId || typeof postId !== 'string') return;
    const room = `post:${postId}`;
    socket.join(room);
    logger.debug(`Client ${socket.id} joined post room: ${room}`);
  }));

  socket.on("leavePost", socketRateLimiter.wrap(socket, 'leavePost', (postId: string) => {
    if (!postId || typeof postId !== 'string') return;
    const room = `post:${postId}`;
    socket.leave(room);
    logger.debug(`Client ${socket.id} left post room: ${room}`);
  }));

  // Join feed room for real-time updates (posts namespace)
  socket.on("joinFeed", socketRateLimiter.wrap(socket, 'joinFeed', (data: { feedType?: string; userId?: string }) => {
    const { feedType, userId } = data || {};
    if (feedType && typeof feedType === 'string') {
      socket.join(`feed:${feedType}`);
    }
    if (userId && typeof userId === 'string') {
      socket.join(`feed:user:${userId}`);
    }
  }));

  // Leave feed room (posts namespace)
  socket.on("leaveFeed", socketRateLimiter.wrap(socket, 'leaveFeed', (data: { feedType?: string; userId?: string }) => {
    const { feedType, userId } = data || {};
    if (feedType && typeof feedType === 'string') {
      socket.leave(`feed:${feedType}`);
    }
    if (userId && typeof userId === 'string') {
      socket.leave(`feed:user:${userId}`);
    }
  }));

  socket.on("disconnect", (reason: DisconnectReason) => {
    socketRateLimiter.cleanup(socket.id);
    logger.debug(`Client ${socket.id} disconnected from posts namespace: ${reason}`);
  });
});

// Apply verification middleware to all namespaces
[
  notificationsNamespace,
  postsNamespace,
  spacesNamespace
].forEach((namespace) => {
  configureNamespaceErrorHandling(namespace);
});

// Configure main namespace with enhanced error handling
io.on("connection", (socket: AuthenticatedSocket) => {
  logger.info(`Client connected from ip: ${socket.handshake.address}`);

  // Track user presence
  const userId = socket.user?.id;
  if (userId) {
    const wasOnline = isUserOnline(userId);
    if (!onlineUsers.has(userId)) {
      onlineUsers.set(userId, new Set());
    }
    onlineUsers.get(userId)!.add(socket.id);

    // Join user-specific room for targeted events
    socket.join(`user:${userId}`);

    // Broadcast online status if user just came online (first connection)
    if (!wasOnline) {
      broadcastPresence(io, userId, true);
      logger.debug(`User ${userId} is now online`);
    }
  }

  // Enhanced error handling
  socket.on("error", (error: Error) => {
    logger.error("Socket error", error);
    // Attempt to reconnect on error
    if (socket.connected) {
      socket.disconnect();
    }
  });

  socket.on("disconnect", (reason: DisconnectReason, description?: any) => {
    socketRateLimiter.cleanup(socket.id);
    logger.debug(`Client disconnected: ${reason}${description ? ` - ${description}` : ""}`);

    // Track user presence on disconnect
    if (userId) {
      const userSockets = onlineUsers.get(userId);
      if (userSockets) {
        userSockets.delete(socket.id);
        // If user has no more connections, they're offline
        if (userSockets.size === 0) {
          onlineUsers.delete(userId);
          broadcastPresence(io, userId, false);
          logger.debug(`User ${userId} is now offline`);
        }
      }
    }

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

  socket.on("joinPost", socketRateLimiter.wrap(socket, 'joinPost', (postId: string) => {
    if (!postId || typeof postId !== 'string') return;
    const room = `post:${postId}`;
    socket.join(room);
    logger.debug(`Client ${socket.id} joined room: ${room}`);
  }));

  socket.on("leavePost", socketRateLimiter.wrap(socket, 'leavePost', (postId: string) => {
    if (!postId || typeof postId !== 'string') return;
    const room = `post:${postId}`;
    socket.leave(room);
    logger.debug(`Client ${socket.id} left room: ${room}`);
  }));

  // Join feed room for real-time updates
  socket.on("joinFeed", socketRateLimiter.wrap(socket, 'joinFeed', (data: { feedType?: string; userId?: string }) => {
    const { feedType, userId: feedUserId } = data || {};
    if (feedType && typeof feedType === 'string') {
      const room = `feed:${feedType}`;
      socket.join(room);
      logger.debug(`Client ${socket.id} joined feed room: ${room}`);
    }
    if (feedUserId && typeof feedUserId === 'string') {
      const userRoom = `feed:user:${feedUserId}`;
      socket.join(userRoom);
      logger.debug(`Client ${socket.id} joined user feed room: ${userRoom}`);
    }
  }));

  // Leave feed room
  socket.on("leaveFeed", socketRateLimiter.wrap(socket, 'leaveFeed', (data: { feedType?: string; userId?: string }) => {
    const { feedType, userId: feedUserId } = data || {};
    if (feedType && typeof feedType === 'string') {
      const room = `feed:${feedType}`;
      socket.leave(room);
      logger.debug(`Client ${socket.id} left feed room: ${room}`);
    }
    if (feedUserId && typeof feedUserId === 'string') {
      const userRoom = `feed:user:${feedUserId}`;
      socket.leave(userRoom);
      logger.debug(`Client ${socket.id} left user feed room: ${userRoom}`);
    }
  }));

  // Get online status of a single user
  socket.on("getPresence", socketRateLimiter.wrap(socket, 'getPresence', (targetUserId: string, callback?: (data: { online: boolean }) => void) => {
    if (!targetUserId || typeof targetUserId !== 'string') return;
    const online = isUserOnline(targetUserId);
    if (typeof callback === 'function') {
      callback({ online });
    } else {
      socket.emit('user:presence', { userId: targetUserId, online });
    }
  }));

  // Get online status of multiple users
  socket.on("getPresenceBulk", socketRateLimiter.wrap(socket, 'getPresenceBulk', (userIds: string[], callback?: (data: Record<string, boolean>) => void) => {
    const result: Record<string, boolean> = {};
    if (Array.isArray(userIds)) {
      // Cap bulk queries to prevent abuse
      const safeIds = userIds.slice(0, 100);
      safeIds.forEach(id => {
        if (typeof id === 'string') result[id] = isUserOnline(id);
      });
    }
    if (typeof callback === 'function') {
      callback(result);
    } else {
      socket.emit('user:presenceBulk', result);
    }
  }));

  // Subscribe to a user's presence changes
  socket.on("subscribePresence", socketRateLimiter.wrap(socket, 'subscribePresence', (targetUserId: string) => {
    if (!targetUserId || typeof targetUserId !== 'string') return;
    socket.join(`presence:${targetUserId}`);
    socket.emit('user:presence', { userId: targetUserId, online: isUserOnline(targetUserId) });
  }));

  // Unsubscribe from a user's presence changes
  socket.on("unsubscribePresence", socketRateLimiter.wrap(socket, 'unsubscribePresence', (targetUserId: string) => {
    if (!targetUserId || typeof targetUserId !== 'string') return;
    socket.leave(`presence:${targetUserId}`);
  }));
});

// Enhanced error handling for namespaces
[notificationsNamespace, postsNamespace, spacesNamespace].forEach(
  (namespace: Namespace) => {
    namespace.on("connection_error", (error: Error) => {
      logger.error(`Namespace ${namespace.name} connection error`, error);
    });

    namespace.on("connect_error", (error: SocketError) => {
      logger.error(`${namespace.name}: Connect error`, error);
      // Log detailed error info
      if (error.description) {
        logger.error("Error description", error.description);
      }
      if (error.context) {
        logger.error("Error context", error.context);
      }
    });

    namespace.on("connect_timeout", () => {
      logger.warn(`${namespace.name}: Connect timeout`);
    });
  }
);

// --- Expose namespaces for use in routes ---
app.set("io", io);
// Expose io globally for utility modules that emit without direct access to req/app
// Using any-cast to avoid augmenting global types across the project
(global as any).io = io;
app.set("notificationsNamespace", notificationsNamespace);
app.set("postsNamespace", postsNamespace);

// --- Optional Auth Middleware ---
// Tries to authenticate but doesn't fail if no token is provided
const optionalAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Check if Authorization header exists
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    // No auth header, continue as unauthenticated
    logger.debug("Optional auth: No authorization header, continuing as unauthenticated");
    return next();
  }
  
  // Try to authenticate if header exists
  const authMiddleware = oxy.auth();
  authMiddleware(req, res, (err?: any) => {
    if (err) {
      // Auth failed (invalid token, expired, etc.), but continue anyway
      logger.debug(`Optional auth: Authentication failed, continuing as unauthenticated: ${err?.message || "Unknown error"}`);
      // Clear any partial user data that might have been set
      (req as any).user = undefined;
    }
    // Always continue the request chain
    next();
  });
};

// --- API ROUTES ---
// Public API routes (no authentication required)
const publicApiRouter = express.Router();
publicApiRouter.use("/hashtags", hashtagsRoutes);
// Move polls under authenticated router so req.user is available for create/vote
// If you want public GET access later, split the router or add a public shim.
// publicApiRouter.use("/polls", pollsRoutes);
// Debug route removed for production

// Feed routes with optional authentication (allow unauthenticated access for GET routes)
// POST/PUT/DELETE routes in feedRoutes require authentication
publicApiRouter.use("/feed", optionalAuth, feedRoutes);

// Public profile endpoints
// GET /api/profile/design/:userId - public profile design data (no auth required)
publicApiRouter.use("/profile/design", profileDesignRoutes);
publicApiRouter.use("/articles", articlesRoutes);
publicApiRouter.use("/images", imagesRoutes); // Image optimization (public, rate-limited)
publicApiRouter.use("/links", optionalAuth, linksRoutes); // Link metadata (optional auth for tracking)
publicApiRouter.use("/trending", trendingRoutes); // Trending topics (no auth required)

// Authenticated API routes (require authentication)
const authenticatedApiRouter = express.Router();
// Note: The feed routes that require auth (like, save, repost, etc.) are in feedRoutes
// They're protected by the oxy.auth() middleware applied to authenticatedApiRouter
authenticatedApiRouter.use("/posts", postsRouter); // All post routes require authentication
authenticatedApiRouter.use("/lists", listsRoutes);
authenticatedApiRouter.use("/notifications", notificationsRouter);
authenticatedApiRouter.use("/analytics", analyticsRoutes);
authenticatedApiRouter.use("/statistics", statisticsRoutes);
authenticatedApiRouter.use("/search", searchRoutes);
authenticatedApiRouter.use("/feeds", customFeedsRoutes); // User-created feeds
authenticatedApiRouter.use("/polls", pollsRoutes); // Polls now require authentication
authenticatedApiRouter.use("/test", testRoutes);
authenticatedApiRouter.use("/profile", profileSettingsRoutes);
authenticatedApiRouter.use("/subscriptions", subscriptionsRoutes);
authenticatedApiRouter.use("/gifs", gifsRoutes);
authenticatedApiRouter.use("/follows", followsRoutes);
authenticatedApiRouter.use("/mute", muteRoutes);
authenticatedApiRouter.use("/reports", reportsRoutes);
authenticatedApiRouter.use("/spaces", spacesRoutes);
// You can add more protected routers here as needed

// Mount public and authenticated API routers
app.use("/api", publicApiRouter);
app.use("/api", oxy.auth(), authenticatedApiRouter);

// Performance monitoring middleware
import { performanceMiddleware } from "./src/middleware/performance";
app.use(performanceMiddleware);

// --- Root API Welcome Route ---
app.get("", async (req, res) => {
  try {
    const postsCount = await Post.countDocuments();
    res.json({ message: "Welcome to the API", posts: postsCount });
  } catch (error) {
    logger.error("Error fetching stats for root route", error);
    res.status(500).json({ message: "Error fetching stats", error });
  }
});

// --- Health Check Endpoint ---
app.get("/health", async (req, res) => {
  try {
    const { isDatabaseConnected, getDatabaseStats } = require("./src/utils/database");
    const { isRedisConnected, getRedisStats } = require("./src/utils/redis");
    const { getPerformanceStats } = require("./src/middleware/performance");

    const [dbConnected, redisConnected] = await Promise.all([
      isDatabaseConnected(),
      isRedisConnected(),
    ]);

    const dbStats = getDatabaseStats();
    const redisStats = getRedisStats();
    const perfStats = getPerformanceStats();

    const health = {
      status: dbConnected && redisConnected ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      services: {
        database: {
          connected: dbConnected,
          ...dbStats,
        },
        redis: {
          connected: redisConnected,
          ...redisStats,
        },
      },
      performance: perfStats,
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      uptime: Math.round(process.uptime()),
    };

    const statusCode = health.status === "healthy" ? 200 : 503;
    res.status(statusCode).json(health);
  } catch (error) {
    logger.error("Health check failed:", error);
    res.status(503).json({
      status: "unhealthy",
      error: error instanceof Error ? error.message : "Unknown error",
      timestamp: new Date().toISOString(),
    });
  }
});

// --- MongoDB Connection ---
const db = mongoose.connection;
let hasLoggedMongoError = false;
db.on("error", (error: any) => {
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

// Reset error flag on successful connection
db.once("open", () => {
  hasLoggedMongoError = false;
});
db.once("open", () => {
  logger.info("Connected to MongoDB successfully");
  // Load models
  require("./src/models/Post"); 
  require("./src/models/Block"); 
  require("./src/models/UserBehavior"); // Load UserBehavior model

  // Initialize Feed Services
  try {
    const { feedJobScheduler } = require("./src/services/FeedJobScheduler");
    feedJobScheduler.start();
    logger.info("Feed job scheduler started");
  } catch (error) {
    logger.warn("Failed to start feed job scheduler", error);
  }

  // Initialize Trending Service
  try {
    const { trendingService } = require("./src/services/TrendingService");
    trendingService.initialize();
    logger.info("Trending service initialized");
  } catch (error) {
    logger.warn("Failed to initialize trending service", error);
  }
});

// --- Server Listen ---
const PORT = Number(process.env.PORT) || 3000;
const bootServer = async () => {
  // Try to connect to database, but don't crash if it fails
  try {
    await connectToDatabase();
  } catch (error: unknown) {
    // Database connection failed, but allow server to start anyway
    // Operations will fail gracefully when database is unavailable
    logger.warn("MongoDB connection unavailable - server will start but database operations will fail");
  }

  // Setup Redis adapter before accepting connections to ensure
  // cross-instance broadcasts work from the first connection
  await setupRedisAdapter();

  // Start server after all async setup is complete
  server.listen(PORT, '0.0.0.0', () => {
    logger.info(`Server running on port ${PORT}`);
    if (!isDatabaseConnected()) {
      logger.warn("Server started without database connection - some features may be unavailable");
    }
  });
};

if (require.main === module) {
  void bootServer();
}

export { io, notificationsNamespace };
export default server;
