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
import { isAllowedOrigin } from "./src/utils/allowedOrigins";
import type { OxyAuthRequest as AuthRequest } from "@oxyhq/core/server";
import { runMigrations } from "./src/migrations/runner";
import { leaderElection } from "./src/services/LeaderElection";

// Models
import { Post } from "./src/models/Post";
import Notification from "./src/models/Notification";

// Routers
import postsRouter from "./src/routes/posts";
import intentMediaRoutes from "./src/routes/intentMedia";
import healthRoutes from './src/routes/health.routes';
import notificationsRouter from "./src/routes/notifications";
import listsRoutes from "./src/routes/lists";
import hashtagsRoutes from "./src/routes/hashtags";
import searchRoutes from "./src/routes/search";
import analyticsRoutes from "./src/routes/analytics.routes";
import feedRoutes from './src/routes/feed.routes';
import pollsRoutes from './src/routes/polls';
import customFeedsRoutes from './src/routes/customFeeds.routes';
import labelerRoutes from './src/routes/labeler.routes';
import statisticsRoutes, { publicStatisticsRouter } from './src/routes/statistics.routes';
import { OxyServices } from '@oxyhq/core';
import profileSettingsRoutes from './src/routes/profileSettings';
import profileDesignRoutes from './src/routes/profileDesign';
import profileMediaRoutes from './src/routes/profileMedia';
import subscriptionsRoutes from './src/routes/subscriptions';
import pokesRoutes from './src/routes/pokes';
import starterPacksRoutes from './src/routes/starterPacks';
import gifsRoutes from './src/routes/gifs';
import articlesRoutes from './src/routes/articles';
import muteRoutes from './src/routes/mute.routes';
import muteWordsRoutes from './src/routes/muteWords.routes';
import reportsRoutes from './src/routes/reports.routes';
import trendingRoutes from './src/routes/trending.routes';
import topicsRoutes from './src/routes/topics.routes';
import entityFollowRoutes from './src/routes/entity-follow.routes';
import mediaRoutes from './src/routes/media';
import recommendationsRoutes from './src/routes/recommendations';
import mtnNodesRoutes from './src/routes/mtn-nodes.routes';
import webShellRoutes from './src/routes/webShell.routes';
import { apexFrontendProxy, isApexHost } from './src/middleware/apexFrontendProxy';

// MCP OAuth (Model Context Protocol client authorization). Public discovery +
// authorize/token endpoints are mounted before the auth router; the dual-auth
// middleware lets an MCP JWT (aud: mention-mcp) authenticate the same
// authenticated API routes an Oxy session can.
import { createMcpOAuthRoutes } from './src/mcp/routes/mcpOAuth.routes';
import mcpConnectionsRoutes from './src/mcp/routes/mcpConnections.routes';
import mcpBundlesRoutes from './src/mcp/routes/mcpBundles.routes';
import { bearerLooksLikeMcpToken, createOptionalMcpAuth, createRequireMcpOrOxyAuth } from './src/mcp/middleware/mcpAuth';

// Federation (ActivityPub) — network connectors. Importing the connectors index
// instantiates the enabled connectors and registers the connector registry as
// the PostFederator (the seam PostCreationService.create uses), replacing the
// deleted FederationService facade's old import side-effect.
import './src/connectors';
import {
  webfingerRouter,
  actorRouter,
  apRateLimiter,
} from './src/connectors/activitypub/routes/engine.routes';
import federationContentRoutes from './src/connectors/activitypub/routes/ap.routes';
import federationApiRoutes from './src/connectors/connectors.routes';
// atproto BE-DISCOVERED bridge (Phase C4) — exposes a local user's MTN content to
// the atproto network via the public XRPC read surface. Gated by
// ATPROTO_BRIDGE_ENABLED (every route 404s when off); mounted public, before auth.
import atprotoBridgeRoutes, { bridgeMetaRouter as atprotoBridgeMetaRoutes, wellKnownBridgeRouter } from './src/connectors/atproto/bridge/routes';

// MTN Protocol
import { registerAllModules } from './src/mtn/feed/engine';

