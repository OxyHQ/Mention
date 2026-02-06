/**
 * Socket.IO event rate limiting middleware.
 * Prevents abuse by limiting the rate of events per socket connection.
 */

interface RateLimitConfig {
  /** Maximum events allowed in the window */
  maxEvents: number;
  /** Time window in milliseconds */
  windowMs: number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  maxEvents: 30,
  windowMs: 10_000, // 10 seconds
};

/**
 * Per-event rate limits (events per 10 seconds).
 * Events not listed here use the default limit.
 */
const EVENT_LIMITS: Record<string, RateLimitConfig> = {
  joinPost: { maxEvents: 20, windowMs: 10_000 },
  leavePost: { maxEvents: 20, windowMs: 10_000 },
  joinFeed: { maxEvents: 10, windowMs: 10_000 },
  leaveFeed: { maxEvents: 10, windowMs: 10_000 },
  getPresence: { maxEvents: 30, windowMs: 10_000 },
  getPresenceBulk: { maxEvents: 10, windowMs: 10_000 },
  subscribePresence: { maxEvents: 20, windowMs: 10_000 },
  unsubscribePresence: { maxEvents: 20, windowMs: 10_000 },
  markNotificationRead: { maxEvents: 20, windowMs: 10_000 },
  markAllNotificationsRead: { maxEvents: 5, windowMs: 10_000 },
};

/**
 * Creates a rate-limited wrapper for socket event handlers.
 * Tracks event counts per socket and rejects excess events silently.
 *
 * Usage:
 *   const limiter = createSocketRateLimiter();
 *   socket.on('joinPost', limiter(socket, 'joinPost', (postId) => { ... }));
 */
export function createSocketRateLimiter() {
  // Map<socketId, Map<eventName, RateLimitEntry>>
  const store = new Map<string, Map<string, RateLimitEntry>>();

  // Cleanup disconnected sockets
  const cleanup = (socketId: string) => {
    store.delete(socketId);
  };

  const isAllowed = (socketId: string, eventName: string): boolean => {
    const now = Date.now();
    const config = EVENT_LIMITS[eventName] ?? DEFAULT_CONFIG;

    if (!store.has(socketId)) {
      store.set(socketId, new Map());
    }
    const socketStore = store.get(socketId)!;

    const entry = socketStore.get(eventName);
    if (!entry || now >= entry.resetAt) {
      socketStore.set(eventName, { count: 1, resetAt: now + config.windowMs });
      return true;
    }

    entry.count++;
    return entry.count <= config.maxEvents;
  };

  /**
   * Wrap a socket event handler with rate limiting.
   * Returns a function that can be used as the event callback.
   */
  const wrap = <T extends (...args: any[]) => any>(
    socket: { id: string },
    eventName: string,
    handler: T,
  ): ((...args: Parameters<T>) => ReturnType<T> | undefined) => {
    return (...args: Parameters<T>) => {
      if (!isAllowed(socket.id, eventName)) {
        return undefined;
      }
      return handler(...args);
    };
  };

  return { wrap, cleanup };
}
