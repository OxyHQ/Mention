import { authenticatedClient } from '@/utils/api';

class LabelerService {
  async list(params?: { search?: string }): Promise<{ items: any[]; total: number }> {
    const res = await authenticatedClient.get('/labelers', { params });
    return res.data;
  }

  async get(id: string): Promise<any> {
    const res = await authenticatedClient.get(`/labelers/${id}`);
    return res.data;
  }

  async create(data: { name: string; description?: string; labelDefinitions?: any[] }): Promise<any> {
    const res = await authenticatedClient.post('/labelers', data);
    return res.data;
  }

  async subscribe(id: string): Promise<{ success: boolean; subscribed: boolean }> {
    const res = await authenticatedClient.post(`/labelers/${id}/subscribe`);
    return res.data;
  }

  async unsubscribe(id: string): Promise<{ success: boolean; subscribed: boolean }> {
    const res = await authenticatedClient.delete(`/labelers/${id}/subscribe`);
    return res.data;
  }

  async applyLabel(labelerId: string, data: { targetType: string; targetId: string; labelSlug: string; reason?: string }): Promise<any> {
    const res = await authenticatedClient.post(`/labelers/${labelerId}/labels`, data);
    return res.data;
  }

  async removeLabel(labelId: string): Promise<{ success: boolean }> {
    const res = await authenticatedClient.delete(`/labelers/labels/${labelId}`);
    return res.data;
  }

  async getContentLabels(type: string, id: string): Promise<{ items: any[]; total: number }> {
    const res = await authenticatedClient.get(`/labelers/content/${type}/${id}`);
    return res.data;
  }

  async updatePreferences(labelActions: Array<{ labelerId: string; labelSlug: string; action: string }>): Promise<{ success: boolean }> {
    const res = await authenticatedClient.put('/labelers/preferences', { labelActions });
    return res.data;
  }
}

export const labelerService = new LabelerService();
