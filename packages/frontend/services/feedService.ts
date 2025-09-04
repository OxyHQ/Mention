import {
  FeedRequest, 
  FeedResponse, 
  CreateReplyRequest, 
  CreateRepostRequest,
  CreatePostRequest,
  LikeRequest,
  UnlikeRequest,
  FeedType
} from '@mention/shared-types';
import { authenticatedClient } from '../utils/api';

class FeedService {
  /**
   * Get feed data from backend using Oxy authenticated client
   */
  async getFeed(request: FeedRequest): Promise<FeedResponse> {
    try {
      console.log('🔍 FeedService.getFeed called with request:', request);
      
      const params: any = {};
      
      if (request.cursor) params.cursor = request.cursor;
      if (request.limit) params.limit = request.limit;
      if (request.userId) params.userId = request.userId;
      if (request.filters) {
        Object.entries(request.filters).forEach(([key, value]) => {
          if (value !== undefined) {
            params[`filters[${key}]`] = value;
          }
        });
      }

      // Map feed types to backend endpoints
      let endpoint = '/feed/feed'; // default endpoint
      
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
        case 'mixed':
        default:
          endpoint = '/feed/feed';
          break;
      }

      console.log('📡 Making API call to:', endpoint, 'with params:', params);
      const response = await authenticatedClient.get(endpoint, { params });
      console.log('✅ API response received:', response.data);
      return response.data;
    } catch (error) {
      console.error('❌ Error fetching feed:', error);
      throw new Error('Failed to fetch feed');
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
      const backendRequest = {
        text: request.content.text || '',
        media: request.content.images || [],
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
   * Create a reply
   */
  async createReply(request: CreateReplyRequest): Promise<{ success: boolean; reply: any }> {
    try {
      const backendRequest = {
        postId: request.postId,
        content: request.content?.text || '',
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
        comment: request.content?.text || '',
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
      console.log('💾 FeedService.saveItem called with:', request);
      // Use posts controller which persists bookmarks used by /posts/saved
      const response = await authenticatedClient.post(`/posts/${request.postId}/save`);
      console.log('✅ Save API response:', response.data);
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
      console.log('🗑️ FeedService.unsaveItem called with:', request);
      // Use posts controller which persists bookmarks used by /posts/saved
      const response = await authenticatedClient.delete(`/posts/${request.postId}/save`);
      console.log('✅ Unsave API response:', response.data);
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
      console.log('🔄 FeedService.unrepostItem called with:', request);
      const response = await authenticatedClient.delete(`/feed/${request.postId}/repost`);
      console.log('✅ Unrepost API response:', response.data);
      return { success: true, data: response.data };
    } catch (error) {
      console.error('❌ Error unreposting:', error);
      throw new Error('Failed to unrepost');
    }
  }


  /**
   * Get saved posts for current user
   */
  async getSavedPosts(request: { page?: number; limit?: number } = {}): Promise<{ success: boolean; data: any }> {
    try {
      const response = await authenticatedClient.get('/posts/saved', {
        params: {
          page: request.page || 1,
          limit: request.limit || 20
        }
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
    } catch (error) {
      console.error('Error fetching post:', error);
      throw new Error('Failed to fetch post');
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
}

export const feedService = new FeedService(); 
