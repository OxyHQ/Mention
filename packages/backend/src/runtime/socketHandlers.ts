import type { Server as SocketIOServer } from 'socket.io';
import { registerContentRoomHandlers } from '../services/ContentRoomLifecycle';
import {
  registerSocketPresence,
  type AuthenticatedPresenceSocket as AuthenticatedSocket,
} from '../services/SocketPresenceLifecycle';
import {
  markAllNotificationsRead,
  markNotificationRead,
} from '../services/notificationReadState';
import { resolveNotificationInboxIds } from '../services/notificationInbox';
import { createSocketRateLimiter } from '../middleware/socketRateLimit';
import { createUserScopedOxyServices } from '../utils/oxyHelpers';
import { logger } from '../utils/logger';
import type { PresenceRegistry } from './presenceRegistry';
import type { DisconnectReason, SocketNamespaces } from './socketIoServer';

type SocketRateLimiter = ReturnType<typeof createSocketRateLimiter>;

function registerNotificationsHandlers(
  namespace: SocketNamespaces['notificationsNamespace'],
  socketRateLimiter: SocketRateLimiter,
): void {
  namespace.on("connection", (socket: AuthenticatedSocket) => {
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
          namespace
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
        namespace.to(userRoom).emit("allNotificationsRead");
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
}

function registerPostsHandlers(
  namespace: SocketNamespaces['postsNamespace'],
  socketRateLimiter: SocketRateLimiter,
): void {
  namespace.on("connection", (socket: AuthenticatedSocket) => {
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
}

// Public namespace: broadcasts only. No auth, no rooms, and no inbound message
// handlers at all — a connection here is a subscription to server-wide public
// notices and nothing else. Nothing a client sends is ever read, which is why
// there is no rate-limited handler to register or clean up.
function registerPublicHandlers(namespace: SocketNamespaces['publicNamespace']): void {
  namespace.on("connection", (socket) => {
    logger.debug('Client connected to public namespace');
    socket.on("disconnect", (reason: DisconnectReason) => {
      logger.debug('Client disconnected from public namespace', { reason });
    });
  });
}

/** Main namespace: presence plus the shared content-room handlers. */
function registerMainNamespaceHandlers(
  io: SocketIOServer,
  presence: PresenceRegistry,
  socketRateLimiter: SocketRateLimiter,
): void {
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
}

/**
 * Register every connection handler on the already-authenticated namespaces.
 *
 * One rate limiter instance is shared by all of them, as it always was: its
 * budget is per socket id, not per namespace.
 */
export function registerSocketHandlers(
  io: SocketIOServer,
  namespaces: SocketNamespaces,
  presence: PresenceRegistry,
): void {
  const socketRateLimiter = createSocketRateLimiter();

  registerNotificationsHandlers(namespaces.notificationsNamespace, socketRateLimiter);
  registerPostsHandlers(namespaces.postsNamespace, socketRateLimiter);
  registerPublicHandlers(namespaces.publicNamespace);
  registerMainNamespaceHandlers(io, presence, socketRateLimiter);
}
