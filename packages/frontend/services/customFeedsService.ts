import { authenticatedClient } from '@/utils/api';
import type { FeedResponse } from '@mention/shared-types';
>>>>>>> origin/main

class CustomFeedsService {
  async list(params?: { mine?: boolean; publicOnly?: boolean; search?: string; userId?: string }): Promise<{ items: any[]; total: number }> {
    const res = await authenticatedClient.get('/feeds', { params });
    return res.data;
  }

  async get(id: string): Promise<any> {
    const res = await authenticatedClient.get(`/feeds/${id}`);
    return res.data;
  }

  async create(req: any): Promise<any> {
    const res = await authenticatedClient.post('/feeds', req);
    return res.data;
  }

  async update(id: string, req: any): Promise<any> {
    const res = await authenticatedClient.put(`/feeds/${id}`, req);
    return res.data;
  }

  async remove(id: string): Promise<{ success: boolean }> {
    const res = await authenticatedClient.delete(`/feeds/${id}`);
    return res.data;
  }

  async addMembers(id: string, userIds: string[]): Promise<any> {
    const res = await authenticatedClient.post(`/feeds/${id}/members`, { userIds });
    return res.data;
  }

  async removeMembers(id: string, userIds: string[]): Promise<any> {
    const res = await authenticatedClient.delete(`/feeds/${id}/members`, { data: { userIds } });
    return res.data;
  }

  async getTimeline(id: string, params?: { cursor?: string; limit?: number }): Promise<FeedResponse> {
    const res = await authenticatedClient.get(`/feeds/${id}/timeline`, { params });
    return res.data;
  }

  async likeFeed(id: string): Promise<{ success: boolean; liked: boolean; likeCount: number }> {
    const res = await authenticatedClient.post(`/feeds/${id}/like`);
    return res.data;
  }

  async unlikeFeed(id: string): Promise<{ success: boolean; liked: boolean; likeCount: number }> {
    const res = await authenticatedClient.delete(`/feeds/${id}/like`);
    return res.data;
  }

  async getMarketplace(params?: { category?: string; search?: string; sortBy?: string; page?: number; limit?: number }): Promise<{ items: any[]; total: number }> {
    const res = await authenticatedClient.get('/feeds/marketplace', { params });
    return res.data;
  }

  async getMarketplaceCategories(): Promise<{ categories: Array<{ category: string; count: number }> }> {
    const res = await authenticatedClient.get('/feeds/marketplace/categories');
    return res.data;
  }

  async getReviews(feedId: string, params?: { page?: number; limit?: number }): Promise<{ reviews: any[]; total: number; page: number; totalPages: number }> {
    const res = await authenticatedClient.get(`/feeds/${feedId}/reviews`, { params });
    return res.data;
  }

  async submitReview(feedId: string, data: { rating: number; reviewText?: string }): Promise<any> {
    const res = await authenticatedClient.post(`/feeds/${feedId}/reviews`, data);
    return res.data;
  }
}

export const customFeedsService = new CustomFeedsService();
