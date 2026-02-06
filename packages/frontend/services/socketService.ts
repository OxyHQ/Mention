import { API_URL_SOCKET } from '@/config';
import { FeedType } from '@mention/shared-types';
import { AppState, type AppStateStatus } from 'react-native';
import { io, Socket } from 'socket.io-client';
import { usePostsStore } from '../stores/postsStore';
import { wasRecent } from './echoGuard';

// Valid feed types for validation
const VALID_FEED_TYPES: string[] = ['posts', 'media', 'replies', 'likes', 'reposts', 'mixed', 'for_you', 'following', 'saved', 'explore', 'custom'];

// TypeScript interfaces for socket events
interface EngagementEventData {
  postId?: string;
  originalPostId?: string;
  userId?: string;
  actorId?: string;
  likesCount?: number;
  repostsCount?: number;
}

interface FeedUpdateData {
  type?: string;
  posts?: any[];
  post?: any;
}

interface PresenceUpdateData {
  userId: string;
  online: boolean;
}

interface FollowEventData {
  followerId: string;
  followingId: string;
  followerCount?: number;
  followingCount?: number;
}

interface EngagementUpdate {
  type: 'like' | 'unlike' | 'repost' | 'unrepost' | 'save' | 'unsave' | 'reply';
  data: EngagementEventData;
  timestamp: number;
}

class SocketService {
  private socket: Socket | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10; // Increased from 5
  private baseReconnectDelay = 1000; // Base delay in ms
  private maxReconnectDelay = 30000; // Maximum delay: 30 seconds
  private currentUserId?: string;
  private appStateSubscription: { remove: () => void } | null = null;
  // recentActions handled by echoGuard
  private feedUpdateQueue: Map<string, any[]> = new Map(); // Queue for batched feed updates
  private feedUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly FEED_UPDATE_DEBOUNCE_MS = 500; // Batch updates every 500ms
  private readonly MAX_BATCH_SIZE = 50; // Maximum items per batch
  private connectionHealthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private lastPongTime: number = 0;
  private consecutiveHealthFailures: number = 0;
  private readonly MAX_HEALTH_FAILURES = 3; // Require 3 consecutive failures before disconnecting
  private healthCheckDisconnect: boolean = false; // Track if disconnect was triggered by health check
  
  // Subscription to flush queued feed updates when loading completes
  private feedLoadingUnsubscribe: (() => void) | null = null;
  // Queue for engagement updates to batch rapid changes
  private engagementUpdateQueue: Map<string, EngagementUpdate[]> = new Map();
  private engagementUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly ENGAGEMENT_UPDATE_DEBOUNCE_MS = 200; // Batch engagement updates every 200ms
  private readonly MAX_ENGAGEMENT_BATCH_SIZE = 100; // Maximum engagement updates per post

  constructor() {
    this.setupEventListeners();
  }

