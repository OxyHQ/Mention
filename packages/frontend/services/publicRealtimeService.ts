import { API_URL_SOCKET } from '@/config';
import {
  PUBLIC_REALTIME_EVENTS,
  PUBLIC_REALTIME_NAMESPACE,
} from '@mention/shared-types';
import { io, Socket } from 'socket.io-client';
import { useTrendsStore } from '@/stores/trendsStore';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('PublicRealtime');

/**
 * The client half of the server's PUBLIC realtime namespace.
 *
 * This connection carries NO credentials and is opened for every visitor,
 * signed in or not. That is the whole point: trending is a public surface, and
 * `socketService` — the authenticated connection — requires a viewer id and a
 * token, so a signed-out reader could not receive a push at all and fell back
 * to a five-minute safety-net poll.
 *
 * It is a SEPARATE singleton from `socketService` rather than a mode of it,
 * because the two have opposite lifetimes: the authenticated socket is torn
 * down and rebuilt on every sign-in, sign-out and account switch, while this one
 * must survive all of those untouched — a reader watching the chart does not
 * lose the feed because someone switched accounts in another tab.
 *
 * Nothing is ever emitted TO the server from here. The namespace has no inbound
 * handlers; see `PUBLIC_REALTIME_NAMESPACE` in `@mention/shared-types` for what
 * may travel the other way.
 */
class PublicRealtimeService {
  private socket: Socket | null = null;

  private readonly handleTrendsUpdated = () => {
    // The payload is a notice; the data arrives through the one cached, filtered
    // `GET /trending`. Silent so a push never flashes the list back to a spinner.
    void useTrendsStore.getState().fetchTrends({ silent: true });
  };

  /**
   * A client that was disconnected or asleep missed every broadcast in between,
   * so its trends are stale by however many batches it slept through. The store
   * owns the policy (`resyncAfterReconnect` refetches the WHOLE list rather than
   * appending, which is why gaps are impossible); this only supplies the moment.
   *
   * Bound to the Manager's `reconnect`, which fires ONLY on a re-connection —
   * never the first one, where the store's own initial fetch already runs.
   */
  private readonly handleReconnect = () => {
    useTrendsStore.getState().resyncAfterReconnect();
  };

  /** Idempotent: a second call while the socket is live is a no-op. */
  connect(): void {
    // `active` means Socket.IO is either connected or already running its own
    // reconnection loop. Never replace a live Manager with a second one.
    if (this.socket?.active) return;

    this.disconnect();

    this.socket = io(`${API_URL_SOCKET}${PUBLIC_REALTIME_NAMESPACE}`, {
      transports: ['websocket', 'polling'],
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Number.POSITIVE_INFINITY,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
    });

    this.socket.on('connect_error', (error) => {
      logger.warn('Public socket connection failed', { error });
    });
    this.socket.on(PUBLIC_REALTIME_EVENTS.TRENDS_UPDATED, this.handleTrendsUpdated);
    // Reconnection has exactly one owner: Socket.IO's Manager.
    this.socket.io.on('reconnect', this.handleReconnect);
  }

  disconnect(): void {
    if (!this.socket) return;
    this.socket.off(PUBLIC_REALTIME_EVENTS.TRENDS_UPDATED, this.handleTrendsUpdated);
    this.socket.off('connect_error');
    this.socket.io.off('reconnect', this.handleReconnect);
    this.socket.disconnect();
    this.socket = null;
  }

  /** Whether the transport is currently up. Used by tests and diagnostics. */
  get isConnected(): boolean {
    return this.socket?.connected ?? false;
  }
}

export const publicRealtimeService = new PublicRealtimeService();
