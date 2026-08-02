import { API_URL_SOCKET } from '@/config';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {
  FeedType,
  PostEngagementCountsPayload,
  PostEngagementEvent,
} from '@mention/shared-types';
import { POST_ENGAGEMENT_EVENTS } from '@mention/shared-types';
import { AppState, type AppStateStatus } from 'react-native';
import { io, Socket } from 'socket.io-client';
import { usePostsStore } from '../stores/postsStore';
import type { FeedItem } from '@/db';
import { useLiveRoomsStore } from '@/stores/liveRoomsStore';
import {
  SOCKET_EVENT_ROOMS_LIVE_UPDATED,
  ROOMS_LIVE_REFETCH_DEBOUNCE_MS,
} from '@/constants/realtimeEvents';
import { createLogger } from '@oxyhq/core/logger';
import { wasRecent, type EchoAction } from './echoGuard';
import {
  engagementQueueStorageKey,
  parseEngagementQueue,
  serializeEngagementQueue,
} from './engagementQueuePersistence';

const logger = createLogger('SocketService');

// Valid feed types for validation
const VALID_FEED_TYPES: string[] = ['posts', 'media', 'replies', 'likes', 'boosts', 'mixed', 'for_you', 'following', 'saved', 'explore', 'custom'];

/**
 * The counters a post-engagement event carried, keyed the way the store keys
 * them. A counter the author hides never arrives, which is why every field is
 * optional and an absent one means "leave the rendered value alone" rather than
 * zero.
 */
type EngagementCounts = Partial<
  Record<'likes' | 'downvotes' | 'boosts' | 'replies' | 'saves', number>
>;

const COUNT_FIELDS: ReadonlyArray<keyof EngagementCounts> = [
  'likes',
  'downvotes',
  'boosts',
  'replies',
  'saves',
];

/**
 * Each engagement event and the local action it echoes. The action is only ever
 * used to ask the echo guard "did this device just do that?" — the counters in
 * the payload are what actually gets applied.
 */
const ENGAGEMENT_EVENT_ACTIONS: ReadonlyArray<[PostEngagementEvent, EchoAction]> = [
  [POST_ENGAGEMENT_EVENTS.LIKED, 'like'],
  [POST_ENGAGEMENT_EVENTS.UNLIKED, 'unlike'],
  [POST_ENGAGEMENT_EVENTS.BOOSTED, 'boost'],
  [POST_ENGAGEMENT_EVENTS.UNBOOSTED, 'unboost'],
  [POST_ENGAGEMENT_EVENTS.SAVED, 'save'],
  [POST_ENGAGEMENT_EVENTS.UNSAVED, 'unsave'],
  [POST_ENGAGEMENT_EVENTS.REPLIED, 'reply'],
];

function readEngagementCounts(data: PostEngagementCountsPayload): EngagementCounts {
  const counts: EngagementCounts = {};
  if (typeof data.likesCount === 'number') counts.likes = data.likesCount;
  if (typeof data.downvotesCount === 'number') counts.downvotes = data.downvotesCount;
  if (typeof data.boostsCount === 'number') counts.boosts = data.boostsCount;
  if (typeof data.repliesCount === 'number') counts.replies = data.repliesCount;
  if (typeof data.savesCount === 'number') counts.saves = data.savesCount;
  return counts;
}

interface FeedUpdateData {
  type?: string;
  posts?: FeedItem[];
  post?: FeedItem;
}

interface PresenceUpdateData {
  userId: string;
  online: boolean;
}

interface EngagementUpdate {
  counts: EngagementCounts;
  timestamp: number;
}

