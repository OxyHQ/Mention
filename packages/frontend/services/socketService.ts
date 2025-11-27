import { API_URL_SOCKET } from '@/config';
import { FeedType } from '@mention/shared-types';
import { AppState, type AppStateStatus } from 'react-native';
import { io, Socket } from 'socket.io-client';
import { usePostsStore } from '../stores/postsStore';
import { wasRecent } from './echoGuard';

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
  
  // Queue for engagement updates to batch rapid changes
  private engagementUpdateQueue: Map<string, {
    type: 'like' | 'unlike' | 'repost' | 'unrepost' | 'save' | 'unsave' | 'reply';
    data: any;
    timestamp: number;
  }[]> = new Map();
  private engagementUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly ENGAGEMENT_UPDATE_DEBOUNCE_MS = 200; // Batch engagement updates every 200ms

  constructor() {
    this.setupEventListeners();
  }

  /**
   * Connect to the backend socket server
   */
  connect(userId?: string, token?: string) {
    if (this.socket?.connected) {
      console.log('Socket already connected');
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
        reconnectionDelay: this.reconnectDelay,
      });

      this.setupSocketEventListeners();
    } catch (error) {
      console.error('Error connecting to socket:', error);
    }
  }

  private shouldIgnoreEcho(postId: string, action: string, actorId?: string) {
    // If server includes actor identity and it's us, ignore
    if (actorId && this.currentUserId && actorId === this.currentUserId) return true;
    // Otherwise, ignore if we performed the same action very recently
    return wasRecent(postId, action as any);
  }

  /**
   * Disconnect from the socket server
   */
  disconnect() {
    if (this.socket) {
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
    // Clear queues
    this.feedUpdateQueue.clear();
    this.engagementUpdateQueue.clear();
    
    // Stop health monitoring
    this.stopHealthMonitoring();
  }
  
  /**
   * Join feed room for real-time updates (room-based subscription)
   */
  joinFeed(feedType: string): void {
    if (this.socket?.connected) {
      this.socket.emit('joinFeed', { feedType, userId: this.currentUserId });
    }
  }
  
  /**
   * Leave feed room
   */
  leaveFeed(feedType: string): void {
    if (this.socket?.connected) {
      this.socket.emit('leaveFeed', { feedType, userId: this.currentUserId });
    }
  }

  /**
   * Join a post room for real-time updates
   */
  joinPost(postId: string) {
    if (this.socket?.connected) {
      this.socket.emit('joinPost', postId);
    }
  }

  /**
   * Leave a post room
   */
  leavePost(postId: string) {
    if (this.socket?.connected) {
      this.socket.emit('leavePost', postId);
    }
  }

  /**
   * Setup socket event listeners
   */
  private setupSocketEventListeners() {
    if (!this.socket) return;

    this.socket.on('connect', () => {
      console.log('Socket connected');
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.lastPongTime = Date.now();
      this.startHealthMonitoring();
      
      // Join feed rooms for real-time updates
      if (this.currentUserId) {
        this.socket.emit('joinFeed', { userId: this.currentUserId });
      }
    });

    this.socket.on('disconnect', (reason) => {
      console.log('Socket disconnected:', reason);
      this.isConnected = false;
      this.stopHealthMonitoring();
    });
    
    // Handle pong for health monitoring
    this.socket.on('pong', () => {
      this.lastPongTime = Date.now();
    });

    this.socket.on('connect_error', (error) => {
      console.error('Socket connection error:', error);
      this.handleReconnect();
    });

    this.socket.on('reconnect', (attemptNumber) => {
      console.log('Socket reconnected after', attemptNumber, 'attempts');
      this.isConnected = true;
      this.reconnectAttempts = 0;
    });

    this.socket.on('reconnect_error', (error) => {
      console.error('Socket reconnection error:', error);
      this.handleReconnect();
    });

    this.socket.on('reconnect_failed', () => {
      console.error('Socket reconnection failed');
      this.isConnected = false;
    });

    // Feed update events
    this.socket.on('feed:updated', (data) => {
      console.log('Feed updated:', data);
      this.handleFeedUpdate(data);
    });

    // Post interaction events
    this.socket.on('post:liked', (data) => {
      console.log('Post liked:', data);
      this.handlePostLiked(data);
    });

    this.socket.on('post:unliked', (data) => {
      console.log('Post unliked:', data);
      this.handlePostUnliked(data);
    });

    this.socket.on('post:replied', (data) => {
      console.log('Post replied:', data);
      this.handlePostReplied(data);
    });

    this.socket.on('post:reposted', (data) => {
      console.log('Post reposted:', data);
      this.handlePostReposted(data);
    });

    this.socket.on('post:unreposted', (data) => {
      console.log('Post unreposted:', data);
      this.handlePostUnreposted(data);
    });

    this.socket.on('post:saved', (data) => {
      console.log('Post saved:', data);
      this.handlePostSaved(data);
    });

    this.socket.on('post:unsaved', (data) => {
      console.log('Post unsaved:', data);
      this.handlePostUnsaved(data);
    });
  }

  /**
   * Setup global event listeners
   */
  private setupEventListeners() {
    // Handle app state changes (React Native)
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (nextAppState === 'active') {
        // App came to foreground - reconnect if needed
        if (!this.isConnected && this.socket) {
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
  private handleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn('Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.calculateReconnectDelay(this.reconnectAttempts);
    console.log(`Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    
    setTimeout(() => {
      if (this.socket && !this.socket.connected) {
        this.socket.connect();
      }
    }, delay);
  }
  
  /**
   * Start connection health monitoring
   */
  private startHealthMonitoring(): void {
    if (this.connectionHealthCheckInterval) {
      clearInterval(this.connectionHealthCheckInterval);
    }
    
    this.connectionHealthCheckInterval = setInterval(() => {
      if (this.socket && this.socket.connected) {
        const timeSinceLastPong = Date.now() - this.lastPongTime;
        // If no pong received in 60 seconds, consider connection unhealthy
        if (timeSinceLastPong > 60000 && this.lastPongTime > 0) {
          console.warn('Socket connection health check failed, reconnecting...');
          this.socket.disconnect();
          this.handleReconnect();
        }
      }
    }, 30000) as unknown as ReturnType<typeof setInterval>; // Check every 30 seconds
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
  private handleFeedUpdate(data: any) {
    const { type, posts, post } = data || {};
    
    // Handle both single post and array of posts
    const postsArray = Array.isArray(posts) ? posts : (post ? [post] : []);
    
    // Type-safe feed type check
    if (!type || postsArray.length === 0) {
      if (postsArray.length === 0 && (posts || post)) {
        console.warn('Invalid feed update data received - empty posts array');
      }
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
        // Feed doesn't exist yet, clear queue
        this.feedUpdateQueue.set(feedType, []);
        return;
      }
      
      // Suppress socket updates during loading to prevent race conditions with fetch requests
      // When a feed is loading, the fetch response will include the posts, so we don't need
      // socket updates to add them again (which would cause duplicates)
      if (currentFeed.isLoading) {
        console.log(`[Socket] Suppressing feed update for type="${feedType}" - feed is currently loading`);
        // Keep posts in queue - they'll be processed after loading completes
        // But limit queue size to prevent memory issues
        if (this.feedUpdateQueue.get(feedType)!.length > 100) {
          console.warn(`[Socket] Feed update queue too large for type="${feedType}", clearing old items`);
          this.feedUpdateQueue.set(feedType, posts.slice(-50)); // Keep last 50 items
        }
        return;
      }
      
      // Build set of existing post IDs in the feed for duplicate detection
      const existingIds = new Set<string>();
      currentFeed.items.forEach((item: any) => {
        let id = '';
        if (item?.id) {
          id = String(item.id);
        } else if (item?._id) {
          const _id = item._id;
          id = typeof _id === 'object' && _id.toString 
            ? _id.toString() 
            : String(_id);
        }
        if (id && id !== 'undefined' && id !== 'null' && id !== '') {
          existingIds.add(id);
        }
      });
      
      // Deduplicate posts in queue before adding - use proper normalization
      const seen = new Map<string, any>();
      const uniquePosts: any[] = [];
      for (const p of posts) {
        let id = '';
        if (p?.id) {
          id = String(p.id);
        } else if (p?._id) {
          const _id = p._id;
          id = typeof _id === 'object' && _id.toString 
            ? _id.toString() 
            : String(_id);
        }
        
        if (id && id !== 'undefined' && id !== 'null' && id !== '') {
          // Check both queue duplicates and existing feed duplicates
          if (!seen.has(id) && !existingIds.has(id)) {
            seen.set(id, p);
            uniquePosts.push(p);
          } else if (existingIds.has(id)) {
            console.log(`[Socket] Filtered duplicate post from socket update: ${id} (already in feed)`);
          }
        }
      }
      
      if (uniquePosts.length > 0) {
        console.log(`[Socket] Adding ${uniquePosts.length} new posts to feed type="${feedType}" (filtered ${posts.length - uniquePosts.length} duplicates)`);
        // Batch add all posts at once
        store.addPostsToFeed(uniquePosts, feedType as FeedType);
      } else {
        console.log(`[Socket] No new posts to add for feed type="${feedType}" (all ${posts.length} were duplicates)`);
      }
      
      // Clear queue for this feed type
      this.feedUpdateQueue.set(feedType, []);
    });
    
    // Clear timer
    this.feedUpdateTimer = null;
  }

  /**
   * Handle post liked event - with batching and smart conflict resolution
   */
  private handlePostLiked(data: any) {
    const { postId, likesCount, userId, actorId } = data || {};
    if (!postId) return;
    const actualActorId = userId || actorId;
    
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
  private queueEngagementUpdate(postId: string, type: 'like' | 'unlike' | 'repost' | 'unrepost' | 'save' | 'unsave' | 'reply', data: any) {
    if (!this.engagementUpdateQueue.has(postId)) {
      this.engagementUpdateQueue.set(postId, []);
    }
    
    const queue = this.engagementUpdateQueue.get(postId)!;
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
              
              // Use server count if available, otherwise increment
              const newCount = data.likesCount ?? (prev.engagement.likes + 1);
              
              // If it's our action, echo guard should have suppressed it
              // But if it got through, don't override optimistic update
              if (isOurAction) {
                // Only update count if different (socket might have server-accurate count)
                if (prev.engagement.likes !== newCount) {
                  return {
                    ...prev,
                    // Keep our optimistic isLiked state
                    engagement: { ...prev.engagement, likes: newCount },
                  };
                }
                return null as any; // No change needed
              }
              
              // Other user's action - only update count, NOT isLiked state
              // Don't update if count is already correct or higher
              if (prev.engagement.likes >= newCount) return null as any;
              
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
              
              const newCount = data.likesCount ?? Math.max(0, prev.engagement.likes - 1);
              
              // If it's our action, echo guard should have suppressed it
              if (isOurAction) {
                // Only update count if different
                if (prev.engagement.likes !== newCount) {
                  return {
                    ...prev,
                    // Keep our optimistic isLiked state
                    engagement: { ...prev.engagement, likes: newCount },
                  };
                }
                return null as any; // No change needed
              }
              
              // Other user's action - only update count, NOT isLiked state
              // Don't update if count is already correct or lower
              if (prev.engagement.likes <= newCount) return null as any;
              
              return {
                ...prev,
                // Keep current isLiked state (it's about OUR state, not theirs)
                engagement: { ...prev.engagement, likes: newCount },
              };
            });
            break;
            
          case 'repost':
            store.updatePostEverywhere(postId, (prev) => {
              const newCount = data.repostsCount ?? (prev.engagement.reposts + 1);
              return {
                ...prev,
                isReposted: prev.isReposted || (data.userId === this.currentUserId),
                engagement: { ...prev.engagement, reposts: newCount },
              };
            });
            break;
            
          case 'unrepost':
            store.updatePostEverywhere(postId, (prev) => {
              const newCount = data.repostsCount ?? Math.max(0, prev.engagement.reposts - 1);
              return {
                ...prev,
                isReposted: prev.isReposted && (data.userId !== this.currentUserId),
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
      this.engagementUpdateQueue.set(postId, []);
    });
    
    // Clear timer
    this.engagementUpdateTimer = null;
  }

  /**
   * Handle post unliked event - with batching
   */
  private handlePostUnliked(data: any) {
    const { postId, likesCount, userId, actorId } = data || {};
    if (!postId) return;
    const actualActorId = userId || actorId;
    
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
  private handlePostReplied(data: any) {
    const { postId, userId: actorId, actorId: altActor } = data || {};
    if (!postId) return;
    if (this.shouldIgnoreEcho(postId, 'reply', actorId || altActor)) return;
    
    this.queueEngagementUpdate(postId, 'reply', { postId, actorId: actorId || altActor });
  }

  /**
   * Handle post reposted event - with batching
   */
  private handlePostReposted(data: any) {
    const { originalPostId, postId, repostsCount, userId: actorId, actorId: altActor } = data || {};
    const targetId = originalPostId || postId;
    if (!targetId) return;
    if (this.shouldIgnoreEcho(targetId, 'repost', actorId || altActor)) return;
    
    this.queueEngagementUpdate(targetId, 'repost', { 
      postId: targetId, 
      repostsCount,
      userId: actorId || altActor 
    });
  }

  /**
   * Handle post unreposted event - with batching
   */
  private handlePostUnreposted(data: any) {
    const { originalPostId, postId: pid, repostsCount, userId: actorId, actorId: altActor } = data || {};
    const postId = originalPostId || pid;
    if (!postId) return;
    if (this.shouldIgnoreEcho(postId, 'unrepost', actorId || altActor)) return;
    
    this.queueEngagementUpdate(postId, 'unrepost', { 
      postId, 
      repostsCount,
      userId: actorId || altActor 
    });
  }

  /**
   * Handle post saved event - with batching
   */
  private handlePostSaved(data: any) {
    const { postId, userId: actorId, actorId: altActor } = data || {};
    if (!postId) return;
    if (this.shouldIgnoreEcho(postId, 'save', actorId || altActor)) return;
    
    this.queueEngagementUpdate(postId, 'save', { 
      postId, 
      userId: actorId || altActor 
    });
  }

  /**
   * Handle post unsaved event - with batching
   */
  private handlePostUnsaved(data: any) {
    const { postId, userId: actorId, actorId: altActor } = data || {};
    if (!postId) return;
    if (this.shouldIgnoreEcho(postId, 'unsave', actorId || altActor)) return;
    
    this.queueEngagementUpdate(postId, 'unsave', { 
      postId, 
      userId: actorId || altActor 
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
  emit(event: string, data: any) {
    if (this.socket?.connected) {
      this.socket.emit(event, data);
    } else {
      console.warn('Socket not connected, cannot emit event:', event);
    }
  }

  /**
   * Listen to custom event
   */
  on(event: string, callback: (data: any) => void) {
    if (this.socket) {
      this.socket.on(event, callback);
    }
  }

  /**
   * Remove custom event listener
   */
  off(event: string, callback?: (data: any) => void) {
    if (this.socket) {
      if (callback) {
        this.socket.off(event, callback);
      } else {
        this.socket.off(event);
      }
    }
  }
}

// Create singleton instance
export const socketService = new SocketService();

// Export for use in components
export default socketService;
