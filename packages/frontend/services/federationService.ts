import { authenticatedClient } from '@/utils/api';
import type { FederatedActorProfile, FederationFollowResponse, FederationUnfollowResponse } from '@mention/shared-types';

class FederationService {
  /**
   * Search/resolve a fediverse handle (e.g., "@user@mastodon.social").
   */
  async searchActors(query: string): Promise<FederatedActorProfile[]> {
    try {
      const res = await authenticatedClient.get('/federation/search', {
        params: { q: query },
      });
      return res.data?.actors || [];
    } catch (err) {
      console.warn('Federation search failed:', err);
      return [];
    }
  }

  /**
   * Resolve a single fediverse handle to an actor profile.
   */
  async lookupActor(handle: string): Promise<FederatedActorProfile | null> {
    try {
      const res = await authenticatedClient.get('/federation/lookup', {
        params: { handle },
      });
      return res.data?.actor || null;
    } catch {
      return null;
    }
  }

  /**
   * Follow a remote fediverse actor.
   */
  async follow(actorUri: string): Promise<FederationFollowResponse> {
    const res = await authenticatedClient.post('/federation/follow', { actorUri });
    return res.data;
  }

  /**
   * Unfollow a remote fediverse actor.
   */
  async unfollow(actorUri: string): Promise<FederationUnfollowResponse> {
    const res = await authenticatedClient.post('/federation/unfollow', { actorUri });
    return res.data;
  }

  /**
   * Get the current user's federated following list.
   */
  async getFollowing(): Promise<FederatedActorProfile[]> {
    try {
      const res = await authenticatedClient.get('/federation/following');
      return res.data?.following || [];
    } catch {
      return [];
    }
  }

  /**
   * Get the current user's federated followers list.
   */
  async getFollowers(): Promise<FederatedActorProfile[]> {
    try {
      const res = await authenticatedClient.get('/federation/followers');
      return res.data?.followers || [];
    } catch {
      return [];
    }
  }

  /**
   * Get a federated actor's profile by URI.
   */
  async getActorProfile(actorUri: string): Promise<FederatedActorProfile | null> {
    try {
      const res = await authenticatedClient.get('/federation/actor', {
        params: { uri: actorUri },
      });
      return res.data?.actor || null;
    } catch {
      return null;
    }
  }

  /**
   * Get posts from a federated actor.
   */
  async getActorPosts(actorUri: string, cursor?: string): Promise<{
    posts: any[];
    hasMore: boolean;
    nextCursor?: string;
  }> {
    try {
      const params: Record<string, string> = { uri: actorUri };
      if (cursor) params.cursor = cursor;
      const res = await authenticatedClient.get('/federation/actor/posts', { params });
      return res.data || { posts: [], hasMore: false };
    } catch {
      return { posts: [], hasMore: false };
    }
  }

  /**
   * Check if a string looks like a fediverse handle.
   */
  isFediverseHandle(query: string): boolean {
    return /^@?[\w.-]+@[\w.-]+\.\w+$/.test(query.trim());
  }
}

export const federationService = new FederationService();
export default federationService;
