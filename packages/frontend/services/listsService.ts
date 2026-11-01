import { authenticatedClient } from '@/utils/api';
import { notifyListChanged } from '@/services/listMutations';
import { normalizeApiError } from '@/utils/apiError';
import { createLogger } from '@oxy.so/core/logger';

const logger = createLogger('ListsService');

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
  subscriberCount?: number;
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
  /**
   * `userId` asks for ONE account's lists — the same spelling `feedsService` and
   * `starterPacksService` use for the sibling profile tabs.
   *
   * It is named in the type because the profile tab passed it for a long time
   * while neither this type nor the route knew it: the call site builds its
   * params in a VARIABLE, and TypeScript's excess-property check only applies to
   * object literals passed directly, so nothing objected and the tab silently
   * answered a different question.
   */
  async list(params?: { mine?: boolean; publicOnly?: boolean; userId?: string }) {
    const res = await authenticatedClient.get('/lists', { params });
    return res.data as MentionListCollection;
  }

  async get(id: string) {
    const res = await authenticatedClient.get(`/lists/${id}`);
    return res.data as MentionList;
  }

  /** Resolve followed IDs in order, retaining per-list fallback during rollout. */
  async resolve(ids: string[]): Promise<MentionList[]> {
    if (ids.length === 0) return [];
    try {
      const res = await authenticatedClient.post<{ items: MentionList[] }>('/lists/resolve', {
        ids,
      });
      if (!Array.isArray(res.data?.items)) throw new Error('Invalid list resolution response');
      return res.data.items;
    } catch (error) {
      const { status } = normalizeApiError(error);
      // The original individual reads omitted every item on a rejected
      // session. Preserve that result without repeating the same 401 per ID.
      if (status === 401) return [];
      // A 403 could belong only to this new endpoint. The individual routes
      // still decide their own access, as they did before the batch existed.
      logger.warn('List batch resolution failed; using individual reads', { status });
      const resolved = await Promise.all(ids.map((id) => this.get(id).catch(() => null)));
      return resolved.filter((list): list is MentionList => list !== null);
    }
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
