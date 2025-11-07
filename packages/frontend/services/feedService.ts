import {
  FeedRequest, 
  FeedResponse, 
  CreateReplyRequest, 
  CreateRepostRequest,
  CreatePostRequest,
  CreateThreadRequest,
  LikeRequest,
  UnlikeRequest,
  FeedType
} from '@mention/shared-types';
import { authenticatedClient, API_CONFIG } from '../utils/api';

// Helper function to make unauthenticated requests using fetch
const makePublicRequest = async (endpoint: string, params?: Record<string, any>): Promise<any> => {
  // Ensure endpoint starts with /api
  const apiEndpoint = endpoint.startsWith('/api') ? endpoint : `/api${endpoint}`;
  
  // Handle baseURL - API_URL might already include /api/ in production
  let baseURL = API_CONFIG.baseURL;
  if (baseURL.endsWith('/api/')) {
    baseURL = baseURL.slice(0, -5); // Remove trailing /api/
  } else if (baseURL.endsWith('/api')) {
    baseURL = baseURL.slice(0, -4); // Remove trailing /api
  }
  
  const url = new URL(apiEndpoint, baseURL.endsWith('/') ? baseURL : `${baseURL}/`);
  
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.append(key, String(value));
      }
    });
  }
  
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    let errorData;
    try {
      errorData = JSON.parse(errorText);
    } catch {
      errorData = { message: errorText };
    }
    throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
  }
  
  return response.json();
};

class FeedService {
  /**
   * Get feed data from backend using Oxy authenticated client
   */
  async getFeed(request: FeedRequest): Promise<FeedResponse> {
    try {
      const params: any = {
        type: request.type // Always include type in params
      };
      
      if (request.cursor) params.cursor = request.cursor;
      if (request.limit) params.limit = request.limit;
      if (request.userId) params.userId = request.userId;
      if (request.filters) {
        Object.entries(request.filters).forEach(([key, value]) => {
          if (value !== undefined) {
            // Special handling for array-based filters
            if (key === 'authors' && Array.isArray(value)) {
              params[`filters[${key}]`] = (value as any[]).join(',');
            } else {
              params[`filters[${key}]`] = value as any;
            }
          }
        });
      }

      // Map feed types to backend endpoints
      let endpoint = '/feed/feed'; // default endpoint
      
      // Handle custom feed type - use dedicated timeline endpoint (backend-driven)
      if (request.type === 'custom' && request.filters?.customFeedId) {
        const feedId = request.filters.customFeedId;
        const timelineParams: any = {};
        if (request.cursor) timelineParams.cursor = request.cursor;
        if (request.limit) timelineParams.limit = request.limit;
        
        try {
          const response = await authenticatedClient.get(`/feeds/${feedId}/timeline`, { params: timelineParams });
          // Backend returns posts directly in FeedResponse format
          return response.data;
        } catch (authError: any) {
          // Custom feeds require authentication, so re-throw auth errors
          throw authError;
        }
      }
      
      switch (request.type) {
        case 'for_you':
          endpoint = '/feed/for-you';
          break;
        case 'following':
          endpoint = '/feed/following';
          break;
        case 'media':
          endpoint = '/feed/media';
          break;
        case 'replies':
          endpoint = '/feed/replies';
          break;
        case 'reposts':
          endpoint = '/feed/reposts';
          break;
        case 'posts':
          endpoint = '/feed/posts';
          break;
        case 'saved':
          endpoint = '/feed/feed'; // Use main feed endpoint with type='saved'
          // type is already set in params above
          break;
        case 'explore':
          endpoint = '/feed/explore';
          break;
        case 'mixed':
        default:
          endpoint = '/feed/feed';
          break;
      }

      try {
        const response = await authenticatedClient.get(endpoint, { params });
        return response.data;
      } catch (authError: any) {
        // If authentication fails (401/403) or network error, try public request
        const isAuthError = authError?.response?.status === 401 || authError?.response?.status === 403;
        const isNetworkError = !authError?.response && authError?.message?.includes('Network');
        
        if (isAuthError || isNetworkError) {
          console.log('🔄 Authenticated request failed, trying public request for feed:', {
            isAuthError,
            isNetworkError,
            error: authError?.message
          });
          try {
            return await makePublicRequest(endpoint, params);
          } catch (publicError: any) {
            console.error('❌ Public request also failed:', publicError);
            // If public request fails, throw the original auth error if it was an auth error
            // Otherwise throw the public error
            throw isAuthError ? authError : publicError;
          }
        }
        // Re-throw other errors (server errors, etc.)
        throw authError;
      }
    } catch (error: any) {
      console.error('❌ Error fetching feed:', error);
      console.error('Error details:', {
        message: error?.message,
        status: error?.response?.status,
        statusText: error?.response?.statusText,
        data: error?.response?.data,
        endpoint,
        params,
        stack: error?.stack
      });
      
      // Log the full error for debugging
      if (error?.response?.data) {
        console.error('Response data:', JSON.stringify(error.response.data, null, 2));
      }
      
      // Re-throw with more context
      const errorMessage = error?.response?.data?.message || error?.response?.data?.error || error?.message || 'Failed to fetch feed';
      const errorToThrow = new Error(errorMessage);
      (errorToThrow as any).status = error?.response?.status;
      (errorToThrow as any).originalError = error;
      throw errorToThrow;
    }
  }

