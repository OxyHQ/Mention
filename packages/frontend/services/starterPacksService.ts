import { authenticatedClient } from '@/utils/api';

/** Resolved owner summary embedded on a starter pack list/detail item. */
export interface StarterPackCreator {
  id?: string;
  username: string;
  displayName?: string;
  avatar?: string;
}

/**
 * Resolved member summary embedded on a starter pack DETAIL item. Hydrated
 * server-side (identity + fully-resolved avatar URL) because the bulk user
 * lookup requires a service credential the browser does not have.
 */
export interface StarterPackMember {
  id: string;
  username: string;
  displayName?: string;
  avatar?: string;
}

export interface StarterPackSummary {
  id?: string;
  _id?: string;
  name: string;
  description?: string;
  ownerOxyUserId?: string;
  memberOxyUserIds?: string[];
  memberCount?: number;
  /** Pre-resolved member avatar URLs (up to 8) returned by the list endpoint. */
  memberAvatars?: string[];
  /** Hydrated members (identity + avatar URL) returned by the detail endpoint. */
  members?: StarterPackMember[];
  useCount?: number;
  /** Resolved owner summary. */
  creator?: StarterPackCreator;
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

/** Base path for every starter-pack read/write request. */
const STARTER_PACKS_BASE = '/starter-packs';

/** A type alias, not an interface: the HTTP client's `params` takes a `Record`. */
type StarterPackListParams = {
  mine?: boolean;
  search?: string;
  /**
   * Drop the packs the viewer already has — their own packs and the ones they
   * already used. Recommendation surfaces must never suggest a pack whose
   * accounts the viewer has followed. Discovery-only; ignored when `mine` or a
   * `userId` scopes the list, and for anonymous viewers (they used none).
   */
  excludeUsed?: boolean;
};

class StarterPacksService {
  async list(params?: StarterPackListParams) {
    const res = await authenticatedClient.get(STARTER_PACKS_BASE, { params });
    return res.data as StarterPackCollection;
  }

  async get(id: string) {
    const res = await authenticatedClient.get(`${STARTER_PACKS_BASE}/${id}`);
    return res.data as StarterPackSummary;
  }

  async create(body: StarterPackWriteBody) {
    const res = await authenticatedClient.post(STARTER_PACKS_BASE, body);
    return res.data as StarterPackSummary;
  }

  async update(id: string, body: Partial<StarterPackWriteBody>) {
    const res = await authenticatedClient.put(`${STARTER_PACKS_BASE}/${id}`, body);
    return res.data as StarterPackSummary;
  }

  async remove(id: string) {
    const res = await authenticatedClient.delete(`${STARTER_PACKS_BASE}/${id}`);
    return res.data as { success?: boolean };
  }

  async addMembers(id: string, userIds: string[]) {
    const res = await authenticatedClient.post(`${STARTER_PACKS_BASE}/${id}/members`, { userIds });
    return res.data as StarterPackSummary;
  }

  async removeMembers(id: string, userIds: string[]) {
    const res = await authenticatedClient.delete(`${STARTER_PACKS_BASE}/${id}/members`, { data: { userIds } });
    return res.data as StarterPackSummary;
  }

  async use(id: string) {
    const res = await authenticatedClient.post(`${STARTER_PACKS_BASE}/${id}/use`);
    return res.data as { memberOxyUserIds: string[]; useCount: number };
  }
}

export const starterPacksService = new StarterPacksService();