class SocketService {
  private socket: Socket | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = Number.POSITIVE_INFINITY;
  private readonly baseReconnectDelay = 1000;
  private currentUserId?: string;
  private currentToken?: string;
  private appStateSubscription: { remove: () => void } | null = null;
  // recentActions handled by echoGuard
  private feedUpdateQueue: Map<string, FeedItem[]> = new Map(); // Queue for batched feed updates
  private feedUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly FEED_UPDATE_DEBOUNCE_MS = 500; // Batch updates every 500ms
  private readonly MAX_BATCH_SIZE = 50; // Maximum items per batch
  // Subscription to flush queued feed updates when loading completes
  private feedLoadingUnsubscribe: (() => void) | null = null;
  // Queue for engagement updates to batch rapid changes
  private engagementUpdateQueue: Map<string, EngagementUpdate[]> = new Map();
  private engagementUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly ENGAGEMENT_UPDATE_DEBOUNCE_MS = 200; // Batch engagement updates every 200ms
  private readonly MAX_ENGAGEMENT_BATCH_SIZE = 100; // Maximum engagement updates per post
  private engagementPersistTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly LEGACY_ENGAGEMENT_PERSIST_KEY = 'mention-engagement-queue';
  private readonly ENGAGEMENT_PERSIST_DEBOUNCE_MS = 50;
  // Debounce timer for coalescing live-rooms update signals (participant churn)
  private liveRoomsRefetchTimer: ReturnType<typeof setTimeout> | null = null;
  // Post rooms the mounted screens have asked for; replayed on every connect.
  private joinedPostIds = new Set<string>();

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
  connect(userId: string, token: string): void {
    const credentialsChanged =
      this.currentUserId !== undefined &&
      (userId !== this.currentUserId || token !== this.currentToken);

    // The socket identity is the complete {viewerId, token} pair. A token
    // rotation must replace the Manager too, otherwise a later reconnect would
    // keep presenting the expired token captured at construction time.
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
      token === this.currentToken &&
      this.socket.active
    ) {
      return;
    }

    try {
      this.currentUserId = userId;
      this.currentToken = token;
      // Connect to the backend socket server
      // Clean up any existing disconnected/failed socket before creating a new one
      if (this.socket) {
        this.removeSocketEventListeners();
        this.socket.disconnect();
        this.socket = null;
      }

      this.socket = io(API_URL_SOCKET, {
        transports: ['websocket', 'polling'],
        auth: { token, userId },
        autoConnect: true,
        reconnection: true,
        reconnectionAttempts: this.maxReconnectAttempts,
        reconnectionDelay: this.baseReconnectDelay,
        reconnectionDelayMax: 30000,
      });

      this.setupSocketEventListeners();
      this.setupFeedLoadingWatcher();
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
    if (actorId && this.currentUserId && actorId === this.currentUserId) return true;
    return wasRecent(postId, action);
  }

  /**
   * Watch for feed loading state transitions (loading -> loaded)
   * and flush queued socket updates that were suppressed during loading
   */
  private setupFeedLoadingWatcher(): void {
    if (this.feedLoadingUnsubscribe) {
      this.feedLoadingUnsubscribe();
    }

    let previouslyLoading = new Set<string>();

    this.feedLoadingUnsubscribe = usePostsStore.subscribe((state) => {
      const currentlyLoading = new Set<string>();
      let hasJustFinished = false;

      for (const feedType of VALID_FEED_TYPES) {
        const feedKey = feedType as string;
        const feedUI = state.feedUI[feedKey];
        if (feedUI?.isLoading) {
          currentlyLoading.add(feedType);
        } else if (previouslyLoading.has(feedType) && this.feedUpdateQueue.has(feedType)) {
          hasJustFinished = true;
        }
      }

      previouslyLoading = currentlyLoading;

      if (hasJustFinished) {
        // Clear any pending debounce timer to avoid race conditions
        if (this.feedUpdateTimer) {
          clearTimeout(this.feedUpdateTimer);
          this.feedUpdateTimer = null;
        }
        // Process immediately when loading completes to avoid losing queued updates
        this.processFeedUpdateQueue();
      }
    });
  }

