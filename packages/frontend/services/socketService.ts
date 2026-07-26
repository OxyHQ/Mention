import { API_URL_SOCKET } from '@/config';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { FeedType } from '@mention/shared-types';
import { AppState, type AppStateStatus } from 'react-native';
import { io, Socket } from 'socket.io-client';
import { usePostsStore } from '../stores/postsStore';
import type { FeedItem } from '@/db';
import { useTrendsStore } from '@/store/trendsStore';
import { useLiveRoomsStore } from '@/stores/liveRoomsStore';
import {
  SOCKET_EVENT_TRENDS_UPDATED,
  SOCKET_EVENT_ROOMS_LIVE_UPDATED,
  ROOMS_LIVE_REFETCH_DEBOUNCE_MS,
} from '@/constants/realtimeEvents';
import { createScopedLogger } from '@/lib/logger';
import { wasRecent, type EchoAction } from './echoGuard';
import {
  engagementQueueStorageKey,
  parseEngagementQueue,
  serializeEngagementQueue,
} from './engagementQueuePersistence';

const logger = createScopedLogger('SocketService');

// Valid feed types for validation
const VALID_FEED_TYPES: string[] = ['posts', 'media', 'replies', 'likes', 'boosts', 'mixed', 'for_you', 'following', 'saved', 'explore', 'custom'];

