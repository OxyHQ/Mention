import { io, Socket } from 'socket.io-client';
import { usePostsStore } from '../stores/postsStore';
import { FeedType } from '@mention/shared-types';
import { API_URL_SOCKET } from '@/config';
import { wasRecent } from './echoGuard';

class SocketService {
  private socket: Socket | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private currentUserId?: string;
  // recentActions handled by echoGuard

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
    });

    this.socket.on('disconnect', (reason) => {
      console.log('Socket disconnected:', reason);
      this.isConnected = false;
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
    // Handle app state changes
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', () => {
        if (!this.isConnected && this.socket) {
          this.socket.connect();
        }
      });

      window.addEventListener('blur', () => {
        // Optionally disconnect when app is in background
        // this.disconnect();
      });
    }
  }

  /**
   * Handle reconnection logic
   */
  private handleReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
      
      setTimeout(() => {
        if (this.socket && !this.socket.connected) {
          this.socket.connect();
        }
      }, this.reconnectDelay * this.reconnectAttempts);
    }
  }

  /**
   * Handle feed updates from socket
   */
  private handleFeedUpdate(data: any) {
    const { type, posts } = data || {};
    
    // Type-safe feed type check
    if (!type || !Array.isArray(posts)) {
      console.warn('Invalid feed update data received');
      return;
    }
    
    // Update the store with new feed data
    const store = usePostsStore.getState();
    
    // Type-safe access to feeds
    const feedType = type as FeedType;
    const currentFeed = store.feeds[feedType];
    
    if (currentFeed) {
      // Merge new posts with existing ones, avoiding duplicates
      const existingIds = new Set(currentFeed.items.map((post: any) => post.id));
      const newPosts = posts.filter((post: any) => !existingIds.has(post.id));
      
      if (newPosts.length > 0) {
        store.addPostToFeed(newPosts[0], feedType);
      }
    }
  }

  /**
   * Handle post liked event
   */
  private handlePostLiked(data: any) {
    const { postId, likesCount, userId: actorId, actorId: altActor } = data || {};
    if (!postId) return;
    if (this.shouldIgnoreEcho(postId, 'like', actorId || altActor)) return;
    const store = usePostsStore.getState();
    store.updatePostEverywhere(postId, (prev) => {
      // If already liked and likesCount not increasing, skip
      if (prev.isLiked && (likesCount == null || prev.engagement.likes >= likesCount)) return null as any;
      return {
        ...prev,
        isLiked: true,
        engagement: { ...prev.engagement, likes: likesCount ?? (prev.engagement.likes + 1) },
      };
    });
  }

  /**
   * Handle post unliked event
   */
  private handlePostUnliked(data: any) {
    const { postId, likesCount, userId: actorId, actorId: altActor } = data || {};
    if (!postId) return;
    if (this.shouldIgnoreEcho(postId, 'unlike', actorId || altActor)) return;
    const store = usePostsStore.getState();
    store.updatePostEverywhere(postId, (prev) => {
      if (!prev.isLiked && (likesCount == null || prev.engagement.likes <= likesCount)) return null as any;
      return {
        ...prev,
        isLiked: false,
        engagement: { ...prev.engagement, likes: likesCount ?? Math.max(0, prev.engagement.likes - 1) },
      };
    });
  }

  /**
   * Handle post replied event
   */
  private handlePostReplied(data: any) {
  const { postId, userId: actorId, actorId: altActor } = data || {};
    if (!postId) return;
  if (this.shouldIgnoreEcho(postId, 'reply', actorId || altActor)) return;
    const store = usePostsStore.getState();
    store.updatePostEverywhere(postId, (prev) => ({
      ...prev,
      engagement: { ...prev.engagement, replies: (prev.engagement.replies || 0) + 1 }
    }));
  }

  /**
   * Handle post reposted event
   */
  private handlePostReposted(data: any) {
    const { originalPostId, postId, userId: actorId, actorId: altActor } = data || {};
    const targetId = originalPostId || postId;
    if (!targetId) return;
    if (this.shouldIgnoreEcho(targetId, 'repost', actorId || altActor)) return;
    const store = usePostsStore.getState();
    store.updatePostEverywhere(targetId, (prev) => ({
      ...prev,
      engagement: { ...prev.engagement, reposts: (prev.engagement.reposts || 0) + 1 },
      isReposted: prev.isReposted || false,
    }));
  }

  /**
   * Handle post unreposted event
   */
  private handlePostUnreposted(data: any) {
  const { originalPostId, postId: pid, userId: actorId, actorId: altActor } = data || {};
  const postId = originalPostId || pid;
  if (!postId) return;
  if (this.shouldIgnoreEcho(postId, 'unrepost', actorId || altActor)) return;
    const store = usePostsStore.getState();
    store.updatePostEverywhere(postId, (prev) => ({
      ...prev,
      engagement: { ...prev.engagement, reposts: Math.max(0, (prev.engagement.reposts || 0) - 1) },
      isReposted: false
    }));
  }

  /**
   * Handle post saved event
   */
  private handlePostSaved(data: any) {
  const { postId, userId: actorId, actorId: altActor } = data || {};
  if (!postId) return;
  if (this.shouldIgnoreEcho(postId, 'save', actorId || altActor)) return;
    const store = usePostsStore.getState();
    store.updatePostEverywhere(postId, (prev) => ({ ...prev, isSaved: true }));
  }

  /**
   * Handle post unsaved event
   */
  private handlePostUnsaved(data: any) {
  const { postId, userId: actorId, actorId: altActor } = data || {};
  if (!postId) return;
  if (this.shouldIgnoreEcho(postId, 'unsave', actorId || altActor)) return;
    const store = usePostsStore.getState();
    store.updatePostEverywhere(postId, (prev) => ({ ...prev, isSaved: false }));
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