  /**
   * Get user profile feed
   */
  async getUserFeed(userId: string, request: FeedRequest): Promise<FeedResponse> {
    try {
      const params: any = {};
      
      if (request.cursor) params.cursor = request.cursor;
      if (request.limit) params.limit = request.limit;
      if (request.type) params.type = request.type;
      if (request.filters) {
        Object.entries(request.filters).forEach(([key, value]) => {
          if (value !== undefined) {
            params[`filters[${key}]`] = value;
          }
        });
      }

      const response = await authenticatedClient.get(`/feed/user/${userId}`, { params });
      return response.data;
    } catch (error) {
      console.error('Error fetching user feed:', error);
      throw new Error('Failed to fetch user feed');
    }
  }

  /**
   * Create a new post
   */
  async createPost(request: CreatePostRequest): Promise<{ success: boolean; post: any }> {
    try {
      // Map the request to match backend expectations
      const backendRequest: any = {
        content: {
          text: request.content.text || '',
          media: request.content.media || [],
          // Include poll if provided  
          ...(request.content.poll && { poll: request.content.poll }),
          // Include location if provided
          ...(request.content.location && { location: request.content.location }),
          ...(request.content.sources && request.content.sources.length > 0 && { sources: request.content.sources }),
          ...(request.content.article && Object.keys(request.content.article).length > 0 && { article: request.content.article }),
          ...(request.content.attachments && request.content.attachments.length > 0 && { attachments: request.content.attachments })
        },
        hashtags: request.hashtags || [],
        mentions: request.mentions || [],
        visibility: request.visibility || 'public',
        parentPostId: request.parentPostId,
        threadId: request.threadId
      };
      
      const response = await authenticatedClient.post('/posts', backendRequest);
      return { success: true, post: response.data };
    } catch (error) {
      console.error('Error creating post:', error);
      throw new Error('Failed to create post');
    }
  }

  /**
   * Create a thread of posts
   */
  async createThread(request: CreateThreadRequest): Promise<{ success: boolean; posts: any[] }> {
    try {
      const response = await authenticatedClient.post('/posts/thread', request);
      return { success: true, posts: response.data };
    } catch (error) {
      console.error('Error creating thread:', error);
      throw new Error('Failed to create thread');
    }
  }

  /**
   * Create a reply
   */
  async createReply(request: CreateReplyRequest): Promise<{ success: boolean; reply: any }> {
    try {
      const backendRequest = {
        postId: request.postId,
        content: request.content, // Send complete content structure
        mentions: request.mentions || [],
        hashtags: request.hashtags || []
      };

      const response = await authenticatedClient.post('/feed/reply', backendRequest);
      return { success: true, reply: response.data };
    } catch (error) {
      console.error('Error creating reply:', error);
      throw new Error('Failed to create reply');
    }
  }

  /**
   * Create a repost
   */
  async createRepost(request: CreateRepostRequest): Promise<{ success: boolean; repost: any }> {
    try {
      const backendRequest = {
        originalPostId: request.originalPostId,
        content: request.content?.text || '',
        mentions: request.mentions || [],
        hashtags: request.hashtags || []
      };

      const response = await authenticatedClient.post('/feed/repost', backendRequest);
      return { success: true, repost: response.data };
    } catch (error) {
      console.error('Error creating repost:', error);
      throw new Error('Failed to create repost');
    }
  }

  /**
   * Like a post
   */
  async likeItem(request: LikeRequest): Promise<{ success: boolean; data: any }> {
    try {
      const response = await authenticatedClient.post(`/posts/${request.postId}/like`);
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Error liking post:', error);
      throw new Error('Failed to like post');
    }
  }

  /**
   * Unlike a post
   */
  async unlikeItem(request: UnlikeRequest): Promise<{ success: boolean; data: any }> {
    try {
      const response = await authenticatedClient.delete(`/posts/${request.postId}/like`);
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Error unliking post:', error);
      throw new Error('Failed to unlike post');
    }
  }

  /**
   * Save a post
   */
  async saveItem(request: { postId: string }): Promise<{ success: boolean; data: any }> {
    try {
      // Use posts controller which persists bookmarks used by /posts/saved
      const response = await authenticatedClient.post(`/posts/${request.postId}/save`);
      return { success: true, data: response.data };
    } catch (error) {
      console.error('❌ Error saving post:', error);
      throw new Error('Failed to save post');
    }
  }

