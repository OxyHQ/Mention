import { authenticatedClient } from '@/utils/api';

class StarterPacksService {
  async list(params?: { mine?: boolean; search?: string }) {
    const res = await authenticatedClient.get('/starter-packs', { params });
    return res.data as { items: any[]; total: number };
  }

  async get(id: string) {
    const res = await authenticatedClient.get(`/starter-packs/${id}`);
    return res.data as any;
  }

  async create(body: { name: string; description?: string; memberOxyUserIds: string[] }) {
    const res = await authenticatedClient.post('/starter-packs', body);
    return res.data as any;
  }

  async update(id: string, body: Partial<{ name: string; description?: string; memberOxyUserIds: string[] }>) {
    const res = await authenticatedClient.put(`/starter-packs/${id}`, body);
    return res.data as any;
  }

  async remove(id: string) {
    const res = await authenticatedClient.delete(`/starter-packs/${id}`);
    return res.data as any;
  }

  async addMembers(id: string, userIds: string[]) {
    const res = await authenticatedClient.post(`/starter-packs/${id}/members`, { userIds });
    return res.data as any;
  }

  async removeMembers(id: string, userIds: string[]) {
    const res = await authenticatedClient.delete(`/starter-packs/${id}/members`, { data: { userIds } });
    return res.data as any;
  }

  async use(id: string) {
    const res = await authenticatedClient.post(`/starter-packs/${id}/use`);
    return res.data as { memberOxyUserIds: string[]; useCount: number };
  }
}

export const starterPacksService = new StarterPacksService();
