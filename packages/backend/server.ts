// --- Imports ---
import express from "express";
import http from "http";
import mongoose from "mongoose";
import { Server as SocketIOServer, Socket, Namespace } from "socket.io";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

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
import { OxyServices } from '@oxyhq/services/core';
import testRoutes from "./src/routes/test";
import profileSettingsRoutes from './src/routes/profileSettings';
import subscriptionsRoutes from './src/routes/subscriptions';

// Middleware
import { rateLimiter, bruteForceProtection } from "./src/middleware/security";

// --- Config ---
dotenv.config();

const app = express();

export const oxy = new OxyServices({ baseURL: process.env.OXY_API_URL || 'https://api.oxy.so' });


// --- Middleware ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS and security headers
app.use((req, res, next) => {
  const allowedOrigins = [process.env.FRONTEND_URL || "https://mention.earth", "http://localhost:8081", "http://localhost:8082", "http://192.168.86.44:8081"];
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND_URL || "*");
  }
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

type DisconnectReason =
  | "server disconnect" | "client disconnect" | "transport close" | "transport error" | "ping timeout" | "parse error" | "forced close" | "forced server close" | "server shutting down" | "client namespace disconnect" | "server namespace disconnect" | "unknown transport";

interface SocketError extends Error { description?: string; context?: any; }