  /**
   * Remove save from a post
   */
  async unsaveItem(request: { postId: string }): Promise<{ success: boolean; data: any }> {
    try {
      // Use posts controller which persists bookmarks used by /posts/saved
      const response = await authenticatedClient.delete(`/posts/${request.postId}/save`);
      return { success: true, data: response.data };
    } catch (error) {
      console.error('❌ Error removing save:', error);
      throw new Error('Failed to remove save');
    }
  }

  /**
   * Unrepost a post
   */
  async unrepostItem(request: { postId: string }): Promise<{ success: boolean; data: any }> {
    try {
      const response = await authenticatedClient.delete(`/feed/${request.postId}/repost`);
      return { success: true, data: response.data };
    } catch (error) {
      console.error('❌ Error unreposting:', error);
      throw new Error('Failed to unrepost');
    }
  }


  /**
   * Get saved posts for current user
   */
  async getSavedPosts(request: { page?: number; limit?: number; search?: string } = {}): Promise<{ success: boolean; data: any }> {
    try {
      const params: any = {
        page: request.page || 1,
        limit: request.limit || 20
      };
      
      if (request.search) {
        params.search = request.search;
      }
      
      const response = await authenticatedClient.get('/posts/saved', {
        params
      });
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Error fetching saved posts:', error);
      throw new Error('Failed to fetch saved posts');
    }
  }

  /**
   * Get post by ID
   */
  async getPostById(postId: string): Promise<any> {
    try {
      // Prefer transformed feed item for consistent user/enagement shape
      try {
        const transformed = await authenticatedClient.get(`/feed/item/${postId}`);
        return transformed.data;
      } catch (e) {
        // Fallback to posts endpoint for backward compatibility
        const response = await authenticatedClient.get(`/posts/${postId}`);
        return response.data;
      }
    } catch (error: any) {
      // Preserve original error (especially for 404 handling)
      if (error?.response?.status === 404) {
        // Don't log 404s - post may have been deleted
        throw error; // Re-throw original Axios error to preserve status
      }
      console.error('Error fetching post:', error);
      throw error; // Re-throw original error instead of creating new one
    }
  }

  /**
   * Delete a post
   */
  async deletePost(postId: string): Promise<{ success: boolean }> {
    try {
      await authenticatedClient.delete(`/posts/${postId}`);
      return { success: true };
    } catch (error) {
      console.error('Error deleting post:', error);
      throw new Error('Failed to delete post');
    }
  }

  /**
   * Get posts by hashtag
   */
  async getPostsByHashtag(hashtag: string, request: FeedRequest): Promise<FeedResponse> {
    try {
      const params: any = {};
      
      if (request.cursor) params.cursor = request.cursor;
      if (request.limit) params.limit = request.limit;
      
      const response = await authenticatedClient.get(`/posts/hashtag/${hashtag}`, { params });
      return response.data;
    } catch (error) {
      console.error('Error fetching posts by hashtag:', error);
      throw new Error('Failed to fetch posts by hashtag');
    }
  }

  /**
   * Get posts by user mentions
   */
  async getPostsByMentions(userId: string, request: FeedRequest): Promise<FeedResponse> {
    try {
      const params: any = {};
      
      if (request.cursor) params.cursor = request.cursor;
      if (request.limit) params.limit = request.limit;
      
      const response = await authenticatedClient.get(`/posts/mentions/${userId}`, { params });
      return response.data;
    } catch (error) {
      console.error('Error fetching posts by mentions:', error);
      throw new Error('Failed to fetch posts by mentions');
    }
  }

  /**
   * Get users who liked a post
   */
  async getPostLikes(postId: string, cursor?: string, limit: number = 50): Promise<{
    users: Array<{
      id: string;
      name: string;
      handle: string;
      avatar: string;
      verified: boolean;
    }>;
    hasMore: boolean;
    nextCursor?: string;
    totalCount: number;
  }> {
    try {
      const params: any = { limit };
      if (cursor) params.cursor = cursor;
      
      const response = await authenticatedClient.get(`/posts/${postId}/likes`, { params });
      return response.data;
    } catch (error) {
      console.error('Error fetching post likes:', error);
      throw new Error('Failed to fetch post likes');
    }
  }

  /**
   * Get users who reposted a post
   */
  async getPostReposts(postId: string, cursor?: string, limit: number = 50): Promise<{
    users: Array<{
      id: string;
      name: string;
      handle: string;
      avatar: string;
      verified: boolean;
    }>;
    hasMore: boolean;
    nextCursor?: string;
    totalCount: number;
  }> {
    try {
      const params: any = { limit };
      if (cursor) params.cursor = cursor;
      
      const response = await authenticatedClient.get(`/posts/${postId}/reposts`, { params });
      return response.data;
    } catch (error) {
      console.error('Error fetching post reposts:', error);
      throw new Error('Failed to fetch post reposts');
    }
  }
}

export const feedService = new FeedService(); 