  /**
   * Disconnect from the socket server
   */
  disconnect() {
    if (this.socket) {
      // Remove all socket event listeners before disconnecting
      this.removeSocketEventListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    this.isConnected = false;
    // Process any pending feed updates before disconnecting
    if (this.feedUpdateTimer) {
      clearTimeout(this.feedUpdateTimer);
      this.processFeedUpdateQueue();
      this.feedUpdateTimer = null;
    }
    // Process any pending engagement updates before disconnecting
    if (this.engagementUpdateTimer) {
      clearTimeout(this.engagementUpdateTimer);
      this.processEngagementQueue();
      this.engagementUpdateTimer = null;
    }
    if (this.engagementPersistTimer) {
      clearTimeout(this.engagementPersistTimer);
      this.engagementPersistTimer = null;
    }
    // Clear pending live-rooms refetch debounce
    if (this.liveRoomsRefetchTimer) {
      clearTimeout(this.liveRoomsRefetchTimer);
      this.liveRoomsRefetchTimer = null;
    }
    // Clean up feed loading watcher
    if (this.feedLoadingUnsubscribe) {
      this.feedLoadingUnsubscribe();
      this.feedLoadingUnsubscribe = null;
    }
    // Clear queues
    this.feedUpdateQueue.clear();
    this.engagementUpdateQueue.clear();
    // A full teardown ends every subscription: `disconnect()` runs on sign-out
    // and on a credential change, and replaying one viewer's rooms onto the
    // next viewer's socket would be a subscription they never asked for.
    this.joinedPostIds.clear();

    // Clear all listener maps
    this.presenceListeners.clear();

    this.currentUserId = undefined;
    this.currentToken = undefined;
    this.reconnectAttempts = 0;
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
    // Clean up queued updates for this feed
    this.feedUpdateQueue.delete(feedType);
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
    for (const [event] of ENGAGEMENT_EVENT_ACTIONS) {
      this.socket.off(event);
    }
    this.socket.off('user:presence');
    this.socket.off('user:presenceBulk');
    this.socket.off(SOCKET_EVENT_ROOMS_LIVE_UPDATED);
    this.socket.io.off('reconnect_attempt', this.handleManagerReconnectAttempt);
    this.socket.io.off('reconnect', this.handleManagerReconnect);
    this.socket.io.off('reconnect_failed', this.handleManagerReconnectFailed);
  }

  /**
   * Setup socket event listeners
   */
  private setupSocketEventListeners() {
    if (!this.socket) return;

    this.socket.on('connect', () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.loadPersistedEngagementQueue();

      // Join feed rooms for real-time updates
      if (this.currentUserId && this.socket) {
        this.socket.emit('joinFeed', { userId: this.currentUserId });
      }

      // Re-assert the post rooms the mounted screens are still watching. The
      // server re-checks visibility on each one, so this grants nothing a fresh
      // join would not.
      for (const postId of this.joinedPostIds) {
        this.socket?.emit('joinPost', postId);
      }
    });

    this.socket.on('disconnect', () => {
      this.isConnected = false;
    });

    this.socket.on('connect_error', (error) => {
      this.isConnected = false;
      logger.warn('Socket connection failed', { error });
    });

    // Reconnection has exactly one owner: Socket.IO's Manager.
    this.socket.io.on('reconnect_attempt', this.handleManagerReconnectAttempt);
    this.socket.io.on('reconnect', this.handleManagerReconnect);
    this.socket.io.on('reconnect_failed', this.handleManagerReconnectFailed);

    // Feed update events
    this.socket.on('feed:updated', (data) => {
      this.handleFeedUpdate(data);
    });

    // Post engagement events, from the `post:<id>` rooms this client joined.
    for (const [event, action] of ENGAGEMENT_EVENT_ACTIONS) {
      this.socket.on(event, (data: PostEngagementCountsPayload) => {
        this.handleEngagementEvent(action, data);
      });
    }

    // Presence events
    this.socket.on('user:presence', (data) => {
      this.handlePresenceUpdate(data);
    });

    this.socket.on('user:presenceBulk', (data) => {
      this.handlePresenceBulkUpdate(data);
    });

    // Trends are NOT handled here. They travel on the public namespace
    // (`publicRealtimeService`) so signed-out visitors — who cannot connect to
    // this authenticated socket at all — receive them too. One owner, one path.

    // Live-rooms set changed → debounced silent refetch (coalesces participant churn)
    this.socket.on(SOCKET_EVENT_ROOMS_LIVE_UPDATED, () => {
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
      void useLiveRoomsStore.getState().fetchLiveRooms({ silent: true });
    }, ROOMS_LIVE_REFETCH_DEBOUNCE_MS);
  }

