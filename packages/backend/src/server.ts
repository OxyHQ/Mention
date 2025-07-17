import express from "express";
import http from "http";
import mongoose from "mongoose";
import { Server as SocketIOServer, Socket, Namespace } from "socket.io";
import jwt from "jsonwebtoken";
import postsRouter from "./routes/posts";
import notificationsRouter from "./routes/notifications";
import dotenv from "dotenv";
import listsRoutes from "./routes/lists";
import hashtagsRoutes from "./routes/hashtags";
import { Post } from "./models/Post";
import searchRoutes from "./routes/search";
import { rateLimiter, bruteForceProtection } from "./middleware/security";
import Notification from "./models/Notification";
import analyticsRoutes from "./routes/analytics.routes";
import feedRoutes from './routes/feed.routes';
import pollsRoutes from './routes/polls';

dotenv.config();

const app = express();

// Body parsing middleware - IMPORTANT: Add this before any routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


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

  // Prevent caching issues
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
});

// Create server for local development and testing
// In Vercel, this will only be used for Socket.io setup but not for serving HTTP
const server = http.createServer(app);

// Custom socket interface to include user property
interface AuthenticatedSocket extends Socket {
  user?: {
    id: string;
    [key: string]: any;
  };
}

// Using socket.io's internal types for disconnect reasons
type DisconnectReason =
  | "server disconnect"
  | "client disconnect"
  | "transport close"
  | "transport error"
  | "ping timeout"
  | "parse error"
  | "forced close"
  | "forced server close"
  | "server shutting down"
  | "client namespace disconnect"
  | "server namespace disconnect"
  | "unknown transport";

// Socket error type
interface SocketError extends Error {
  description?: string;
  context?: any;
}

// Socket configuration
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

// Socket.IO Server configuration
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
    zlibInflateOptions: {
      chunkSize: SOCKET_CONFIG.CHUNK_SIZE,
      windowBits: SOCKET_CONFIG.WINDOW_BITS,
    },
    zlibDeflateOptions: {
      chunkSize: SOCKET_CONFIG.CHUNK_SIZE,
      windowBits: SOCKET_CONFIG.WINDOW_BITS,
      level: SOCKET_CONFIG.COMPRESSION_LEVEL,
    },
  },
});

// Enhanced socket token verification middleware with better error messages
const verifySocketToken = async (
  socket: Socket,
  next: (err?: Error) => void
) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      console.error("No auth token provided for socket connection");
      return next(new Error("Authentication token required"));
    }

    try {
      const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET!) as {
        id: string;
      };
      if (!decoded) {
        console.error("Token verification failed");
        return next(new Error("Invalid authentication token"));
      }

      // Add user info to socket
      (socket as AuthenticatedSocket).user = decoded as { id: string };
      console.log(`Socket authenticated for user: ${decoded.id}`);
      return next();
    } catch (error) {
      console.error("JWT verification error:", error);
      if (error instanceof jwt.TokenExpiredError) {
        return next(error);
      }
      if (error instanceof jwt.JsonWebTokenError) {
        return next(error);
      }
      if (error instanceof Error) {
        return next(error);
      }
      return next(new Error("Authentication failed"));
    }
  } catch (error) {
    console.error("Socket authentication error:", error);
    if (error instanceof Error) {
      return next(error);
    }
    return next(new Error("Authentication failed"));
  }
};

// Configure error handling for namespaces
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

// Create and configure namespaces with proper paths
const notificationsNamespace = io.of("/notifications");
const privacyNamespace = io.of("/privacy");
const postsNamespace = io.of("/posts"); // Update posts namespace path

// Configure privacy namespace
privacyNamespace.on("connection", (socket: AuthenticatedSocket) => {
  console.log(
    "Client connected to privacy namespace from ip:",
    socket.handshake.address
  );

  if (!socket.user?.id) {
    console.log(
      "Unauthenticated client attempted to connect to privacy namespace"
    );
    socket.disconnect(true);
    return;
  }

  const userRoom = `user:${socket.user.id}`;
  socket.join(userRoom);

  socket.on("error", (error: Error) => {
    console.error("Privacy socket error:", error.message);
  });

  socket.on("privacyUpdate", async (settings: any) => {
    try {
      if (!socket.user?.id) return;
      // Emit to user's room that privacy settings were updated
      privacyNamespace.to(userRoom).emit("privacySettingsUpdated", settings);
    } catch (error) {
      console.error("Error updating privacy settings:", error);
    }
  });

  socket.on("disconnect", (reason: DisconnectReason) => {
    console.log(
      `Client ${socket.id} disconnected from privacy namespace:`,
      reason
    );
    socket.leave(userRoom);
  });
});

// Apply verification middleware to all namespaces
[
  notificationsNamespace,
  postsNamespace,
  privacyNamespace,
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

// Store namespaces in app for route access
app.set("io", io);
app.set("notificationsNamespace", notificationsNamespace);
app.set("postsNamespace", postsNamespace);
app.set("privacyNamespace", privacyNamespace);

// Routes
app.use('/feed', feedRoutes);


// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || "", {
  autoIndex: true,
  autoCreate: true,
});
const db = mongoose.connection;
db.on("error", (error) => {
  console.error("MongoDB connection error:", error);
});
db.once("open", () => {
  console.log("Connected to MongoDB successfully");
});
db.once("open", () => {
  require("./models/Post");
  require("./models/Block");
});

// API Routes
app.get("", async (req, res) => {
  try {
    const postsCount = await Post.countDocuments();
    res.json({
      message: "Welcome to the API",
      posts: postsCount,
    });
  } catch (error) {
    res.status(500).json({ message: "Error fetching stats", error });
  }
});
app.use("/search", searchRoutes);
app.use("/posts", postsRouter);
app.use("/lists", listsRoutes);
app.use("/hashtags", hashtagsRoutes);
app.use("/notifications", notificationsRouter);
app.use("/analytics", analyticsRoutes);
app.use('/polls', pollsRoutes);

// Only call listen if this module is run directly
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

export default server;
export { io, notificationsNamespace, privacyNamespace };