  /**
   * Normalize post ID from various formats
   */
  private normalizePostId(item: any): string {
    if (!item) return '';

    if (item?.id) {
      return String(item.id);
    }

    if (item?._id) {
      const _id = item._id;
      return typeof _id === 'object' && _id.toString
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
  connect(userId?: string, token?: string): void {
    if (this.socket?.connected) {
      return;
    }

    try {
      if (userId) this.currentUserId = userId;
      // Connect to the backend socket server
      this.socket = io(API_URL_SOCKET || process.env.EXPO_PUBLIC_BACKEND_URL || 'http://localhost:3000', {
        transports: ['websocket', 'polling'],
        auth: token ? { token, userId } : (userId ? { userId } : undefined),
        autoConnect: true,
        reconnection: true,
        reconnectionAttempts: this.maxReconnectAttempts,
        reconnectionDelay: this.baseReconnectDelay,
      });

      this.setupSocketEventListeners();
      this.setupFeedLoadingWatcher();
    } catch (error) {
      console.error('[SocketService] Connection error:', error);
    }
  }

  private shouldIgnoreEcho(postId: string, action: string, actorId?: string) {
    // If server includes actor identity and it's us, ignore
    if (actorId && this.currentUserId && actorId === this.currentUserId) return true;
    // Otherwise, ignore if we performed the same action very recently
    return wasRecent(postId, action as any);
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
        const feed = state.feeds[feedType as FeedType];
        if (feed?.isLoading) {
          currentlyLoading.add(feedType);
        } else if (previouslyLoading.has(feedType) && this.feedUpdateQueue.has(feedType)) {
          hasJustFinished = true;
        }
      }

      previouslyLoading = currentlyLoading;

      if (hasJustFinished) {
        setTimeout(() => this.processFeedUpdateQueue(), 100);
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
      this.isConnected = false;
    }
    // Clean up AppState listener
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }
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
    this.followListeners.clear();

    // Stop health monitoring
    this.stopHealthMonitoring();
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
    this.socket.off('pong');
    this.socket.off('connect_error');
    this.socket.off('reconnect');
    this.socket.off('reconnect_error');
    this.socket.off('reconnect_failed');
    this.socket.off('feed:updated');
    this.socket.off('post:liked');
    this.socket.off('post:unliked');
    this.socket.off('post:replied');
    this.socket.off('post:reposted');
    this.socket.off('post:unreposted');
    this.socket.off('post:saved');
    this.socket.off('post:unsaved');
    this.socket.off('user:presence');
    this.socket.off('user:presenceBulk');
    this.socket.off('user:followed');
    this.socket.off('user:unfollowed');
  }

  /**
   * Setup socket event listeners
   */
  private setupSocketEventListeners() {
    if (!this.socket) return;

    this.socket.on('connect', () => {
      this.isConnected = true;
      // Only reset reconnect attempts if this wasn't a health-check-triggered reconnect
      if (!this.healthCheckDisconnect) {
        this.reconnectAttempts = 0;
      }
      this.healthCheckDisconnect = false;
      this.lastPongTime = Date.now();
      this.consecutiveHealthFailures = 0;
      this.startHealthMonitoring();

      // Join feed rooms for real-time updates
      if (this.currentUserId && this.socket) {
        this.socket.emit('joinFeed', { userId: this.currentUserId });
      }
    });

    this.socket.on('disconnect', () => {
      this.isConnected = false;
      this.stopHealthMonitoring();
    });
    
    // Handle pong for health monitoring (custom event from server if available)
    this.socket.on('pong', () => {
      this.lastPongTime = Date.now();
    });

    // Also listen to Socket.IO's transport-level pong for health monitoring
    // This fires automatically as part of Socket.IO's built-in heartbeat
    if (this.socket.io?.engine) {
      this.socket.io.engine.on('pong', () => {
        this.lastPongTime = Date.now();
      });
    }

    this.socket.on('connect_error', () => {
      this.handleReconnect();
    });

    this.socket.on('reconnect', () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
    });

    this.socket.on('reconnect_error', () => {
      this.handleReconnect();
    });

    this.socket.on('reconnect_failed', () => {
      this.isConnected = false;
    });

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

    this.socket.on('post:reposted', (data) => {
      this.handlePostReposted(data);
    });

    this.socket.on('post:unreposted', (data) => {
      this.handlePostUnreposted(data);
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

    // Follow events
    this.socket.on('user:followed', (data) => {
      this.handleUserFollowed(data);
    });

    this.socket.on('user:unfollowed', (data) => {
      this.handleUserUnfollowed(data);
    });
  }

  /**
   * Setup global event listeners
   */
  private setupEventListeners(): void {
    // Handle app state changes (React Native)
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (nextAppState === 'active') {
        // App came to foreground - reconnect if needed
        if (!this.isConnected && this.socket && !this.socket.connected) {
          console.log('[SocketService] App resumed, reconnecting...');
          this.socket.connect();
        }
      } else if (nextAppState === 'background' || nextAppState === 'inactive') {
        // App went to background - optionally disconnect
        // this.disconnect();
      }
    };

    this.appStateSubscription = AppState.addEventListener('change', handleAppStateChange);
  }

