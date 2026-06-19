import { authenticatedClient } from '@/utils/api';
import { notifyListChanged } from '@/services/listMutations';

export interface MentionListOwner {
  username?: string;
  displayName?: string;
  avatar?: string | null;
}

export interface MentionList {
  id?: string;
  _id?: string;
  title: string;
  description?: string;
  isPublic?: boolean;
  ownerOxyUserId?: string;
  owner?: MentionListOwner;
  memberOxyUserIds?: string[];
  memberCount?: number;
  likeCount?: number;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface MentionListCollection {
  items: MentionList[];
  total: number;
}

export interface MentionListTimeline {
  items: unknown[];
  cursor?: string;
  nextCursor?: string;
  hasMore?: boolean;
  [key: string]: unknown;
}

type ListWriteBody = {
  title: string;
  description?: string;
  isPublic: boolean;
  memberOxyUserIds: string[];
};

class ListsService {
  async list(params?: { mine?: boolean; publicOnly?: boolean }) {
    const res = await authenticatedClient.get('/lists', { params });
    return res.data as MentionListCollection;
  }

  async get(id: string) {
    const res = await authenticatedClient.get(`/lists/${id}`);
    return res.data as MentionList;
  }

  async create(body: ListWriteBody) {
    const res = await authenticatedClient.post('/lists', body);
    const created = res.data as MentionList;
    // A new list affects the list collection; pass its id so a screen already
    // viewing it (rare on create) also refreshes.
    notifyListChanged(created?._id || created?.id || null);
    return created;
  }

  async update(id: string, body: Partial<ListWriteBody>) {
    const res = await authenticatedClient.put(`/lists/${id}`, body);
    notifyListChanged(id);
    return res.data as MentionList;
  }

  async remove(id: string) {
    const res = await authenticatedClient.delete(`/lists/${id}`);
    notifyListChanged(id);
    return res.data as { success?: boolean };
  }

  async addMembers(id: string, userIds: string[]) {
    const res = await authenticatedClient.post(`/lists/${id}/members`, { userIds });
    notifyListChanged(id);
    return res.data as MentionList;
  }

  async removeMembers(id: string, userIds: string[]) {
    const res = await authenticatedClient.delete(`/lists/${id}/members`, { data: { userIds } });
    notifyListChanged(id);
    return res.data as MentionList;
  }

  async getTimeline(id: string, params?: { cursor?: string; limit?: number }) {
    const res = await authenticatedClient.get(`/lists/${id}/timeline`, { params });
    return res.data as MentionListTimeline;
  }
}

export const listsService = new ListsService();
