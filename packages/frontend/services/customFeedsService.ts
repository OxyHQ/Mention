import { authenticatedClient } from '@/utils/api';
import { FeedResponse } from '@mention/shared-types';

class CustomFeedsService {
  async list(params?: { mine?: boolean; publicOnly?: boolean; search?: string }): Promise<{ items: any[]; total: number }> {
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
}

export const customFeedsService = new CustomFeedsService();