  /**
   * Calculate exponential backoff delay with jitter
   */
  private calculateReconnectDelay(attempt: number): number {
    // Exponential backoff: baseDelay * 2^attempt
    const exponentialDelay = this.baseReconnectDelay * Math.pow(2, attempt);
    // Add jitter (random 0-25% of delay) to prevent thundering herd
    const jitter = Math.random() * 0.25 * exponentialDelay;
    // Cap at maximum delay
    return Math.min(exponentialDelay + jitter, this.maxReconnectDelay);
  }

  /**
   * Handle reconnection logic with exponential backoff
   */
  private handleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn('[SocketService] Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.calculateReconnectDelay(this.reconnectAttempts);

    setTimeout(() => {
      if (!this.socket || this.socket.connected) return;
      console.log(`[SocketService] Reconnecting (attempt ${this.reconnectAttempts})...`);
      this.socket.connect();
    }, delay);
  }
  
  /**
   * Start connection health monitoring
   * Uses Socket.IO's built-in transport-level ping/pong via the socket's
   * `active` state rather than custom events (which servers may not handle).
   * Requires multiple consecutive failures before triggering a reconnect
   * to avoid false positives causing reconnection loops.
   */
  private startHealthMonitoring(): void {
    if (this.connectionHealthCheckInterval) {
      clearInterval(this.connectionHealthCheckInterval);
    }

    this.consecutiveHealthFailures = 0;

    this.connectionHealthCheckInterval = setInterval(() => {
      if (!this.socket?.connected) {
        return;
      }

      const timeSinceLastPong = Date.now() - this.lastPongTime;
      // If no pong received in 60 seconds, count as a failure
      if (timeSinceLastPong > 60000 && this.lastPongTime > 0) {
        this.consecutiveHealthFailures++;

        if (this.consecutiveHealthFailures >= this.MAX_HEALTH_FAILURES) {
          console.warn(`[SocketService] Connection unhealthy after ${this.MAX_HEALTH_FAILURES} consecutive failures, reconnecting...`);
          this.healthCheckDisconnect = true;
          this.stopHealthMonitoring();
          this.socket.disconnect();
          this.handleReconnect();
        }
      } else {
        // Connection is healthy, reset failure counter
        this.consecutiveHealthFailures = 0;
      }
    }, 30000) as unknown as ReturnType<typeof setInterval>;
  }
  
  /**
   * Stop connection health monitoring
   */
  private stopHealthMonitoring(): void {
    if (this.connectionHealthCheckInterval) {
      clearInterval(this.connectionHealthCheckInterval);
      this.connectionHealthCheckInterval = null;
    }
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
      console.warn('[SocketService] Invalid feed type:', type);
      return;
    }

    // Queue updates for batching
    const feedType = type as FeedType;
    if (!this.feedUpdateQueue.has(feedType)) {
      this.feedUpdateQueue.set(feedType, []);
    }
    
    const queue = this.feedUpdateQueue.get(feedType)!;
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
      if (posts.length === 0) return;
      
      const currentFeed = store.feeds[feedType as FeedType];
      if (!currentFeed) {
        // Feed doesn't exist, remove queue entry entirely
        this.feedUpdateQueue.delete(feedType);
        return;
      }
      
      // Suppress socket updates during loading to prevent race conditions with fetch requests
      // When a feed is loading, the fetch response will include the posts, so we don't need
      // socket updates to add them again (which would cause duplicates)
      if (currentFeed.isLoading) {
        // Keep posts in queue - they'll be processed after loading completes
        // But limit queue size to prevent memory issues
        if (this.feedUpdateQueue.get(feedType)!.length > this.MAX_BATCH_SIZE * 2) {
          this.feedUpdateQueue.set(feedType, posts.slice(-this.MAX_BATCH_SIZE)); // Keep last MAX_BATCH_SIZE items
        }
        return;
      }
      