  /**
   * Setup global event listeners
   */
  private setupEventListeners(): void {
    // Handle app state changes (React Native)
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (nextAppState === 'active') {
        // App came to foreground - reconnect if needed
        if (
          !this.isConnected
          && this.socket
          && !this.socket.connected
          && !this.socket.active
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
    const { type, posts, post } = data || {};

    // Handle both single post and array of posts
    const postsArray = Array.isArray(posts) ? posts : (post ? [post] : []);

    // Type-safe feed type check
    if (!type || postsArray.length === 0) {
      return;
    }

    // Validate that type is a valid FeedType before casting
    if (!VALID_FEED_TYPES.includes(type)) {
      logger.warn('Invalid feed type', { feedType: type });
      return;
    }

    // Queue updates for batching
    const feedType = type as FeedType;
    const existingQueue = this.feedUpdateQueue.get(feedType);
    const queue = existingQueue ?? [];
    if (!existingQueue) {
      this.feedUpdateQueue.set(feedType, queue);
    }
    queue.push(...postsArray);
    
    // Clear existing timer
    if (this.feedUpdateTimer) {
      clearTimeout(this.feedUpdateTimer);
    }
    
    // Debounce updates - batch process after a short delay
    this.feedUpdateTimer = setTimeout(() => {
      this.processFeedUpdateQueue();
    }, this.FEED_UPDATE_DEBOUNCE_MS);
  }

  /**
   * Process queued feed updates in batches
   */
  private processFeedUpdateQueue() {
    if (this.feedUpdateQueue.size === 0) return;

    const store = usePostsStore.getState();

    // Process each feed type's queued posts
    this.feedUpdateQueue.forEach((posts, feedType) => {
      if (posts.length === 0) {
        this.feedUpdateQueue.delete(feedType);
        return;
      }

      const feedKey = feedType as string;
      const feedUI = store.feedUI[feedKey];
      if (!feedUI) {
        // Feed UI doesn't exist, remove queue entry entirely
        this.feedUpdateQueue.delete(feedType);
        return;
      }

      // Suppress socket updates during loading to prevent race conditions with fetch requests
      // When a feed is loading, the fetch response will include the posts, so we don't need
      // socket updates to add them again (which would cause duplicates)
      if (feedUI.isLoading) {
        // Keep posts in queue - they'll be processed after loading completes.
        // `posts` is this feed type's queued array (the forEach value), so it is
        // the current queue — cap its size to prevent memory issues.
        if (posts.length > this.MAX_BATCH_SIZE * 2) {
          this.feedUpdateQueue.set(feedType, posts.slice(-this.MAX_BATCH_SIZE)); // Keep last MAX_BATCH_SIZE items
        }
        return;
      }
      
      // Deduplicate posts in queue before adding
      const seen = new Map<string, FeedItem>();
      const uniquePosts: FeedItem[] = [];
      for (const p of posts) {
        const id = this.normalizePostId(p);

        if (id && id !== 'undefined' && id !== 'null' && id !== '') {
          if (!seen.has(id)) {
            seen.set(id, p);
            uniquePosts.push(p);
          }
        }
      }

      if (uniquePosts.length > 0) {
        // Batch add all posts at once
        store.addPostsToFeed(uniquePosts, feedType as FeedType);
      }
      
      // Clear queue for this feed type
      this.feedUpdateQueue.delete(feedType);
    });
    
    // Clear timer
    this.feedUpdateTimer = null;
  }

  /**
   * A post's counters moved. One entry point for all six engagement events,
   * because what a client does with them no longer depends on which one it was:
   * the name told the echo guard what to compare against, and the payload
   * carries the numbers.
   */
  private handleEngagementEvent(action: EchoAction, data: PostEngagementCountsPayload) {
    const postId = data?.postId;
    if (!postId) return;
    if (this.shouldIgnoreEcho(postId, action, data.actorId)) return;

    const counts = readEngagementCounts(data);
    // Every counter this post's author exposes was hidden, so there is nothing
    // to apply and nothing to queue.
    if (COUNT_FIELDS.every((field) => counts[field] === undefined)) return;

    this.queueEngagementUpdate(postId, counts);
  }

  /**
   * Queue engagement update for batching
   */
  private queueEngagementUpdate(postId: string, counts: EngagementCounts) {
    const existingQueue = this.engagementUpdateQueue.get(postId);
    const queue = existingQueue ?? [];
    if (!existingQueue) {
      this.engagementUpdateQueue.set(postId, queue);
    }

    // Limit queue size to prevent memory issues
    if (queue.length >= this.MAX_ENGAGEMENT_BATCH_SIZE) {
      // Keep only the most recent updates
      this.engagementUpdateQueue.set(postId, queue.slice(-50));
    }

    queue.push({ counts, timestamp: Date.now() });

    // Clear existing timer
    if (this.engagementUpdateTimer) {
      clearTimeout(this.engagementUpdateTimer);
    }

    // Process queue after short delay
    this.engagementUpdateTimer = setTimeout(() => {
      this.processEngagementQueue();
    }, this.ENGAGEMENT_UPDATE_DEBOUNCE_MS);

    this.persistEngagementQueue();
  }

  private persistEngagementQueue(): void {
    const viewerId = this.currentUserId;
    if (!viewerId) return;

    if (this.engagementPersistTimer) clearTimeout(this.engagementPersistTimer);
    const storageKey = engagementQueueStorageKey(viewerId);
    this.engagementPersistTimer = setTimeout(async () => {
      this.engagementPersistTimer = null;
      if (this.currentUserId !== viewerId) return;

      try {
        const serializable: Record<string, EngagementUpdate[]> = {};
        for (const [key, value] of this.engagementUpdateQueue) {
          serializable[key] = value;
        }
        if (Object.keys(serializable).length === 0) {
          await AsyncStorage.removeItem(storageKey);
          return;
        }
        await AsyncStorage.setItem(
          storageKey,
          serializeEngagementQueue(viewerId, serializable),
        );
      } catch (e) {
        logger.debug('Failed to persist engagement queue', { error: e });
      }
    }, this.ENGAGEMENT_PERSIST_DEBOUNCE_MS);
  }

  private async loadPersistedEngagementQueue(): Promise<void> {
    const viewerId = this.currentUserId;
    if (!viewerId) return;
    const storageKey = engagementQueueStorageKey(viewerId);

    try {
      // v1 had no owner metadata. It is unsafe to replay under any identity.
      void AsyncStorage.removeItem(this.LEGACY_ENGAGEMENT_PERSIST_KEY).catch(() => {});

      const raw = await AsyncStorage.getItem(storageKey);
      if (!raw) return;
      if (this.currentUserId !== viewerId) {
        await AsyncStorage.removeItem(storageKey);
        return;
      }

      const parsed = parseEngagementQueue<EngagementUpdate>(raw, viewerId);
      if (!parsed) {
        await AsyncStorage.removeItem(storageKey);
        return;
      }
      for (const [postId, updates] of Object.entries(parsed)) {
        if (Array.isArray(updates) && updates.length > 0) {
          this.engagementUpdateQueue.set(postId, updates);
        }
      }
      if (this.currentUserId !== viewerId) {
        this.engagementUpdateQueue.clear();
        await AsyncStorage.removeItem(storageKey);
        return;
      }
      this.processEngagementQueue();
      await AsyncStorage.removeItem(storageKey);
    } catch (e) {
      logger.debug('Failed to load persisted engagement queue', { error: e });
    }
  }

  /**
   * Process queued engagement updates in batches
   */
  private processEngagementQueue() {
    if (this.engagementUpdateQueue.size === 0) return;

    const viewerId = this.currentUserId;
    if (!viewerId) {
      this.engagementUpdateQueue.clear();
      return;
    }
    const store = usePostsStore.getState();

    // Process each post's queued updates
    this.engagementUpdateQueue.forEach((updates, postId) => {
      if (updates.length === 0) {
        this.engagementUpdateQueue.delete(postId);
        return;
      }

      // Fold the batch PER COUNTER, newest wins. Not per event type: a like and
      // a boost move different numbers, so keeping one winner overall would drop
      // whichever counter the loser carried. And not by applying each event in
      // turn, which is what the counts being authoritative makes pointless —
      // only the last value for each counter can survive, so compute it once and
      // touch the store once.
      //
      // Equal timestamps resolve to arrival order (`>=` would flip that): two
      // events stamped in the same millisecond arrived in the order they were
      // queued, and that is the better guess at which the server wrote last.
      const winning: EngagementCounts = {};
      const winningAt: Partial<Record<keyof EngagementCounts, number>> = {};
      for (const update of updates) {
        for (const field of COUNT_FIELDS) {
          const value = update.counts[field];
          if (value === undefined) continue;
          const previousAt = winningAt[field];
          if (previousAt !== undefined && update.timestamp < previousAt) continue;
          winning[field] = value;
          winningAt[field] = update.timestamp;
        }
      }

      // `viewerState` is deliberately untouched. Whether THIS viewer liked,
      // boosted or saved the post is theirs alone; a room event describes what
      // somebody else did, and the one time it describes this viewer it is an
      // echo of a state they already set optimistically.
      store.updatePostEverywhere(postId, (prev) => ({
        ...prev,
        engagement: { ...prev.engagement, ...winning },
      }));

      // Clear queue for this post
      this.engagementUpdateQueue.delete(postId);
    });

    // Clear timer
    this.engagementUpdateTimer = null;
    if (this.engagementPersistTimer) {
      clearTimeout(this.engagementPersistTimer);
      this.engagementPersistTimer = null;
    }
    AsyncStorage.removeItem(engagementQueueStorageKey(viewerId)).catch(() => {});
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
      listeners.forEach(callback => callback(online));
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
        listeners.forEach(callback => callback(online));
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
      const keysToRemove = Array.from(map.keys()).slice(0, map.size - SocketService.MAX_LISTENER_MAP_SIZE);
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

    // Tell server to subscribe to this user's presence
    if (this.socket?.connected) {
      this.socket.emit('subscribePresence', userId);
    }

    // Return unsubscribe function
    return () => {
      const listeners = this.presenceListeners.get(userId);
      if (listeners) {
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
    return new Promise((resolve) => {
      if (!this.socket?.connected) {
        resolve(false);
        return;
      }

      this.socket.emit('getPresence', userId, (data: { online: boolean }) => {
        resolve(data?.online ?? false);
      });
    });
  }

  /**
   * Get online status of multiple users
   */
  getPresenceBulk(userIds: string[]): Promise<Record<string, boolean>> {
    return new Promise((resolve) => {
      if (!this.socket?.connected) {
        resolve({});
        return;
      }

      this.socket.emit('getPresenceBulk', userIds, (data: Record<string, boolean>) => {
        resolve(data || {});
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
      maxReconnectAttempts: this.maxReconnectAttempts
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
