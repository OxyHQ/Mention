import { feedService } from './feedService';
import { API_URL, API_URL_SOCKET } from '@/config';
import type { OxyServices } from '@oxy.so/core';
import { createMentionSocketSession } from '@/lib/mentionSocketSession';
import type { FeedType } from '@mention/shared-types';
import { SOCKET_FEED_TYPES } from '@mention/shared-types/realtime';
import { AppState, type AppStateStatus } from 'react-native';
import { io, type Socket } from 'socket.io-client';
import { Feed, feedKey, prependBroadcastPosts } from '@/data/feeds';
import { postEngagementRealtime } from '@/data/realtime';
import { useLiveRoomsStore } from '@/stores/liveRoomsStore';
import {
  SOCKET_EVENT_ROOMS_LIVE_UPDATED,
  ROOMS_LIVE_REFETCH_DEBOUNCE_MS,
} from '@/constants/realtimeEvents';
import { createLogger } from '@oxy.so/core/logger';
import { resetLocalActions, wasRecent, type EchoAction } from './echoGuard';

const logger = createLogger('SocketService');

// Valid feed types for validation — the room contract `joinFeed`/`leaveFeed`
// accept, shared with the backend so the two cannot drift apart.
const VALID_FEED_TYPES: readonly string[] = SOCKET_FEED_TYPES;

interface FeedUpdateData {
  type?: string;
}

interface PresenceUpdateData {
  userId: string;
  online: boolean;
}

class SocketService {
  private socket: Socket | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = Number.POSITIVE_INFINITY;
  private readonly baseReconnectDelay = 1000;
  private currentUserId?: string;
  private currentOxy?: OxyServices;
  private currentSessionEpoch?: number;
  private socketSession?: ReturnType<typeof createMentionSocketSession>;
  private appStateSubscription: { remove: () => void } | null = null;
  // recentActions handled by echoGuard
  private feedListeners = new Map<string, Set<() => void>>();