      // Build set of existing post IDs in the feed for duplicate detection
      const existingIds = new Set<string>();
      currentFeed.items.forEach((item: any) => {
        const id = this.normalizePostId(item);
        if (id && id !== 'undefined' && id !== 'null' && id !== '') {
          existingIds.add(id);
        }
      });

      // Deduplicate posts in queue before adding - use proper normalization
      const seen = new Map<string, any>();
      const uniquePosts: any[] = [];
      for (const p of posts) {
        const id = this.normalizePostId(p);

        if (id && id !== 'undefined' && id !== 'null' && id !== '') {
          // Check both queue duplicates and existing feed duplicates
          if (!seen.has(id) && !existingIds.has(id)) {
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
  private queueEngagementUpdate(postId: string, type: 'like' | 'unlike' | 'repost' | 'unrepost' | 'save' | 'unsave' | 'reply', data: EngagementEventData) {
    if (!this.engagementUpdateQueue.has(postId)) {
      this.engagementUpdateQueue.set(postId, []);
    }

    const queue = this.engagementUpdateQueue.get(postId)!;

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
  }
  
  /**
   * Process queued engagement updates in batches
   */
  private processEngagementQueue() {
    if (this.engagementUpdateQueue.size === 0) return;
    
    const store = usePostsStore.getState();
    
    // Process each post's queued updates
    this.engagementUpdateQueue.forEach((updates, postId) => {
      if (updates.length === 0) return;
      
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
              const isOurAction = actorId === this.currentUserId;
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
              const isOurAction = actorId === this.currentUserId;
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
            
          case 'repost':
            store.updatePostEverywhere(postId, (prev) => {
              const actorId = data.actorId || data.userId;
              const isOurAction = actorId === this.currentUserId;

              // Use server count if available, otherwise increment
              const currentReposts = prev.engagement?.reposts ?? 0;
              const newCount = data.repostsCount ?? (currentReposts + 1);

              // If it's our action, echo guard should have suppressed it
              // But if it got through, don't override optimistic update
              if (isOurAction) {
                // Only update count if different (socket might have server-accurate count)
                if (currentReposts !== newCount) {
                  return {
                    ...prev,
                    // Keep our optimistic isReposted state
                    engagement: { ...prev.engagement, reposts: newCount },
                  };
                }
                return prev; // No change needed
              }

              // Other user's action - only update count, NOT isReposted state
              // Don't update if count is already correct or higher
              if (currentReposts >= newCount) return prev;

              return {
                ...prev,
                // Keep current isReposted state (it's about OUR state, not theirs)
                engagement: { ...prev.engagement, reposts: newCount },
              };
            });
            break;

          case 'unrepost':
            store.updatePostEverywhere(postId, (prev) => {
              const actorId = data.actorId || data.userId;
              const isOurAction = actorId === this.currentUserId;

              const currentReposts = prev.engagement?.reposts ?? 0;
              const newCount = data.repostsCount ?? Math.max(0, currentReposts - 1);

              // If it's our action, echo guard should have suppressed it
              if (isOurAction) {
                // Only update count if different
                if (currentReposts !== newCount) {
                  return {
                    ...prev,
                    // Keep our optimistic isReposted state
                    engagement: { ...prev.engagement, reposts: newCount },
                  };
                }
                return prev; // No change needed
              }

              // Other user's action - only update count, NOT isReposted state
              // Don't update if count is already correct or lower
              if (currentReposts <= newCount) return prev;

              return {
                ...prev,
                // Keep current isReposted state (it's about OUR state, not theirs)
                engagement: { ...prev.engagement, reposts: newCount },
              };
            });
            break;
            
          case 'save':
            // Only update if it's not our own action (optimistic update already handled it)
            if (data.userId !== this.currentUserId) {
              store.updatePostEverywhere(postId, (prev) => ({ ...prev, isSaved: true }));
            }
            break;
            
          case 'unsave':
            if (data.userId !== this.currentUserId) {
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
   * Handle post reposted event - with batching
   */
  private handlePostReposted(data: EngagementEventData) {
    const { originalPostId, postId, repostsCount } = data || {};
    const targetId = originalPostId || postId;
    if (!targetId) return;
    const actualActorId = this.getActorId(data);
    if (this.shouldIgnoreEcho(targetId, 'repost', actualActorId)) return;

    this.queueEngagementUpdate(targetId, 'repost', {
      postId: targetId,
      repostsCount,
      userId: actualActorId
    });
  }

  /**
   * Handle post unreposted event - with batching
   */
  private handlePostUnreposted(data: EngagementEventData) {
    const { originalPostId, postId, repostsCount } = data || {};
    const targetId = originalPostId || postId;
    if (!targetId) return;
    const actualActorId = this.getActorId(data);
    if (this.shouldIgnoreEcho(targetId, 'unrepost', actualActorId)) return;

    this.queueEngagementUpdate(targetId, 'unrepost', {
      postId: targetId,
      repostsCount,
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

  // Follow event listeners
  private followListeners: Map<string, Set<(data: FollowEventData) => void>> = new Map();

  /**
   * Handle user followed event
   */
  private handleUserFollowed(data: FollowEventData) {
    if (!data) return;

    const eventData: FollowEventData = {
      followerId: data.followerId,
      followingId: data.followingId,
      followerCount: data.followerCount ?? 0,
      followingCount: data.followingCount ?? 0
    };

    // Notify listeners for the user who was followed (their follower count changed)
    const followedListeners = this.followListeners.get(data.followingId);
    if (followedListeners) {
      followedListeners.forEach(callback => callback(eventData));
    }

    // Notify listeners for the user who followed (their following count changed)
    const followerListeners = this.followListeners.get(data.followerId);
    if (followerListeners) {
      followerListeners.forEach(callback => callback(eventData));
    }
  }

  /**
   * Handle user unfollowed event
   */
  private handleUserUnfollowed(data: FollowEventData) {
    if (!data) return;

    const eventData: FollowEventData = {
      followerId: data.followerId,
      followingId: data.followingId,
      followerCount: data.followerCount ?? 0,
      followingCount: data.followingCount ?? 0
    };

    // Same as followed - notify both parties
    const unfollowedListeners = this.followListeners.get(data.followingId);
    if (unfollowedListeners) {
      unfollowedListeners.forEach(callback => callback(eventData));
    }

    const unfollowerListeners = this.followListeners.get(data.followerId);
    if (unfollowerListeners) {
      unfollowerListeners.forEach(callback => callback(eventData));
    }
  }

  /**
   * Subscribe to a user's online presence
   */
  subscribeToPresence(userId: string, callback: (online: boolean) => void): () => void {
    if (!this.presenceListeners.has(userId)) {
      this.presenceListeners.set(userId, new Set());
    }
    this.presenceListeners.get(userId)!.add(callback);

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
   * Subscribe to follow count updates for a user
   */
  subscribeToFollowUpdates(userId: string, callback: (data: FollowEventData) => void): () => void {
    if (!this.followListeners.has(userId)) {
      this.followListeners.set(userId, new Set());
    }
    this.followListeners.get(userId)!.add(callback);

    // Return unsubscribe function
    return () => {
      const listeners = this.followListeners.get(userId);
      if (listeners) {
        listeners.delete(callback);
        if (listeners.size === 0) {
          this.followListeners.delete(userId);
        }
      }
    };
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
  emit(event: string, data?: any): void {
    if (!this.socket?.connected) return;
    this.socket.emit(event, data);
  }

  /**
   * Listen to custom event
   */
  on(event: string, callback: (data: any) => void): void {
    if (!this.socket) return;
    this.socket.on(event, callback);
  }

  /**
   * Remove custom event listener
   */
  off(event: string, callback?: (data: any) => void): void {
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
