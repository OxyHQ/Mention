import type http from 'http';
import { Namespace, Server as SocketIOServer } from 'socket.io';
import { PUBLIC_REALTIME_NAMESPACE } from '@mention/shared-types';
import { config } from '../config';
import { isAllowedOrigin } from '../utils/allowedOrigins';
import { logger } from '../utils/logger';

export type DisconnectReason =
  | "server disconnect" | "client disconnect" | "transport close" | "transport error" | "ping timeout" | "parse error" | "forced close" | "forced server close" | "server shutting down" | "client namespace disconnect" | "server namespace disconnect" | "unknown transport";

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

/** Build the Socket.IO server, including its transport, CORS and compression policy. */
export function createSocketIoServer(server: http.Server): SocketIOServer {
  return new SocketIOServer(server, {
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

/**
 * The single thing namespace wiring needs from the Oxy client. `OxyServices`
 * satisfies it; naming it here keeps this module testable without one.
 */
export interface SocketAuthProvider {
  authSocket(): (socket: unknown, next: (err?: Error) => void) => Promise<void>;
}

export interface SocketNamespaces {
  notificationsNamespace: Namespace;
  postsNamespace: Namespace;
  publicNamespace: Namespace;
}

/**
 * Create the namespaces and wire their auth. Connection handlers are registered
 * separately, by `registerSocketHandlers`.
 */
export function createSocketNamespaces(io: SocketIOServer, oxy: SocketAuthProvider): SocketNamespaces {
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

  // Apply verification middleware to all namespaces
  [
    notificationsNamespace,
    postsNamespace,
    publicNamespace,
  ].forEach((namespace) => {
    configureNamespaceErrorHandling(namespace);
  });

  return { notificationsNamespace, postsNamespace, publicNamespace };
}
