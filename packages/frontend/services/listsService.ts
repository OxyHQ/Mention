import { authenticatedClient } from '@/utils/api';
import { notifyListChanged } from '@/services/listMutations';

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
    const created = res.data as any;
    // A new list affects the list collection; pass its id so a screen already
    // viewing it (rare on create) also refreshes.
    notifyListChanged(created?._id || created?.id || null);
    return created;
  }

  async update(id: string, body: Partial<{ title: string; description?: string; isPublic: boolean; memberOxyUserIds: string[] }>) {
    const res = await authenticatedClient.put(`/lists/${id}`, body);
    notifyListChanged(id);
    return res.data as any;
  }

  async remove(id: string) {
    const res = await authenticatedClient.delete(`/lists/${id}`);
    notifyListChanged(id);
    return res.data as any;
  }

  async addMembers(id: string, userIds: string[]) {
    const res = await authenticatedClient.post(`/lists/${id}/members`, { userIds });
    notifyListChanged(id);
    return res.data as any;
  }

  async removeMembers(id: string, userIds: string[]) {
    const res = await authenticatedClient.delete(`/lists/${id}/members`, { data: { userIds } });
    notifyListChanged(id);
    return res.data as any;
  }

  async getTimeline(id: string, params?: { cursor?: string; limit?: number }) {
    const res = await authenticatedClient.get(`/lists/${id}/timeline`, { params });
    return res.data as any;
  }
}

export const listsService = new ListsService();
