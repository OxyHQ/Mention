// --- Imports ---
import express from "express";
import http from "http";
import mongoose from "mongoose";
import { Server as SocketIOServer, Socket, Namespace } from "socket.io";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { OxyServices } from "@oxyhq/services";

// Models
import { Post } from "./models/Post";
import Notification from "./models/Notification";

// Routers
import postsRouter from "./routes/posts";
import notificationsRouter from "./routes/notifications";
import listsRoutes from "./routes/lists";
import hashtagsRoutes from "./routes/hashtags";
import searchRoutes from "./routes/search";
import analyticsRoutes from "./routes/analytics.routes";
import feedRoutes from './routes/feed.routes';
import pollsRoutes from './routes/polls';

const oxy = new OxyServices({
  baseURL: process.env.OXY_API_URL || 'http://localhost:3001'
});
const authenticateTokenBase = oxy.createAuthenticateTokenMiddleware({
  loadFullUser: true
});

function authenticateToken(req: express.Request, res: express.Response, next: express.NextFunction) {
  authenticateTokenBase(req, res, (err?: any) => {
    if (err) {
      console.error('Auth error:', err);
      return res.status(401).json({ error: err.message || 'Authentication failed' });
    }
    next();
  });
}

// Middleware
import { rateLimiter, bruteForceProtection } from "./middleware/security";

// --- Config ---
dotenv.config();

const app = express();

// --- Middleware ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS and security headers
app.use((req, res, next) => {
  const allowedOrigins = [process.env.FRONTEND_URL || "https://mention.earth", "http://localhost:8081", "http://localhost:8082"];
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

const verifySocketToken = async (socket: Socket, next: (err?: Error) => void) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      console.error("No auth token provided for socket connection");
      return next(new Error("Authentication token required"));
    }
    try {
      const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET!) as { id: string };
      if (!decoded) {
        console.error("Token verification failed");
        return next(new Error("Invalid authentication token"));
      }
      (socket as AuthenticatedSocket).user = decoded as { id: string };
      console.log(`Socket authenticated for user: ${decoded.id}`);
      return next();
    } catch (error) {
      console.error("JWT verification error:", error);
      if (error instanceof jwt.TokenExpiredError) return next(error);
      if (error instanceof jwt.JsonWebTokenError) return next(error);
      if (error instanceof Error) return next(error);
      return next(new Error("Authentication failed"));
    }
  } catch (error) {
    console.error("Socket authentication error:", error);
    if (error instanceof Error) return next(error);
    return next(new Error("Authentication failed"));
  }
};

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
  namespace.use(verifySocketToken);
  configureNamespaceErrorHandling(namespace);
});

// Configure main namespace with enhanced error handling
io.use(verifySocketToken);
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
app.set("notificationsNamespace", notificationsNamespace);
app.set("postsNamespace", postsNamespace);

// --- API ROUTES ---
// Public API routes (no authentication required)
const publicApiRouter = express.Router();
publicApiRouter.use("/posts", postsRouter); // postsRouter splits public/protected
publicApiRouter.use("/hashtags", hashtagsRoutes);
publicApiRouter.use("/feed", feedRoutes); // feedRoutes splits public/protected
publicApiRouter.use("/polls", pollsRoutes); // pollsRouter splits public/protected

// Authenticated API routes (require authentication)
const authenticatedApiRouter = express.Router();
authenticatedApiRouter.use("/lists", listsRoutes);
authenticatedApiRouter.use("/notifications", notificationsRouter);
authenticatedApiRouter.use("/analytics", analyticsRoutes);
authenticatedApiRouter.use("/search", searchRoutes);
// You can add more protected routers here as needed

// Mount public and authenticated API routers
app.use("/api", publicApiRouter);
app.use("/api", authenticateToken, authenticatedApiRouter);

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
db.once("open", () => { require("./models/Post"); require("./models/Block"); });

// --- Server Listen ---
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

export { io, notificationsNamespace };
export default server;
