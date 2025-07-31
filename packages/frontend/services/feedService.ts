import {
  FeedRequest, 
  FeedResponse, 
  CreateReplyRequest, 
  CreateRepostRequest,
  CreatePostRequest,
  LikeRequest,
  UnlikeRequest
} from '@mention/shared-types';
import { authenticatedClient } from '../utils/api';

class FeedService {
  /**
   * Get feed data from backend using Oxy authenticated client
   */
  async getFeed(request: FeedRequest): Promise<any> {
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

    // Map feed types to backend endpoints (OxyServices client adds /api prefix automatically)
    let endpoint = '/feed/explore'; // default
    
    switch (request.type) {
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
        endpoint = '/feed/explore';
        break;
    }

    const response = await authenticatedClient.get(endpoint, { params });
    return response.data;
  }

  /**
   * Create a new post
   */
  async createPost(request: CreatePostRequest): Promise<{ success: boolean; post: any }> {
    // Map the request to match backend expectations
    const backendRequest = {
      text: request.content.text || '',
      media: request.content.images || [],
      hashtags: request.hashtags || [],
      mentions: request.mentions || [],
    };
    
    const response = await authenticatedClient.post('/posts', backendRequest);
    return { success: true, post: response.data };
  }

  /**
   * Create a reply
   */
  async createReply(request: CreateReplyRequest): Promise<{ success: boolean; reply: any }> {
    const response = await authenticatedClient.post('/feed/reply', request);
    return response.data;
  }

  /**
   * Create a repost
   */
  async createRepost(request: CreateRepostRequest): Promise<{ success: boolean; repost: any }> {
    const response = await authenticatedClient.post('/feed/repost', request);
    return response.data;
  }

  /**
   * Like a post/reply/repost
   */
  async likeItem(request: LikeRequest): Promise<{ success: boolean; liked: boolean }> {
    const response = await authenticatedClient.post('/feed/like', request);
    return response.data;
  }

  /**
   * Unlike a post/reply/repost
   */
  async unlikeItem(request: UnlikeRequest): Promise<{ success: boolean; liked: boolean }> {
    const response = await authenticatedClient.post('/feed/unlike', request);
    return response.data;
  }
}

export const feedService = new FeedService();
export default feedService; 