// TypeScript interfaces for socket events
interface EngagementEventData {
  postId?: string;
  originalPostId?: string;
  userId?: string;
  actorId?: string;
  likesCount?: number;
  boostsCount?: number;
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
  type: 'like' | 'unlike' | 'boost' | 'unboost' | 'save' | 'unsave' | 'reply';
  data: EngagementEventData;
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
   * Extract actor ID from event data (handles both userId and actorId fields)
   */
  private getActorId(data: EngagementEventData): string | undefined {
    return data.userId || data.actorId;
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

      this.socket = io(API_URL_SOCKET || process.env.EXPO_PUBLIC_BACKEND_URL || 'http://localhost:3000', {
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
      logger.error('Connection error', { error });
    }
  }

  private shouldIgnoreEcho(postId: string, action: string, actorId?: string) {
    // If server includes actor identity and it's us, ignore
    if (actorId && this.currentUserId && actorId === this.currentUserId) return true;
    // Otherwise, ignore if we performed the same action very recently
    return wasRecent(postId, action as EchoAction);
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
   * Join a post room for real-time updates
   */
  joinPost(postId: string): void {
    if (!this.socket?.connected) return;
    this.socket.emit('joinPost', postId);
  }

  /**
   * Leave a post room
   */
  leavePost(postId: string): void {
    if (!this.socket?.connected) return;
    this.socket.emit('leavePost', postId);
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
    this.socket.off('post:liked');
    this.socket.off('post:unliked');
    this.socket.off('post:replied');
    this.socket.off('post:boosted');
    this.socket.off('post:unboosted');
    this.socket.off('post:saved');
    this.socket.off('post:unsaved');
    this.socket.off('user:presence');
    this.socket.off('user:presenceBulk');
    this.socket.off(SOCKET_EVENT_TRENDS_UPDATED);
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

    // Post interaction events
    this.socket.on('post:liked', (data) => {
      this.handlePostLiked(data);
    });

    this.socket.on('post:unliked', (data) => {
      this.handlePostUnliked(data);
    });

    this.socket.on('post:replied', (data) => {
      this.handlePostReplied(data);
    });

    this.socket.on('post:boosted', (data) => {
      this.handlePostBoosted(data);
    });

    this.socket.on('post:unboosted', (data) => {
      this.handlePostUnboosted(data);
    });

    this.socket.on('post:saved', (data) => {
      this.handlePostSaved(data);
    });

    this.socket.on('post:unsaved', (data) => {
      this.handlePostUnsaved(data);
    });

    // Presence events
    this.socket.on('user:presence', (data) => {
      this.handlePresenceUpdate(data);
    });

    this.socket.on('user:presenceBulk', (data) => {
      this.handlePresenceBulkUpdate(data);
    });

    // Trends recalculated server-side → silently refetch the trends list
    this.socket.on(SOCKET_EVENT_TRENDS_UPDATED, () => {
      this.handleTrendsUpdated();
    });

    // Live-rooms set changed → debounced silent refetch (coalesces participant churn)
    this.socket.on(SOCKET_EVENT_ROOMS_LIVE_UPDATED, () => {
      this.handleLiveRoomsUpdated();
    });
  }

  /**
   * Trends recalculated server-side. Payload is a signal only — refetch silently.
   */
  private handleTrendsUpdated(): void {
    void useTrendsStore.getState().fetchTrends({ silent: true });
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
   * Handle post liked event - with batching and smart conflict resolution
   */
  private handlePostLiked(data: EngagementEventData) {
    const { postId, likesCount } = data || {};
    if (!postId) return;
    const actualActorId = this.getActorId(data);

    // Skip echo - our own actions are handled by optimistic updates
    if (this.shouldIgnoreEcho(postId, 'like', actualActorId)) return;

    // Queue for batching
    this.queueEngagementUpdate(postId, 'like', {
      postId,
      likesCount,
      userId: actualActorId,
      actorId: actualActorId
    });
  }
  
  /**
   * Queue engagement update for batching
   */
  private queueEngagementUpdate(postId: string, type: 'like' | 'unlike' | 'boost' | 'unboost' | 'save' | 'unsave' | 'reply', data: EngagementEventData) {
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

    queue.push({ type, data, timestamp: Date.now() });

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
      
      // Get the most recent update for each type (latest wins)
      const latestByType = new Map<string, typeof updates[0]>();
      updates.forEach(update => {
        const existing = latestByType.get(update.type);
        if (!existing || update.timestamp > existing.timestamp) {
          latestByType.set(update.type, update);
        }
      });
      
      // Apply updates, preferring server counts when available
      latestByType.forEach((update, type) => {
        const { data } = update;
        
        switch (type) {
          case 'like':
            store.updatePostEverywhere(postId, (prev) => {
              const actorId = data.actorId || data.userId;
              const isOurAction = actorId === viewerId;
              const currentLikes = prev.engagement?.likes ?? 0;

              // Use server count if available, otherwise increment
              const newCount = data.likesCount ?? (currentLikes + 1);

              // If it's our action, echo guard should have suppressed it
              // But if it got through, don't override optimistic update
              if (isOurAction) {
                // Only update count if different (socket might have server-accurate count)
                if (currentLikes !== newCount) {
                  return {
                    ...prev,
                    // Keep our optimistic isLiked state
                    engagement: { ...prev.engagement, likes: newCount },
                  };
                }
                return prev; // No change needed
              }

              // Other user's action - only update count, NOT isLiked state
              // Don't update if count is already correct or higher
              if (currentLikes >= newCount) return prev;

              return {
                ...prev,
                // Keep current isLiked state (it's about OUR state, not theirs)
                engagement: { ...prev.engagement, likes: newCount },
              };
            });
            break;
            
          case 'unlike':
            store.updatePostEverywhere(postId, (prev) => {
              const actorId = data.actorId || data.userId;
              const isOurAction = actorId === viewerId;
              const currentLikes = prev.engagement?.likes ?? 0;

              const newCount = data.likesCount ?? Math.max(0, currentLikes - 1);

              // If it's our action, echo guard should have suppressed it
              if (isOurAction) {
                // Only update count if different
                if (currentLikes !== newCount) {
                  return {
                    ...prev,
                    // Keep our optimistic isLiked state
                    engagement: { ...prev.engagement, likes: newCount },
                  };
                }
                return prev; // No change needed
              }

              // Other user's action - only update count, NOT isLiked state
              // Don't update if count is already correct or lower
              if (currentLikes <= newCount) return prev;

              return {
                ...prev,
                // Keep current isLiked state (it's about OUR state, not theirs)
                engagement: { ...prev.engagement, likes: newCount },
              };
            });
            break;
            
          case 'boost':
            store.updatePostEverywhere(postId, (prev) => {
              const actorId = data.actorId || data.userId;
              const isOurAction = actorId === viewerId;

              // Use server count if available, otherwise increment
              const currentBoosts = prev.engagement?.boosts ?? 0;
              const newCount = data.boostsCount ?? (currentBoosts + 1);

              // If it's our action, echo guard should have suppressed it
              // But if it got through, don't override optimistic update
              if (isOurAction) {
                // Only update count if different (socket might have server-accurate count)
                if (currentBoosts !== newCount) {
                  return {
                    ...prev,
                    // Keep our optimistic isBoosted state
                    engagement: { ...prev.engagement, boosts: newCount },
                  };
                }
                return prev; // No change needed
              }

              // Other user's action - only update count, NOT isBoosted state
              // Don't update if count is already correct or higher
              if (currentBoosts >= newCount) return prev;

              return {
                ...prev,
                // Keep current isBoosted state (it's about OUR state, not theirs)
                engagement: { ...prev.engagement, boosts: newCount },
              };
            });
            break;

          case 'unboost':
            store.updatePostEverywhere(postId, (prev) => {
              const actorId = data.actorId || data.userId;
              const isOurAction = actorId === viewerId;

              const currentBoosts = prev.engagement?.boosts ?? 0;
              const newCount = data.boostsCount ?? Math.max(0, currentBoosts - 1);

              // If it's our action, echo guard should have suppressed it
              if (isOurAction) {
                // Only update count if different
                if (currentBoosts !== newCount) {
                  return {
                    ...prev,
                    // Keep our optimistic isBoosted state
                    engagement: { ...prev.engagement, boosts: newCount },
                  };
                }
                return prev; // No change needed
              }

              // Other user's action - only update count, NOT isBoosted state
              // Don't update if count is already correct or lower
              if (currentBoosts <= newCount) return prev;

              return {
                ...prev,
                // Keep current isBoosted state (it's about OUR state, not theirs)
                engagement: { ...prev.engagement, boosts: newCount },
              };
            });
            break;
            
          case 'save':
            // Only update if it's not our own action (optimistic update already handled it)
            if (data.userId !== viewerId) {
              store.updatePostEverywhere(postId, (prev) => ({ ...prev, isSaved: true }));
            }
            break;
            
          case 'unsave':
            if (data.userId !== viewerId) {
              store.updatePostEverywhere(postId, (prev) => ({ ...prev, isSaved: false }));
            }
            break;
            
          case 'reply':
            store.updatePostEverywhere(postId, (prev) => ({
              ...prev,
              engagement: { ...prev.engagement, replies: (prev.engagement.replies || 0) + 1 }
            }));
            break;
        }
      });
      
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

  /**
   * Handle post unliked event - with batching
   */
  private handlePostUnliked(data: EngagementEventData) {
    const { postId, likesCount } = data || {};
    if (!postId) return;
    const actualActorId = this.getActorId(data);

    // Skip echo - our own actions are handled by optimistic updates
    if (this.shouldIgnoreEcho(postId, 'unlike', actualActorId)) return;

    this.queueEngagementUpdate(postId, 'unlike', {
      postId,
      likesCount,
      userId: actualActorId,
      actorId: actualActorId
    });
  }

  /**
   * Handle post replied event - with batching
   */
  private handlePostReplied(data: EngagementEventData) {
    const { postId } = data || {};
    if (!postId) return;
    const actualActorId = this.getActorId(data);
    if (this.shouldIgnoreEcho(postId, 'reply', actualActorId)) return;

    this.queueEngagementUpdate(postId, 'reply', { postId, actorId: actualActorId });
  }

  /**
   * Handle post boosted event - with batching
   */
  private handlePostBoosted(data: EngagementEventData) {
    const { originalPostId, postId, boostsCount } = data || {};
    const targetId = originalPostId || postId;
    if (!targetId) return;
    const actualActorId = this.getActorId(data);
    if (this.shouldIgnoreEcho(targetId, 'boost', actualActorId)) return;

    this.queueEngagementUpdate(targetId, 'boost', {
      postId: targetId,
      boostsCount,
      userId: actualActorId
    });
  }

  /**
   * Handle post unboosted event - with batching
   */
  private handlePostUnboosted(data: EngagementEventData) {
    const { originalPostId, postId, boostsCount } = data || {};
    const targetId = originalPostId || postId;
    if (!targetId) return;
    const actualActorId = this.getActorId(data);
    if (this.shouldIgnoreEcho(targetId, 'unboost', actualActorId)) return;

    this.queueEngagementUpdate(targetId, 'unboost', {
      postId: targetId,
      boostsCount,
      userId: actualActorId
    });
  }

  /**
   * Handle post saved event - with batching
   */
  private handlePostSaved(data: EngagementEventData) {
    const { postId } = data || {};
    if (!postId) return;
    const actualActorId = this.getActorId(data);
    if (this.shouldIgnoreEcho(postId, 'save', actualActorId)) return;

    this.queueEngagementUpdate(postId, 'save', {
      postId,
      userId: actualActorId
    });
  }

  /**
   * Handle post unsaved event - with batching
   */
  private handlePostUnsaved(data: EngagementEventData) {
    const { postId } = data || {};
    if (!postId) return;
    const actualActorId = this.getActorId(data);
    if (this.shouldIgnoreEcho(postId, 'unsave', actualActorId)) return;

    this.queueEngagementUpdate(postId, 'unsave', {
      postId,
      userId: actualActorId
    });
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
