import { authenticatedClient } from '@/utils/api';

class EntityFollowService {
  async follow(entityType: string, entityId: string): Promise<void> {
    await authenticatedClient.post('/entity-follows', { entityType, entityId });
  }

  async unfollow(entityType: string, entityId: string): Promise<void> {
    await authenticatedClient.delete('/entity-follows', { data: { entityType, entityId } });
  }

  async getStatus(entityType: string, entityId: string): Promise<boolean> {
    const res = await authenticatedClient.get<{ isFollowing?: boolean }>('/entity-follows/status', {
      params: { entityType, entityId },
    });
    return res.data?.isFollowing ?? false;
  }

  async getFollowing(type?: string, limit = 20, cursor?: string): Promise<{
    items: Array<{ entityType: string; entityId: string; createdAt: string }>;
    nextCursor?: string;
    hasMore: boolean;
  }> {
    const params: Record<string, string | number> = { limit };
    if (type) params.type = type;
    if (cursor) params.cursor = cursor;
    const res = await authenticatedClient.get<{
      items: Array<{ entityType: string; entityId: string; createdAt: string }>;
      nextCursor?: string;
      hasMore: boolean;
    }>('/entity-follows', { params });
    return res.data;
  }
}

export const entityFollowService = new EntityFollowService();