// Middleware
import { createOxyRateLimit } from '@oxyhq/core/server';
import { RedisStore } from "./src/middleware/rateLimitStore";
import { bruteForceProtection } from "./src/middleware/security";
import { feedRateLimiter } from "./src/middleware/rateLimiter";
import { performanceMiddleware } from "./src/middleware/performance";

import helmet from 'helmet';

const app = express();

// Trust only one level of proxy (load balancer) for proper IP handling
app.set('trust proxy', 1);

export const oxy = new OxyServices({ baseURL: process.env.OXY_API_URL || 'https://api.oxy.so' });

// --- Create Redis Store for Rate Limiting ---
const redisStore = new RedisStore({ 
  prefix: 'rate-limit:api:',
  windowMs: 15 * 60 * 1000 // 15 minutes
});

// --- Create Centralized Rate Limiter ---
// The new createOxyRateLimit middleware handles both session resolution and rate limiting
// internally, so we don't need the separate optionalAuth middleware anymore.
const rateLimiter = createOxyRateLimit(oxy, { 
  store: redisStore 
});

// --- Optional Auth Middleware ---
// This is now only needed for specific routes that want to resolve req.user
// but don't have rate limiting (since the centralized rate limiter handles this internally).
// Keep it for backward compatibility with routes that expect it.
const optionalAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Already resolved by an earlier pass (e.g., from rate limiter) — avoid a costly re-verify.
  if ((req as AuthRequest).user?.id) {
    return next();
  }

  // Check if Authorization header exists
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    // No auth header, continue as unauthenticated
    logger.debug("Optional auth: No authorization header, continuing as unauthenticated");
    return next();
  }

  // MCP JWTs are validated by createOptionalMcpAuth on publicApiRouter. Never
  // pass them to oxy.auth() — it would fail and previously wiped identity.
  if (bearerLooksLikeMcpToken(req)) {
    return next();
  }

  // Try to authenticate if header exists
  const authMiddleware = oxy.auth();
  authMiddleware(req, res, (err?: unknown) => {
    if (err) {
      // Auth failed (invalid token, expired, etc.), but continue anyway
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.debug(`Optional auth: Authentication failed, continuing as unauthenticated: ${message}`);
      // Clear any partial user data that might have been set
      (req as AuthRequest).user = undefined;
    }
    // Always continue the request chain
    next();
  });
};

// --- Middleware ---

// CORS — must be FIRST so all responses (including 429, 500) have CORS headers.
// Origin allowlist lives in one place (src/utils/allowedOrigins) so production
// never honours localhost / LAN-IP dev origins.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (process.env.FRONTEND_URL) {
    res.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND_URL);
  }
  // In production, don't set Access-Control-Allow-Origin for unknown origins (no wildcard fallback)
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Date, X-Api-Version");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  // Set no-cache only for API routes, not for federation/AP/atproto-bridge
  // endpoints which set their own Cache-Control.
  if (
    !req.path.startsWith('/ap/') &&
    !req.path.startsWith('/.well-known/') &&
    !req.path.startsWith('/xrpc/') &&
    !req.path.startsWith('/ap-bridge/')
  ) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

// Basic liveness/readiness endpoints
app.use(healthRoutes);

// Security headers. This backend serves BOTH the JSON API (api.mention.earth) AND the
// web-app HTML at the apex (mention.earth, via apexFrontendProxy + webShell.routes), so
// the CSP must permit everything the SPA talks to — helmet's default `default-src 'self'`
// would block every cross-origin call/image/embed. connect-src is the exfiltration-
// sensitive directive and is kept to an explicit first-party allowlist; img/media are
// generous (passive resources); frame-src mirrors the embed players in
// packages/frontend/utils/embedPlayer.ts. crossOriginResourcePolicy stays cross-origin
// because the API is served from a different subdomain than the web app.
const CSP_CONNECT_SRC = [
  "'self'", "blob:", "data:",
  "https://api.mention.earth", "wss://api.mention.earth", // Mention API + socket.io
  "https://api.oxy.so", "wss://api.oxy.so",               // Oxy SDK (auth/profiles/socket.io)
  "https://cloud.oxy.so",                                 // canonical media
  "https://api.syra.fm", "wss://api.syra.fm",             // Syra live rooms
  "https://livekit.oxy.so", "wss://livekit.oxy.so",       // LiveKit signaling
];
const CSP_FRAME_SRC = [
  "'self'",
  "https://www.youtube-nocookie.com", "https://www.youtube.com",
  "https://player.vimeo.com",
  "https://open.spotify.com",
  "https://player.twitch.tv", "https://clips.twitch.tv",
  "https://w.soundcloud.com",
  "https://embed.music.apple.com",
  "https://embedr.flickr.com",
  "https://bandcamp.com",
];
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "connect-src": CSP_CONNECT_SRC,
      "img-src": ["'self'", "data:", "blob:", "https:"],
      "media-src": ["'self'", "data:", "blob:", "https:"],
      "frame-src": CSP_FRAME_SRC,
      "worker-src": ["'self'", "blob:"],
    },
  },
}));

