import type { Socket } from 'socket.io';

export interface AuthenticatedPresenceSocket extends Socket {
  user?: { id: string; [key: string]: unknown };
}

interface DistributedPresencePort {
  isOnline(userId: string, localFallback: boolean): Promise<boolean>;
  markOnline(userId: string): Promise<void>;
  markOffline(userId: string): Promise<void>;
}

interface SocketPresenceOptions {
  onlineUsers: Map<string, Set<string>>;
  distributedPresence: DistributedPresencePort;
  broadcastPresence(userId: string, online: boolean): void;
}

function isLocallyOnline(
  onlineUsers: Map<string, Set<string>>,
  userId: string,
): boolean {
  return (onlineUsers.get(userId)?.size ?? 0) > 0;
}

/**
 * Attach presence cleanup synchronously, before the first Redis await.
 *
 * A Socket.IO connection may close while Redis is resolving prior presence or
 * refreshing the instance lease. The disconnect listener therefore exists
 * before either operation, and every post-await boundary re-checks the socket.
 */
export async function registerSocketPresence(
  socket: AuthenticatedPresenceSocket,
  options: SocketPresenceOptions,
): Promise<void> {
  const userId = socket.user?.id;
  if (!userId) return;

  let tracked = false;
  let disconnected = !socket.connected;
  let markOnlineStarted = false;
  let offlineBroadcasted = false;
  let cleanupChain = Promise.resolve();

  const cleanup = (): Promise<void> => {
    disconnected = true;
    cleanupChain = cleanupChain.then(async () => {
      // A disconnect before this socket touched local/distributed state is a
      // true no-op. In particular, do not emit a spurious offline event while
      // the initial Redis lookup is still pending.
      if (!tracked && !markOnlineStarted) return;

      if (tracked) {
        const sockets = options.onlineUsers.get(userId);
        sockets?.delete(socket.id);
        tracked = false;
        if (sockets?.size === 0) {
          options.onlineUsers.delete(userId);
        }
      }

      // Presence is stored once per (user, instance), not per socket. Keep the
      // instance member while another local socket for this user is alive.
      if (isLocallyOnline(options.onlineUsers, userId)) return;

      // This may intentionally run twice when disconnect races markOnline:
      // once from the event and once after the awaited markOnline settles. The
      // second idempotent removal guarantees a late Redis write cannot leave a
      // ghost online member.
      await options.distributedPresence.markOffline(userId);
      if (
        !offlineBroadcasted &&
        !(await options.distributedPresence.isOnline(userId, false))
      ) {
        offlineBroadcasted = true;
        options.broadcastPresence(userId, false);
      }
    });
    return cleanupChain;
  };

  // Load-bearing ordering: register before isOnline/markOnline can yield.
  socket.on('disconnect', () => {
    void cleanup();
  });

  if (disconnected) return;

  const wasOnline = await options.distributedPresence.isOnline(
    userId,
    isLocallyOnline(options.onlineUsers, userId),
  );
  if (!socket.connected || disconnected) {
    await cleanup();
    return;
  }

  let sockets = options.onlineUsers.get(userId);
  if (!sockets) {
    sockets = new Set<string>();
    options.onlineUsers.set(userId, sockets);
  }
  sockets.add(socket.id);
  tracked = true;

  // A disconnect can be delivered immediately after the local map mutation.
  // Do not create/refresh the Redis lease for an already-dead socket.
  if (!socket.connected || disconnected) {
    await cleanup();
    return;
  }

  markOnlineStarted = true;
  await options.distributedPresence.markOnline(userId);
  if (!socket.connected || disconnected) {
    await cleanup();
    return;
  }

  socket.join(`user:${userId}`);
  if (!wasOnline) {
    options.broadcastPresence(userId, true);
  }
}