  /** Share the app connection; each mounted screen releases only its listener. */
  subscribeToFeedUpdates(type: string, listener: () => void): () => void {
    if (!VALID_FEED_TYPES.includes(type)) return () => {};
    let listeners = this.feedListeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.feedListeners.set(type, listeners);
      this.joinFeed(type);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.feedListeners.delete(type);
        // The server's leaveFeed also leaves the app-wide personal room.
        // Keep the bounded allow-listed room until disconnect; remove only
        // this screen's listener, without disrupting other mounted screens.
      }
    };
  }

  private invalidatedFeeds = new Set<FeedType>();
  private feedAccessEpoch = 0;
  private feedRefreshes = new Set<FeedType>();
  private feedInvalidationTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly FEED_UPDATE_DEBOUNCE_MS = 500; // Batch updates every 500ms
  private readonly MAX_BATCH_SIZE = 50; // Maximum items per batch
  // The live engagement counters' subscription on the current socket.
  private stopEngagementRealtime: (() => void) | null = null;
  private socketGeneration = 0;
  private managerListeners?: {
    attempt: (attempt: number) => void;
    reconnect: () => void;
    failed: () => void;
  };
  // Debounce timer for coalescing live-rooms update signals (participant churn)
  private liveRoomsRefetchTimer: ReturnType<typeof setTimeout> | null = null;
  // Post rooms the mounted screens have asked for; replayed on every connect.
  private joinedPostIds = new Set<string>();
  // Web only: the document is frozen in the browser's back/forward cache, so the
  // transport is deliberately released and NOTHING may reopen it until it is
  // restored. See `lib/socketBfcache.web.ts`.
  private frozenForPageCache = false;

  constructor() {
    this.setupEventListeners();
  }

  private readonly handleManagerReconnectAttempt = (attempt: number) => {
    this.reconnectAttempts = attempt;
  };

  private readonly handleManagerReconnect = () => {
    this.reconnectAttempts = 0;
  };

  private readonly handleManagerReconnectFailed = () => {
    this.isConnected = false;
    if (this.frozenForPageCache) return;
    const manager = this.socket?.io;
    if (!manager || !this.currentUserId) return;

    // Defensive recovery for a manager created with stale/overridden finite
    // options. The Manager remains the sole retry owner; no app timer or second
    // Socket is created.
    manager.reconnection(true);
    manager.reconnectionAttempts(Number.POSITIVE_INFINITY);
    manager.open();
  };

  /**
   * Normalize post ID from various formats
   */
  private normalizePostId(item: { id?: unknown; _id?: unknown } | null | undefined): string {
    if (!item) return '';

    if (item.id) {
      return String(item.id);
    }

    if (item._id) {
      const _id = item._id;
      return typeof _id === 'object' && _id !== null && 'toString' in _id
        ? _id.toString()
        : String(_id);
    }

    return '';
  }

  /**
   * Connect to the backend socket server
   */
  connect(userId: string, oxy: OxyServices, onContextEnd: () => void = () => {}): void {
    const epoch = oxy.http.getSessionEpoch();
    const credentialsChanged =
      this.currentUserId !== undefined &&
      (userId !== this.currentUserId ||
        oxy !== this.currentOxy ||
        epoch !== this.currentSessionEpoch);

    // A session-context change replaces the manager; token refresh within that
    // context is resolved by the shared handshake without keeping a bearer.
    if (credentialsChanged) {
      logger.info('Socket credentials changed, resetting session');
      this.disconnect();
    }

    // `active` means Socket.IO is either connected or already running its own
    // reconnection loop. Never replace it with a second manager for the same
    // authenticated identity.
    if (
      this.socket &&
      userId === this.currentUserId &&
      oxy === this.currentOxy &&
      epoch === this.currentSessionEpoch &&
      this.socket.active
    ) {
      return;
    }

    try {
      this.currentUserId = userId;
      this.currentOxy = oxy;
      this.currentSessionEpoch = epoch;
      // Connect to the backend socket server
      // Clean up any existing disconnected/failed socket before creating a new one
      if (this.socket) {
        this.removeSocketEventListeners();
        this.socket.disconnect();
        this.socket = null;
      }

      this.socketSession?.dispose();
      this.socketSession = createMentionSocketSession(oxy, API_URL, API_URL_SOCKET, onContextEnd);
      this.socket = io(API_URL_SOCKET, {
        transports: ['websocket', 'polling'],
        auth: this.socketSession.auth,
        autoConnect: false,
        reconnection: true,
        reconnectionAttempts: this.maxReconnectAttempts,
        reconnectionDelay: this.baseReconnectDelay,
        reconnectionDelayMax: 30000,
      });

      this.setupSocketEventListeners();
      this.socketSession.bind(() => this.disconnect());
      this.socket?.connect();
    } catch (error) {
      logger.error('Connection error', error);
    }
  }

  /**
   * Is this event the echo of something this viewer just did themselves?
   *
   * The action was already applied optimistically, so re-applying the server's
   * answer would only make the number flicker if the viewer has acted again
   * since. It cannot double-count either way — every count on the wire is the
   * value the database holds, not a delta — so this is a smoothness guard, not a
   * correctness one.
   *
   * `actorId` decides it outright when the server sent one. It does not for a
   * SAVE, where publishing the actor to a room would say who bookmarked the
   * post; those fall back to the short local window, and the worst case there is
   * that the viewer's own device re-applies a number it already holds.
   */
  private shouldIgnoreEcho(postId: string, action: EchoAction, actorId?: string) {
    if (actorId) return actorId === this.currentUserId;
    return wasRecent(postId, action);
  }

  /**
   * Disconnect from the socket server
   */
  disconnect() {
    this.socketGeneration += 1;
    this.socketSession?.dispose();
    this.socketSession = undefined;
    if (this.socket) {
      // Remove all socket event listeners before disconnecting
      this.removeSocketEventListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    this.isConnected = false;
    if (this.feedInvalidationTimer) {
      clearTimeout(this.feedInvalidationTimer);
      this.feedInvalidationTimer = null;
    }
    // Clear pending live-rooms refetch debounce
    if (this.liveRoomsRefetchTimer) {
      clearTimeout(this.liveRoomsRefetchTimer);
      this.liveRoomsRefetchTimer = null;
    }
    // Clear queues
    this.feedAccessEpoch += 1;
    this.invalidatedFeeds.clear();
    this.feedRefreshes.clear();
    // A full teardown ends every subscription: `disconnect()` runs on sign-out
    // and on a credential change, and replaying one viewer's rooms onto the
    // next viewer's socket would be a subscription they never asked for.
    this.joinedPostIds.clear();

    // Clear all listener maps
    this.presenceListeners.clear();
    resetLocalActions();

    this.currentUserId = undefined;
    this.currentOxy = undefined;
    this.currentSessionEpoch = undefined;
    this.reconnectAttempts = 0;
    this.frozenForPageCache = false;
  }

  /**
   * Release the transport because the browser is about to freeze the document
   * into its back/forward cache.
   *
   * Deliberately NOT `disconnect()`, which is the sign-out teardown: it drops the
   * viewer's credentials, the post rooms their mounted screens are watching and
   * every queued update, none of which a frozen page consented to losing. The
   * Socket and all of its listeners survive, so `resumeAfterPageRestore` reopens
   * the SAME session rather than negotiating a new one.
   */
  suspendForPageFreeze(): void {
    if (this.frozenForPageCache) return;
    this.frozenForPageCache = true;
    if (!this.socket) return;
    // Reconnection belongs to the Manager, and BOTH realtime services share one
    // — same origin, same path, two namespaces, one WebSocket. Releasing this
    // namespace socket alone therefore leaves the Manager live and free to
    // retry, reopening the transport within a second and making the page
    // ineligible again before the browser has finished deciding. Socket.IO does
    // stop retrying once EVERY namespace socket has been released, but only as
    // a side effect of an internal flag and only in that order; saying it
    // outright is what makes the frozen window safe either way.
    this.socket.io.reconnection(false);
    this.socket.disconnect();
    this.isConnected = false;
  }

  /** The document came back out of the back/forward cache: reopen the session. */
  resumeAfterPageRestore(): void {
    if (!this.frozenForPageCache) return;
    this.frozenForPageCache = false;
    if (!this.socket) return;
    this.socket.io.reconnection(true);
    // Room membership is server-side state the closed connection destroyed. The
    // `connect` handler re-joins the feed room and replays `joinedPostIds`, so
    // the screens still mounted behind the restored page come back live.
    this.socket.connect();
  }

  /** Final teardown for tests or a host that unloads the singleton entirely. */
  dispose(): void {
    this.disconnect();
    this.appStateSubscription?.remove();
    this.appStateSubscription = null;
  }

  /**
   * Join feed room for real-time updates (room-based subscription)
   */
  joinFeed(feedType: string): void {
    if (!this.socket?.connected) return;
    this.socket.emit('joinFeed', { feedType, userId: this.currentUserId });
  }

  /**
   * Leave feed room
   */
  leaveFeed(feedType: string): void {
    if (!this.socket?.connected) return;
    this.socket.emit('leaveFeed', { feedType, userId: this.currentUserId });
  }

  /**
   * Subscribe to one post's live engagement counters.
   *
   * The subscription is recorded whether or not there is a socket to tell right
   * now, and replayed on every (re)connect. Room membership is server-side state
   * that a dropped connection destroys, so without the replay a screen that
   * survived a reconnect — or that mounted during the 5–25s auth cold boot —
   * would sit in a room the server has no record of, showing counts that never
   * move again and reporting no error.
   */
  joinPost(postId: string): void {
    if (!postId) return;
    this.joinedPostIds.add(postId);
    if (this.socket?.connected) this.socket.emit('joinPost', postId);
  }

  /**
   * Leave a post room
   */
  leavePost(postId: string): void {
    if (!postId) return;
    this.joinedPostIds.delete(postId);
    if (this.socket?.connected) this.socket.emit('leavePost', postId);
  }

  /**
   * Remove all socket event listeners
   */
  private removeSocketEventListeners() {
    if (!this.socket) return;

    this.socket.off('connect');
    this.socket.off('disconnect');
    this.socket.off('connect_error');
    this.socket.off('feed:updated');
    this.stopEngagementRealtime?.();
    this.stopEngagementRealtime = null;
    this.socket.off('user:presence');
    this.socket.off('user:presenceBulk');
    this.socket.off(SOCKET_EVENT_ROOMS_LIVE_UPDATED);
    if (this.managerListeners) {
      this.socket.io.off('reconnect_attempt', this.managerListeners.attempt);
      this.socket.io.off('reconnect', this.managerListeners.reconnect);
      this.socket.io.off('reconnect_failed', this.managerListeners.failed);
      this.managerListeners = undefined;
    }
  }

  /**
   * Setup socket event listeners
   */
  private setupSocketEventListeners() {
    if (!this.socket) return;
    const generation = this.socketGeneration;

    this.socket.on('connect', () => {
      if (generation !== this.socketGeneration) return;
      this.isConnected = true;
      this.reconnectAttempts = 0;

      // Join feed rooms for real-time updates
      if (this.currentUserId && this.socket) {
        this.socket.emit('joinFeed', { userId: this.currentUserId });
        for (const [type, listeners] of this.feedListeners) {
          this.joinFeed(type);
          for (const listener of listeners) listener();
        }
      }

      // Re-assert the post rooms the mounted screens are still watching. The
      // server re-checks visibility on each one, so this grants nothing a fresh
      // join would not.
      for (const postId of this.joinedPostIds) {
        this.socket?.emit('joinPost', postId);
      }
    });

    this.socket.on('disconnect', () => {
      if (generation !== this.socketGeneration) return;
      this.isConnected = false;
    });

    this.socket.on('connect_error', (error) => {
      if (generation !== this.socketGeneration) return;
      this.isConnected = false;
      logger.warn('Socket connection failed', { error });
    });

    // Reconnection has exactly one owner: Socket.IO's Manager.
    const ifCurrent =
      <T extends unknown[]>(handler: (...args: T) => void) =>
      (...args: T) => {
        if (generation === this.socketGeneration) handler(...args);
      };
    this.managerListeners = {
      attempt: ifCurrent(this.handleManagerReconnectAttempt),
      reconnect: ifCurrent(this.handleManagerReconnect),
      failed: ifCurrent(this.handleManagerReconnectFailed),
    };
    this.socket.io.on('reconnect_attempt', this.managerListeners.attempt);
    this.socket.io.on('reconnect', this.managerListeners.reconnect);
    this.socket.io.on('reconnect_failed', this.managerListeners.failed);

    // Feed update events
    this.socket.on('feed:updated', (data) => {
      if (generation !== this.socketGeneration) return;
      this.handleFeedUpdate(data);
    });

    // Post engagement events, from the `post:<id>` rooms this client joined,
    // written into the shared posts after the frame (`data/realtime`).
    this.stopEngagementRealtime = postEngagementRealtime(
      this.socket,
      (postId, action, actorId) =>
        generation !== this.socketGeneration || this.shouldIgnoreEcho(postId, action, actorId),
    );

    // Presence events
    this.socket.on('user:presence', (data) => {
      if (generation !== this.socketGeneration) return;
      this.handlePresenceUpdate(data);
    });

    this.socket.on('user:presenceBulk', (data) => {
      if (generation !== this.socketGeneration) return;
      this.handlePresenceBulkUpdate(data);
    });

    // Trends are NOT handled here. They travel on the public namespace
    // (`publicRealtimeService`) so signed-out visitors — who cannot connect to
    // this authenticated socket at all — receive them too. One owner, one path.

    // Live-rooms set changed → debounced silent refetch (coalesces participant churn)
    this.socket.on(SOCKET_EVENT_ROOMS_LIVE_UPDATED, () => {
      if (generation !== this.socketGeneration) return;
      this.handleLiveRoomsUpdated();
    });
  }

  /**
   * Live-rooms set changed. Coalesce bursts (participant churn) into a single
   * silent refetch.
   */
  private handleLiveRoomsUpdated(): void {
    if (this.liveRoomsRefetchTimer) {
      clearTimeout(this.liveRoomsRefetchTimer);
    }
    this.liveRoomsRefetchTimer = setTimeout(() => {
      this.liveRoomsRefetchTimer = null;
      useLiveRoomsStore.getState().refreshObservedLiveRooms();
    }, ROOMS_LIVE_REFETCH_DEBOUNCE_MS);
  }

  /**
   * Setup global event listeners
   */
  private setupEventListeners(): void {
    // Handle app state changes (React Native)
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (nextAppState === 'active') {
        // App came to foreground - reconnect if needed. A frozen document is
        // exempt: on web this fires from `visibilitychange`, which also fires
        // around a back/forward-cache restore, and reopening the socket there
        // would undo the release the freeze depends on.
        if (
          !this.isConnected &&
          !this.frozenForPageCache &&
          this.socket &&
          !this.socket.connected &&
          !this.socket.active
        ) {
          logger.info('App resumed, reconnecting...');
          this.socket.connect();
        }
      }
    };

    this.appStateSubscription = AppState.addEventListener('change', handleAppStateChange);
  }

  /**
   * Handle feed updates from socket
   * Optimized to handle multiple posts efficiently with debouncing
   */
  private handleFeedUpdate(data: FeedUpdateData) {
    const type = data?.type;
    if (!type || !VALID_FEED_TYPES.includes(type)) return;
    for (const listener of this.feedListeners.get(type) ?? []) listener();
    this.invalidatedFeeds.add(type as FeedType);
    if (this.feedInvalidationTimer) clearTimeout(this.feedInvalidationTimer);
    this.feedInvalidationTimer = setTimeout(() => {
      this.feedInvalidationTimer = null;
      void this.refreshInvalidatedFeeds();
    }, this.FEED_UPDATE_DEBOUNCE_MS);
  }

  /** Fetch once per burst; authorization belongs to HTTP, never a broadcast DTO. */
  private async refreshInvalidatedFeeds(): Promise<void> {
    const epoch = this.feedAccessEpoch;
    const feeds = [...this.invalidatedFeeds];
    this.invalidatedFeeds.clear();
    await Promise.all(
      feeds.map(async (type) => {
        if (!Feed.get(feedKey({ type }))) return;
        if (this.feedRefreshes.has(type)) {
          this.invalidatedFeeds.add(type);
          return;
        }
        this.feedRefreshes.add(type);
        try {
          const response = await feedService.getFeed({ type, limit: this.MAX_BATCH_SIZE });
          if (epoch !== this.feedAccessEpoch) return;
          prependBroadcastPosts(type, response.items ?? []);
        } catch (error) {
          logger.warn('Could not refresh invalidated feed', { type, error });
        } finally {
          if (epoch === this.feedAccessEpoch) {
            this.feedRefreshes.delete(type);
            if (this.invalidatedFeeds.has(type)) this.handleFeedUpdate({ type });
          }
        }
      }),
    );
  }

  // Presence event listeners
  private static readonly MAX_LISTENER_MAP_SIZE = 500;
  private presenceListeners: Map<string, Set<(online: boolean) => void>> = new Map();

  /**
   * Handle presence update from socket
   */
  private handlePresenceUpdate(data: PresenceUpdateData) {
    const { userId, online } = data || {};
    if (!userId) return;

    const listeners = this.presenceListeners.get(userId);
    if (listeners) {
      listeners.forEach((callback) => callback(online));
    }
  }

  /**
   * Handle bulk presence update from socket
   */
  private handlePresenceBulkUpdate(data: Record<string, boolean>) {
    if (!data) return;

    Object.entries(data).forEach(([userId, online]) => {
      const listeners = this.presenceListeners.get(userId);
      if (listeners) {
        listeners.forEach((callback) => callback(online));
      }
    });
  }

  /**
   * Prune empty entries from a listener map and evict oldest if over limit
   */
  private pruneListenerMap<T>(map: Map<string, Set<T>>): void {
    // Remove entries with empty Sets
    for (const [key, set] of map.entries()) {
      if (set.size === 0) {
        map.delete(key);
      }
    }
    // If still over limit, remove oldest entries (first inserted)
    if (map.size > SocketService.MAX_LISTENER_MAP_SIZE) {
      const keysToRemove = Array.from(map.keys()).slice(
        0,
        map.size - SocketService.MAX_LISTENER_MAP_SIZE,
      );
      for (const key of keysToRemove) {
        map.delete(key);
      }
    }
  }

  /**
   * Subscribe to a user's online presence
   */
  subscribeToPresence(userId: string, callback: (online: boolean) => void): () => void {
    this.pruneListenerMap(this.presenceListeners);
    let listeners = this.presenceListeners.get(userId);
    if (!listeners) {
      listeners = new Set();
      this.presenceListeners.set(userId, listeners);
    }
    listeners.add(callback);
    const subscription = listeners;

    // Tell server to subscribe to this user's presence
    if (this.socket?.connected) {
      this.socket.emit('subscribePresence', userId);
    }

    // Return unsubscribe function
    return () => {
      const listeners = this.presenceListeners.get(userId);
      if (listeners === subscription) {
        listeners.delete(callback);
        if (listeners.size === 0) {
          this.presenceListeners.delete(userId);
          // Tell server to unsubscribe
          if (this.socket?.connected) {
            this.socket.emit('unsubscribePresence', userId);
          }
        }
      }
    };
  }

  /**
   * Get online status of a user (async with callback)
   */
  getPresence(userId: string): Promise<boolean> {
    const generation = this.socketGeneration;
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) {
        resolve(false);
        return;
      }

      this.socket.emit('getPresence', userId, (data: { online: boolean }) => {
        if (generation !== this.socketGeneration) {
          reject(new Error('Socket session changed'));
          return;
        }
        resolve(data?.online ?? false);
      });
    });
  }

  /**
   * Get connection status
   */
  getConnectionStatus() {
    return {
      isConnected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
    };
  }

  /**
   * Emit custom event
   */
  emit(event: string, data?: unknown): void {
    if (!this.socket?.connected) return;
    this.socket.emit(event, data);
  }

  /**
   * Listen to custom event
   */
  on(event: string, callback: (data: unknown) => void): void {
    if (!this.socket) return;
    this.socket.on(event, callback);
  }

  /**
   * Remove custom event listener
   */
  off(event: string, callback?: (data: unknown) => void): void {
    if (!this.socket) return;

    if (callback) {
      this.socket.off(event, callback);
    } else {
      this.socket.off(event);
    }
  }
}

// Create singleton instance
export const socketService = new SocketService();

// Export for use in components
export default socketService;