// Response compression. `compression` ≥1.8 negotiates the response encoding from
// the client's Accept-Encoding, preferring Brotli (`br`) then gzip — so the API's
// own JSON/HTML is served Brotli-compressed to modern clients WITHOUT adding any
// dependency. It also correctly SKIPS any response that already carries a
// Content-Encoding (e.g. the apex proxy relaying CF Pages' Brotli assets), so an
// already-compressed body is never double-encoded. `level` applies to gzip/
// deflate; Brotli uses the library's default quality (4) — a good balance for
// dynamic content. Compress only responses > 1KB.
app.use(compression({
  filter: (req, res) => {
    // Don't compress if client doesn't support it
    if (req.headers['x-no-compression']) {
      return false;
    }
    // Never compress the media proxy: it relays already-encoded media (some of
    // which is compressible, e.g. image/svg+xml or audio/wav) and re-gzipping
    // breaks the relayed Content-Length / byte-range seeking and wastes CPU.
    if (req.path === '/media/proxy') {
      return false;
    }
    // Use compression filter function
    return compression.filter(req, res);
  },
  level: 6, // gzip/deflate level (0-9, 6 is a good balance); Brotli uses its own default quality
  threshold: 1024, // Only compress responses > 1KB
}));

app.use(express.json({
  limit: '1mb',
  type: ['application/json', 'application/activity+json', 'application/ld+json'],
  verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
    // Preserve raw body for ActivityPub HTTP signature + Digest verification
    req.rawBody = buf?.length ? buf.toString('utf8') : undefined;
  },
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Global rate limiting — must be applied early
app.use(rateLimiter);
app.use(bruteForceProtection);

// Performance monitoring — registered before routes so it wraps res.end and
// observes every downstream route's response time.
app.use(performanceMiddleware);

// Middleware to parse nested query parameters (e.g., filters[authors]=user1,user2)
app.use((req, res, next) => {
  if (req.query && typeof req.query === 'object') {
    const filters: Record<string, express.Request['query'][string]> = {};
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
      (req.query as express.Request['query'] & { filters: typeof filters }).filters = filters;
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

// --- Sockets ---
const server = http.createServer(app);

interface AuthenticatedSocket extends Socket {
  user?: { id: string; [key: string]: unknown };
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
      broadcastPresence(io, userId, false);
      cleanedUsers++;
    }
  }
  if (cleanedUsers > 0 || cleanedSockets > 0) {
    logger.debug(`Presence cleanup: removed ${cleanedSockets} stale sockets, ${cleanedUsers} users now offline`);
  }
}, 5 * 60 * 1000);
// Never keep the event loop (or a test run) alive solely for this housekeeping timer.
presenceCleanupInterval.unref?.();

type DisconnectReason =
  | "server disconnect" | "client disconnect" | "transport close" | "transport error" | "ping timeout" | "parse error" | "forced close" | "forced server close" | "server shutting down" | "client namespace disconnect" | "server namespace disconnect" | "unknown transport";

interface SocketError extends Error { description?: string; context?: unknown; }

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

// --- Socket Auth Middleware ---
// Use oxy.authSocket() which validates tokens via jwtDecode + Oxy API session validation.
// This matches how oxy.auth() works for HTTP — no local JWT_SECRET needed.
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
    logger.debug(
      `Client ${socket.id} disconnected from notifications namespace: ${reason}${description ? ` - ${String(description)}` : ""}`
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

  // Join feed room for real-time updates (posts namespace). The user-scoped room
  // is ALWAYS derived from the authenticated socket identity — never a
  // client-supplied id — so a client can only ever join its OWN feed room.
  socket.on("joinFeed", socketRateLimiter.wrap(socket, 'joinFeed', (data: { feedType?: string }) => {
    const feedType = data?.feedType;
    if (feedType && typeof feedType === 'string') {
      socket.join(`feed:${feedType}`);
    }
    const selfId = socket.user?.id;
    if (selfId) {
      socket.join(`feed:user:${selfId}`);
    }
  }));

  // Leave feed room (posts namespace)
  socket.on("leaveFeed", socketRateLimiter.wrap(socket, 'leaveFeed', (data: { feedType?: string }) => {
    const feedType = data?.feedType;
    if (feedType && typeof feedType === 'string') {
      socket.leave(`feed:${feedType}`);
    }
    const selfId = socket.user?.id;
    if (selfId) {
      socket.leave(`feed:user:${selfId}`);
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

  socket.on("disconnect", (reason: DisconnectReason, description?: unknown) => {
    socketRateLimiter.cleanup(socket.id);
    logger.debug(`Client disconnected: ${reason}${description ? ` - ${String(description)}` : ""}`);

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

  // Join feed room for real-time updates. The user-scoped room is ALWAYS derived
  // from the authenticated socket identity — never a client-supplied id — so a
  // client can only ever join its OWN feed room.
  socket.on("joinFeed", socketRateLimiter.wrap(socket, 'joinFeed', (data: { feedType?: string }) => {
    const feedType = data?.feedType;
    if (feedType && typeof feedType === 'string') {
      const room = `feed:${feedType}`;
      socket.join(room);
      logger.debug(`Client ${socket.id} joined feed room: ${room}`);
    }
    const selfId = socket.user?.id;
    if (selfId) {
      const userRoom = `feed:user:${selfId}`;
      socket.join(userRoom);
      logger.debug(`Client ${socket.id} joined user feed room: ${userRoom}`);
    }
  }));

  // Leave feed room
  socket.on("leaveFeed", socketRateLimiter.wrap(socket, 'leaveFeed', (data: { feedType?: string }) => {
    const feedType = data?.feedType;
    if (feedType && typeof feedType === 'string') {
      const room = `feed:${feedType}`;
      socket.leave(room);
      logger.debug(`Client ${socket.id} left feed room: ${room}`);
    }
    const selfId = socket.user?.id;
    if (selfId) {
      const userRoom = `feed:user:${selfId}`;
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
[notificationsNamespace, postsNamespace].forEach(
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
// Expose io globally for utility modules that emit without direct access to
// req/app. Typed via the `declare global { var io }` augmentation in
// src/types/global.d.ts, so no cast is needed.
global.io = io;
app.set("notificationsNamespace", notificationsNamespace);
app.set("postsNamespace", postsNamespace);

// --- API ROUTES ---
// Public API routes (no authentication required)
const publicApiRouter = express.Router();
// Resolve MCP JWT identity on public routes before optionalAuth runs. Without
// this pass, MCP tools that hit /feed/* or /federation/* would stay anonymous
// because optionalAuth only understood Oxy session tokens.
publicApiRouter.use(createOptionalMcpAuth());
publicApiRouter.use("/hashtags", hashtagsRoutes);
// Move polls under authenticated router so req.user is available for create/vote
// If you want public GET access later, split the router or add a public shim.
// publicApiRouter.use("/polls", pollsRoutes);
// Debug route removed for production

// Feed routes with optional authentication (allow unauthenticated access for GET routes)
// POST/PUT/DELETE routes in feedRoutes require authentication
publicApiRouter.use("/feed", optionalAuth, feedRoutes);

// Public profile endpoints
// GET /profile/design/:userId - public profile design data (no auth required)
publicApiRouter.use("/profile/design", profileDesignRoutes);
publicApiRouter.use("/articles", articlesRoutes);
publicApiRouter.use("/trending", trendingRoutes); // Trending topics (no auth required)
publicApiRouter.use("/topics", topicsRoutes); // Topic collection (no auth required)
publicApiRouter.use("/federation", optionalAuth, federationApiRoutes); // Write endpoints enforce auth internally
publicApiRouter.use("/feeds", optionalAuth, customFeedsRoutes); // Public feed discovery; write routes enforce auth internally
publicApiRouter.use("/recommendations", optionalAuth, recommendationsRoutes); // Cross-app profile recommendations (personalized when authed)
publicApiRouter.use("/starter-packs", optionalAuth, starterPacksRoutes); // Public read/discovery + shared pack links; write routes enforce auth internally
publicApiRouter.use("/mtn/nodes", optionalAuth, mtnNodesRoutes); // MTN user-node registry: authed me/managed routes enforce auth internally; ingest-notify is a public 202 hint
publicApiRouter.use("/statistics", optionalAuth, publicStatisticsRouter); // Public per-user posting-activity heatmap; all other /statistics endpoints stay on the authed router below

// Authenticated API routes (require authentication)
const authenticatedApiRouter = express.Router();
// Note: The feed routes that require auth (like, save, repost, etc.) are in feedRoutes
// They're protected by the oxy.auth() middleware applied to authenticatedApiRouter
// Mounted BEFORE "/posts" so the more specific compose-intent media prefix
// matches first rather than falling through to the parameterized posts router.
authenticatedApiRouter.use("/posts/intent-media", intentMediaRoutes);
authenticatedApiRouter.use("/posts", postsRouter); // All post routes require authentication
authenticatedApiRouter.use("/lists", listsRoutes);
authenticatedApiRouter.use("/notifications", notificationsRouter);
authenticatedApiRouter.use("/analytics", analyticsRoutes);
authenticatedApiRouter.use("/statistics", statisticsRoutes);
authenticatedApiRouter.use("/search", searchRoutes);
authenticatedApiRouter.use("/labelers", labelerRoutes); // Composable moderation labels
authenticatedApiRouter.use("/polls", pollsRoutes); // Polls now require authentication
// Mounted BEFORE "/profile" so the more specific media-picker prefix matches
// first (the Syra catalog search proxy) without falling through profileSettings.
authenticatedApiRouter.use("/profile/media", profileMediaRoutes);
authenticatedApiRouter.use("/profile", profileSettingsRoutes);
authenticatedApiRouter.use("/subscriptions", subscriptionsRoutes);
authenticatedApiRouter.use("/gifs", gifsRoutes);
authenticatedApiRouter.use("/mute", muteRoutes);
authenticatedApiRouter.use("/mute-words", muteWordsRoutes); // Muted words & hashtags (feed tuner)
authenticatedApiRouter.use("/reports", reportsRoutes);
authenticatedApiRouter.use("/pokes", pokesRoutes);
authenticatedApiRouter.use("/entity-follows", entityFollowRoutes);
// MCP connection management (list/revoke authorized MCP clients). Works with
// either an Oxy session or an MCP JWT via the authenticated router's dual auth.
authenticatedApiRouter.use("/mcp/connections", mcpConnectionsRoutes);
authenticatedApiRouter.use("/mcp/bundles", mcpBundlesRoutes);
// Starter packs moved to the public router (optionalAuth) above so discovery and
// shared pack links resolve during cold boot; its write routes enforce auth internally.

// --- Root API Welcome Route ---
// On the API host `/` is the API root; on the frontend apex `/` is the SPA
// homepage, so defer to the apex frontend proxy (mounted below) for apex hosts.
app.get("", async (req, res, next) => {
  if (isApexHost(req)) {
    return next();
  }
  try {
    const postsCount = await Post.countDocuments();
    res.json({ message: "Welcome to the API", posts: postsCount });
  } catch (error) {
    logger.error("Error fetching stats for root route", error);
    res.status(500).json({ message: "Error fetching stats" });
  }
});

// --- Health Check Endpoint ---
// Minimal health check for load balancers — no internal details exposed
app.get("/health", async (req, res) => {
  try {
    const { isDatabaseConnected } = require("./src/utils/database");
    const { isRedisConnected } = require("./src/utils/redis");

    const [dbConnected, redisConnected] = await Promise.all([
      isDatabaseConnected(),
      isRedisConnected(),
    ]);

    const status = dbConnected && redisConnected ? "healthy" : "degraded";
    const statusCode = status === "healthy" ? 200 : 503;
    res.status(statusCode).json({
      status,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("Health check failed:", error);
    res.status(503).json({
      status: "unhealthy",
      timestamp: new Date().toISOString(),
    });
  }
});

// --- Metrics Endpoint ---
// Exposes Prometheus-format metrics for monitoring systems
import { metrics } from './src/utils/metrics';
app.get('/metrics', (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send(metrics.getPrometheusFormat());
});

// --- Federation routes (ActivityPub protocol — must be public, before auth) ---
app.use('/.well-known', webfingerRouter);

// NodeInfo — required for fediverse instance discovery
app.get('/.well-known/nodeinfo', (req, res) => {
  res.json({
    links: [
      {
        rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0',
        href: `https://${process.env.FEDERATION_DOMAIN || 'mention.earth'}/nodeinfo/2.0`,
      },
    ],
  });
});

app.get('/nodeinfo/2.0', async (req, res) => {
  let userCount = 0;
  let postCount = 0;
  try {
    const { Post } = require('./src/models/Post');
    postCount = await Post.estimatedDocumentCount();
    // User count is managed by Oxy, use a reasonable estimate
    userCount = 0;
  } catch (error) {
    logger.debug('nodeinfo: failed to estimate post count, defaulting to 0', error);
  }

  res.json({
    version: '2.0',
    software: {
      name: 'mention',
      version: '1.0.0',
    },
    protocols: ['activitypub'],
    usage: {
      users: { total: userCount },
      localPosts: postCount,
    },
    openRegistrations: true,
  });
});

// AP namespace — rate-limit once, then the shared engine router (actor GET, inbox
// POST, followers/following) and Mention's content router (outbox/featured/post
// dereference) on the SAME `/ap` prefix. All BEFORE `apexFrontendProxy` so the AP
// endpoint paths serve 200 directly and are never 301/302-redirected (a redirect
// kills Mastodon's inbox POST deliveries).
app.use('/ap', apRateLimiter);
app.use('/ap', actorRouter);
app.use('/ap', federationContentRoutes);

// --- atproto BE-DISCOVERED bridge (Phase C4 — public, before auth) ---
// The XRPC read surface (`com.atproto.repo.*` / `com.atproto.sync.*`) + the
// bridge DID-document view, plus `.well-known/atproto-did` handle resolution.
// All routes 404 when ATPROTO_BRIDGE_ENABLED is off.
app.use('/xrpc', atprotoBridgeRoutes);
app.use('/ap-bridge', atprotoBridgeMetaRoutes);
app.use('/.well-known', wellKnownBridgeRouter);

// --- Media proxy (PUBLIC, no auth) ---
// Streams remote fediverse media through our origin (CORS-safe, cacheable,
// range-seekable). Mounted directly on `app` before the auth router so the
// public path is exactly `/media/proxy`. SSRF-guarded internally.
app.use('/media', mediaRoutes);

// --- MCP OAuth (PUBLIC, before auth) ---
// The OAuth authorization-server discovery document plus the authorize/token
// endpoints must be reachable without a session. `POST /mcp/oauth/approve`
// self-guards with oxy.auth() inside the router. Mounted before the apex proxy
// so both the API host and the apex serve these from the backend directly.
app.use(createMcpOAuthRoutes(oxy));

// --- Public web shell with OpenGraph (PUBLIC, no auth) ---
// Serves the SPA shell HTML with per-request OG tags for `/@handle` and `/p/:id`
// (the `bskyweb` model — replaces the retired CF Pages `_worker.js` OG injection).
// Mounted BEFORE the apex proxy and the API routers so anonymous browsers/crawlers
// reach it (the auth router's oxy.auth() would otherwise reject these public page
// loads) AND so apex `/@handle` / `/p/:id` get the OG-injected shell rather than a
// dumb CDN proxy. Its RegExp routes (`/@…`, `/p/…`) do not collide with any
// API/federation mount.
app.use("/", webShellRoutes);

// --- Apex frontend reverse-proxy (host-aware; the "bskyweb-full" model) ---
// For the frontend apex host (`mention.earth`) this proxies every remaining
// request (`/`, `/explore`, `/feed`, `/notifications`, `/lists`, `/starter-packs`,
// `/_expo/*`, …) to the static frontend CDN so the apex serves the whole SPA. It
// is a STRICT no-op (`next()`) for the API host, so the API routers below are
// reached ONLY by non-apex hosts and behave exactly as before. Must sit BEFORE the
// API routers so apex SPA routes whose prefixes collide with API mounts are
// proxied to the SPA instead of hitting the API.
app.use(apexFrontendProxy);

// Mount public and authenticated API routers (API host only — apex traffic was
// already handled by the proxy above).
app.use("/", publicApiRouter);

// Dual auth: accept EITHER a valid MCP JWT (aud: mention-mcp, validated locally)
// OR a valid Oxy session (validated by oxy.auth()). See src/mcp/middleware/mcpAuth.ts.
app.use("/", createRequireMcpOrOxyAuth(oxy), authenticatedApiRouter);

// Global error handler — must be the LAST middleware registered.
// Catches unhandled errors from route handlers and prevents raw error leakage.
import { globalErrorHandler } from "./src/utils/error";
app.use(globalErrorHandler);

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
  require("./src/models/Block");
  require("./src/models/UserBehavior"); // Load UserBehavior model

  // Background schedulers (cron-style jobs) must run on EXACTLY ONE backend
  // task to avoid double-running when scaled to 2+ ECS tasks. They are gated
  // behind Redis leader election: only the elected leader starts them, and a
  // task that loses leadership stops them. See startSchedulers()/stopSchedulers().
  void leaderElection.start(startSchedulers, stopSchedulers).catch((error) => {
    logger.error("Leader election failed to start", error);
  });
});

/**
 * Start all in-process schedulers. Invoked by LeaderElection ONLY on the task
 * that holds the scheduler leadership lock (or in the Redis-unavailable
 * degraded fallback). Each service logs its own startup status. Failures are
 * isolated so one scheduler failing to start does not block the others.
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
}

// --- Server Listen ---
const PORT = Number(process.env.PORT) || 3000;
const bootServer = async () => {
  // Try to connect to database, but don't crash if it fails
  let databaseConnected = false;
  try {
    await connectToDatabase();
    databaseConnected = true;
  } catch (error: unknown) {
    // Database connection failed, but allow server to start anyway
    // Operations will fail gracefully when database is unavailable
    logger.warn("MongoDB connection unavailable - server will start but database operations will fail");
  }

  // Run pending data migrations before accepting traffic. Only when the
  // database is connected — otherwise migrations are deferred to a boot with a
  // live connection. A migration failure must abort boot rather than serve
  // traffic against half-migrated data.
  if (databaseConnected) {
    await runMigrations();
  }

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

  // Start server after all async setup is complete
  server.listen(PORT, '0.0.0.0', () => {
    logger.info(`Server running at http://localhost:${PORT}`);
    if (!isDatabaseConnected()) {
      logger.warn("Server started without database connection - some features may be unavailable");
    }
  });
};

// --- Graceful Shutdown ---
// ECS sends SIGTERM on task stop (and again SIGKILL after the stop timeout).
// On shutdown we release the scheduler leadership lock so another task can pick
// up the schedulers almost immediately, then stop accepting new connections.
let isShuttingDown = false;
const gracefulShutdown = (signal: string): void => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`Received ${signal} — shutting down gracefully`);

  // Release the scheduler lock + stop schedulers first so failover is fast.
  // leaderElection.stop() is safe to call even if this task was never leader.
  // Then close the BullMQ workers + queue connections so no jobs are processed
  // mid-shutdown and Redis connections drain cleanly. Both are best-effort and
  // must not block the server from closing.
  void leaderElection
    .stop()
    .catch((error) => logger.error("Error stopping leader election", error))
    .then(async () => {
      try {
        const { shutdownQueues } = require("./src/queue/workers");
        await shutdownQueues();
      } catch (error) {
        logger.error("Error shutting down federation queues", error);
      }
    })
    .finally(() => {
      // Stop accepting new HTTP/socket connections.
      server.close(() => {
        logger.info("HTTP server closed — exiting");
        process.exit(0);
      });

      // Hard cap: if connections don't drain in time, force exit so ECS doesn't
      // have to SIGKILL us.
      setTimeout(() => {
        logger.warn("Shutdown timed out — forcing exit");
        process.exit(0);
      }, 10_000).unref();
    });
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

if (require.main === module) {
  void bootServer();
}

export { io, notificationsNamespace };
export default server;