const SOCKET_CONFIG = {
  PING_TIMEOUT: 60000,
  PING_INTERVAL: 25000,
  UPGRADE_TIMEOUT: 30000,
  CONNECT_TIMEOUT: 45000,
  MAX_BUFFER_SIZE: 1e8,
  COMPRESSION_THRESHOLD: 1024,
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

const configureNamespaceErrorHandling = (namespace: Namespace) => {
  namespace.on("connection_error", (error: Error) => {
    console.error("Connection error:", error.message);
  });
  namespace.on("connect_error", (error: Error) => {
    console.error("Connect error:", error.message);
  });
  namespace.on("connect_timeout", () => {
    console.error("Connection timeout");
  });
};

const notificationsNamespace = io.of("/notifications");
const postsNamespace = io.of("/posts");

// --- Socket Auth Middleware ---
// Lightweight auth: accept userId from client handshake and attach to socket
[notificationsNamespace, postsNamespace, io].forEach((namespaceOrServer: any) => {
  // For namespaces we have .use; for main io server we also have .use
  if (namespaceOrServer && typeof namespaceOrServer.use === "function") {
    namespaceOrServer.use((socket: AuthenticatedSocket, next: (err?: any) => void) => {
      try {
        const auth = socket.handshake?.auth as any;
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
  console.log(
    "Client connected to notifications namespace from ip:",
    socket.handshake.address
  );

  if (!socket.user?.id) {
    console.log(
      "Unauthenticated client attempted to connect to notifications namespace"
    );
    socket.disconnect(true);
    return;
  }

  const userRoom = `user:${socket.user.id}`;
  const userId = socket.user.id;
  socket.join(userRoom);
  console.log(`Client ${socket.id} joined notification room:`, userRoom);

  socket.on("error", (error: Error) => {
    console.error("Notifications socket error:", error.message);
  });

  socket.on("markNotificationRead", async ({ notificationId }) => {
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
      console.error("Error marking notification as read:", error);
    }
  });

  socket.on("markAllNotificationsRead", async () => {
    try {
      if (!socket.user?.id) return;
      await Notification.updateMany({ recipientId: userId }, { read: true });
      notificationsNamespace.to(userRoom).emit("allNotificationsRead");
    } catch (error) {
      console.error("Error marking all notifications as read:", error);
    }
  });

  socket.on("disconnect", (reason: DisconnectReason, description?: any) => {
    console.log(
      `Client ${socket.id} disconnected from notifications namespace:`,
      reason,
      description || ""
    );
    socket.leave(userRoom);
  });
});

// Configure postsNamespace events
postsNamespace.on("connection", (socket: AuthenticatedSocket) => {
  console.log(
    "Client connected to posts namespace from ip:",
    socket.handshake.address
  );

  socket.on("error", (error: Error) => {
    console.error("Posts socket error:", error.message);
  });

  socket.on("joinPost", (postId: string) => {
    const room = `post:${postId}`;
    socket.join(room);
    console.log(`Client ${socket.id} joined post room:`, room);
  });

  socket.on("leavePost", (postId: string) => {
    const room = `post:${postId}`;
    socket.leave(room);
    console.log(`Client ${socket.id} left post room:`, room);
  });

  socket.on("disconnect", (reason: DisconnectReason) => {
    console.log(
      `Client ${socket.id} disconnected from posts namespace:`,
      reason
    );
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
  console.log("Client connected from ip:", socket.handshake.address);

  // Enhanced error handling
  socket.on("error", (error: Error) => {
    console.error("Socket error:", error.message);
    // Attempt to reconnect on error
    if (socket.connected) {
      socket.disconnect();
    }
  });

  socket.on("disconnect", (reason: DisconnectReason, description?: any) => {
    console.log("Client disconnected:", reason, description || "");
    // Handle specific disconnect reasons
    if (reason === "server disconnect") {
      // Reconnect if server initiated the disconnect
      socket.disconnect();
    }
    if (reason === "transport close" || reason === "transport error") {
      console.log("Transport issue detected, attempting reconnection...");
    }
  });

  socket.on("connect_error", (error: Error) => {
    console.error("Connection error:", error.message);
  });

  socket.on("reconnect_attempt", (attemptNumber: number) => {
    console.log(`Reconnection attempt ${attemptNumber}`);
  });

  socket.on("reconnect_error", (error: Error) => {
    console.error("Reconnection error:", error.message);
  });

  socket.on("reconnect_failed", () => {
    console.error("Failed to reconnect");
  });

  socket.on("joinPost", (postId: string) => {
    const room = `post:${postId}`;
    socket.join(room);
    console.log(`Client ${socket.id} joined room:`, room);
  });

  socket.on("leavePost", (postId: string) => {
    const room = `post:${postId}`;
    socket.leave(room);
    console.log(`Client ${socket.id} left room:`, room);
  });
});

// Enhanced error handling for namespaces
[notificationsNamespace, postsNamespace].forEach(
  (namespace: Namespace) => {
    namespace.on("connection_error", (error: Error) => {
      console.error(
        `Namespace ${namespace.name} connection error:`,
        error.message
      );
    });

    namespace.on("connect_error", (error: SocketError) => {
      console.error(`${namespace.name}: Connect error:`, error.message);
      // Log detailed error info
      if (error.description)
        console.error("Error description:", error.description);
      if (error.context) console.error("Error context:", error.context);
    });

    namespace.on("connect_timeout", () => {
      console.error(`${namespace.name}: Connect timeout`);
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

// --- API ROUTES ---
// Public API routes (no authentication required)
const publicApiRouter = express.Router();
publicApiRouter.use("/hashtags", hashtagsRoutes);
// Move polls under authenticated router so req.user is available for create/vote
// If you want public GET access later, split the router or add a public shim.
// publicApiRouter.use("/polls", pollsRoutes);
publicApiRouter.get("/feed/debug", async (req, res) => {
  try {
    const posts = await Post.find({}).limit(3).lean();
    console.log('🔍 Debug - Raw posts from database:', JSON.stringify(posts, null, 2));
    
    res.json({
      message: 'Debug posts',
      count: posts.length,
      posts: posts.map(post => ({
        id: post._id,
        oxyUserId: post.oxyUserId,
        content: post.content,
        stats: post.stats,
        metadata: post.metadata,
        createdAt: post.createdAt
      }))
    });
  } catch (error) {
    console.error('Debug error:', error);
    res.status(500).json({ error: 'Debug failed' });
  }
});

// Authenticated API routes (require authentication)
const authenticatedApiRouter = express.Router();
authenticatedApiRouter.use("/posts", postsRouter); // All post routes require authentication
authenticatedApiRouter.use("/lists", listsRoutes);
authenticatedApiRouter.use("/notifications", notificationsRouter);
authenticatedApiRouter.use("/analytics", analyticsRoutes);
authenticatedApiRouter.use("/search", searchRoutes);
authenticatedApiRouter.use("/feed", feedRoutes); // Feed routes require authentication
authenticatedApiRouter.use("/feeds", customFeedsRoutes); // User-created feeds
authenticatedApiRouter.use("/polls", pollsRoutes); // Polls now require authentication
authenticatedApiRouter.use("/test", testRoutes);
authenticatedApiRouter.use("/profile", profileSettingsRoutes);
authenticatedApiRouter.use("/subscriptions", subscriptionsRoutes);
// You can add more protected routers here as needed

// Mount public and authenticated API routers
app.use("/api", publicApiRouter);
app.use("/api", oxy.auth(), authenticatedApiRouter);

// --- Root API Welcome Route ---
app.get("", async (req, res) => {
  try {
    const postsCount = await Post.countDocuments();
    res.json({ message: "Welcome to the API", posts: postsCount });
  } catch (error) {
    res.status(500).json({ message: "Error fetching stats", error });
  }
});

// --- MongoDB Connection ---
mongoose.connect(process.env.MONGODB_URI || "", { autoIndex: true, autoCreate: true });
const db = mongoose.connection;
db.on("error", (error) => { console.error("MongoDB connection error:", error); });
db.once("open", () => { console.log("Connected to MongoDB successfully"); });
db.once("open", () => { require("./src/models/Post"); require("./src/models/Block"); });

// --- Server Listen ---
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

export { io, notificationsNamespace };
export default server;
