import {
  FeedRequest, 
  FeedResponse, 
  CreateReplyRequest, 
  CreateRepostRequest,
  LikeRequest,
  UnlikeRequest
} from '@mention/shared-types';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000/api';

class FeedService {
  private async makeRequest<T>(
    endpoint: string, 
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${API_BASE_URL}/feed${endpoint}`;
    
    const defaultHeaders = {
      'Content-Type': 'application/json',
    };

    const config: RequestInit = {
      ...options,
      headers: {
        ...defaultHeaders,
        ...options.headers,
      },
    };

    try {
      const response = await fetch(url, config);
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      return await response.json();
    } catch (error) {
      console.error('Feed service error:', error);
      throw error;
    }
  }

  /**
   * Get feed data from backend
   */
  async getFeed(request: FeedRequest): Promise<FeedResponse> {
    const params = new URLSearchParams();
    
    if (request.type) params.append('type', request.type);
    if (request.cursor) params.append('cursor', request.cursor);
    if (request.limit) params.append('limit', request.limit.toString());
    if (request.userId) params.append('userId', request.userId);
    if (request.filters) {
      Object.entries(request.filters).forEach(([key, value]) => {
        if (value !== undefined) {
          params.append(`filters[${key}]`, value.toString());
        }
      });
    }

    return this.makeRequest<FeedResponse>(`/feed?${params.toString()}`);
  }

  /**
   * Create a reply
   */
  async createReply(request: CreateReplyRequest): Promise<{ success: boolean; reply: any }> {
    return this.makeRequest('/reply', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /**
   * Create a repost
   */
  async createRepost(request: CreateRepostRequest): Promise<{ success: boolean; repost: any }> {
    return this.makeRequest('/repost', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /**
   * Like a post/reply/repost
   */
  async likeItem(request: LikeRequest): Promise<{ success: boolean; liked: boolean }> {
    return this.makeRequest('/like', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /**
   * Unlike a post/reply/repost
   */
  async unlikeItem(request: UnlikeRequest): Promise<{ success: boolean; liked: boolean }> {
    return this.makeRequest('/unlike', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }
}

export const feedService = new FeedService();
export default feedService; 