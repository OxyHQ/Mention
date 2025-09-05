import { authenticatedClient } from '@/utils/api';

class ListsService {
  async list(params?: { mine?: boolean; publicOnly?: boolean }) {
    const res = await authenticatedClient.get('/lists', { params });
    return res.data as { items: any[]; total: number };
  }

  async get(id: string) {
    const res = await authenticatedClient.get(`/lists/${id}`);
    return res.data as any;
  }

  async create(body: { title: string; description?: string; isPublic: boolean; memberOxyUserIds: string[] }) {
    const res = await authenticatedClient.post('/lists', body);
    return res.data as any;
  }

  async update(id: string, body: Partial<{ title: string; description?: string; isPublic: boolean; memberOxyUserIds: string[] }>) {
    const res = await authenticatedClient.put(`/lists/${id}`, body);
    return res.data as any;
  }

  async remove(id: string) {
    const res = await authenticatedClient.delete(`/lists/${id}`);
    return res.data as any;
  }

  async addMembers(id: string, userIds: string[]) {
    const res = await authenticatedClient.post(`/lists/${id}/members`, { userIds });
    return res.data as any;
  }

  async removeMembers(id: string, userIds: string[]) {
    const res = await authenticatedClient.delete(`/lists/${id}/members`, { data: { userIds } });
    return res.data as any;
  }

  async getTimeline(id: string, params?: { cursor?: string; limit?: number }) {
    const res = await authenticatedClient.get(`/lists/${id}/timeline`, { params });
    return res.data as any;
  }
}

export const listsService = new ListsService();

