/**
 * Socket.IO event rate limiting middleware.
 * Prevents abuse by limiting the rate of events per socket connection.
 */

import { logger } from '../utils/logger';

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
   *
   * Also the one place any of these handlers' errors are contained. A handler
   * registered here can throw synchronously (a bad destructure in its own
   * parameter list runs before its `try` does) or reject asynchronously (every
   * handler above is `async`), and either one used to escape uncaught: for an
   * `async` handler that becomes an unhandled promise rejection, which
   * `globalErrorHandlers` treats as fatal and exits the process over one
   * malformed client message. Catching it here, once, is the fix that covers
   * every event registered through `wrap` — past and future — without asking
   * each handler to defend itself.
   */
  const wrap = <A extends unknown[]>(
    socket: { id: string },
    eventName: string,
    handler: (...args: A) => unknown,
  ): ((...args: A) => void) => {
    return (...args: A): void => {
      if (!isAllowed(socket.id, eventName)) {
        return;
      }
      const reportFailure = (error: unknown): void => {
        logger.error('[SocketRateLimit] event handler failed', {
          eventName,
          socketId: socket.id,
          error: error instanceof Error ? error.message : String(error),
        });
        // Only the ack-callback shape socket.io itself uses: the true last
        // argument, if the caller supplied one. Calling an unrelated argument
        // would be worse than not acking at all.
        const maybeAck = args[args.length - 1];
        if (typeof maybeAck === 'function') {
          try {
            (maybeAck as (...ackArgs: unknown[]) => void)({ error: 'internal_error' });
          } catch {
            // The client already disconnected or the ack itself is malformed;
            // nothing left to report to.
          }
        }
      };
      let result: unknown;
      try {
        result = handler(...args);
      } catch (error) {
        reportFailure(error);
        return;
      }
      if (result instanceof Promise) {
        result.catch(reportFailure);
      }
    };
  };

  return { wrap, cleanup };
}
