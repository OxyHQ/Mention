import { authenticatedClient } from '@/utils/api';

/**
 * The entity kinds a viewer can follow, and the ONLY values `/entity-follows`
 * accepts. Both have a reader: a followed hashtag feeds ranking (affinity +
 * candidate sourcing) and a followed list is a subscription that merges the
 * list's members into the viewer's feed.
 *
 * Custom feeds are NOT here: subscribing to a feed is a `FeedLike`
 * (`POST /feeds/:id/like` — see `customFeedsService`), which is what moves
 * `subscriberCount` and what every feed surface reads back.
 */
export type EntityFollowType = 'hashtag' | 'list';

export interface EntityFollowSummary {
  entityType: EntityFollowType;
  entityId: string;
  createdAt: string;
}

/** What the server sends: the rows live under `follows`. */
interface EntityFollowListBody {
  follows: EntityFollowSummary[];
  nextCursor?: string;
  hasMore: boolean;
}

/** What callers consume. */
export interface EntityFollowListResponse {
  items: EntityFollowSummary[];
  nextCursor?: string;
  hasMore: boolean;
}

class EntityFollowService {
  async follow(entityType: EntityFollowType, entityId: string): Promise<void> {
    await authenticatedClient.post('/entity-follows', { entityType, entityId });
  }

  async unfollow(entityType: EntityFollowType, entityId: string): Promise<void> {
    await authenticatedClient.delete('/entity-follows', { data: { entityType, entityId } });
  }

  async getStatus(entityType: EntityFollowType, entityId: string): Promise<boolean> {
    const res = await authenticatedClient.get<{ isFollowing?: boolean }>('/entity-follows/status', {
      params: { entityType, entityId },
    });
    return res.data?.isFollowing ?? false;
  }

  /**
   * The viewer's follows, newest first. `GET /entity-follows` returns the rows
   * under `follows` — read it under that name and hand callers `items`, which is
   * the shape they consume.
   */
  async getFollowing(
    type?: EntityFollowType,
    limit = 20,
    cursor?: string,
  ): Promise<EntityFollowListResponse> {
    const params: Record<string, string | number> = { limit };
    if (type) params.type = type;
    if (cursor) params.cursor = cursor;
    const res = await authenticatedClient.get<EntityFollowListBody>('/entity-follows', { params });
    return {
      items: res.data?.follows ?? [],
      nextCursor: res.data?.nextCursor,
      hasMore: res.data?.hasMore ?? false,
    };
  }
}

export const entityFollowService = new EntityFollowService();
