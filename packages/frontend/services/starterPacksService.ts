import { authenticatedClient } from '@/utils/api';

export interface StarterPackSummary {
  id?: string;
  _id?: string;
  name: string;
  description?: string;
  ownerOxyUserId?: string;
  memberOxyUserIds?: string[];
  memberCount?: number;
  useCount?: number;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface StarterPackCollection {
  items: StarterPackSummary[];
  total: number;
}

type StarterPackWriteBody = {
  name: string;
  description?: string;
  memberOxyUserIds: string[];
};

class StarterPacksService {
  async list(params?: { mine?: boolean; search?: string }) {
    const res = await authenticatedClient.get('/starter-packs', { params });
    return res.data as StarterPackCollection;
  }

  async get(id: string) {
    const res = await authenticatedClient.get(`/starter-packs/${id}`);
    return res.data as StarterPackSummary;
  }

  async create(body: StarterPackWriteBody) {
    const res = await authenticatedClient.post('/starter-packs', body);
    return res.data as StarterPackSummary;
  }

  async update(id: string, body: Partial<StarterPackWriteBody>) {
    const res = await authenticatedClient.put(`/starter-packs/${id}`, body);
    return res.data as StarterPackSummary;
  }

  async remove(id: string) {
    const res = await authenticatedClient.delete(`/starter-packs/${id}`);
    return res.data as { success?: boolean };
  }

  async addMembers(id: string, userIds: string[]) {
    const res = await authenticatedClient.post(`/starter-packs/${id}/members`, { userIds });
    return res.data as StarterPackSummary;
  }

  async removeMembers(id: string, userIds: string[]) {
    const res = await authenticatedClient.delete(`/starter-packs/${id}/members`, { data: { userIds } });
    return res.data as StarterPackSummary;
  }

  async use(id: string) {
    const res = await authenticatedClient.post(`/starter-packs/${id}/use`);
    return res.data as { memberOxyUserIds: string[]; useCount: number };
  }
}

export const starterPacksService = new StarterPacksService();
