import type {
  CommunityBan,
  CommunityBansResponse,
  JoinedCommunitiesResponse,
  PostUser,
} from '@mention/shared-types';
import { authenticatedClient } from '@/utils/api';

const BASE = '/communities';

/**
 * A community hosted here, from the app: where its members may post, and what
 * its moderators may do to it. Joining is an Oxy follow (the profile's Join
 * button) and its moderators are Oxy's (`oxyServices.users.moderators`); this is
 * the Mention half. Nothing here catches — a moderation action that fails must
 * say so.
 */
class CommunityService {
  /** The communities hosted here the caller joined — where the composer may post. */
  async joined(): Promise<PostUser[]> {
    const res = await authenticatedClient.get<{ data: JoinedCommunitiesResponse }>(
      `${BASE}/joined`,
    );
    return res.data?.data?.communities ?? [];
  }

  /** Remove a post from the community; it stays its author's. */
  async removePost(communityId: string, postId: string, reason?: string): Promise<void> {
    await authenticatedClient.post(
      `${BASE}/${encodeURIComponent(communityId)}/posts/${encodeURIComponent(postId)}/removal`,
      reason ? { reason } : {},
    );
  }

  /** Ban a person from posting in the community. */
  async ban(communityId: string, userId: string, reason?: string): Promise<void> {
    await authenticatedClient.post(`${BASE}/${encodeURIComponent(communityId)}/bans`, {
      userId,
      ...(reason ? { reason } : {}),
    });
  }

  /** Lift a ban. */
  async unban(communityId: string, userId: string): Promise<void> {
    await authenticatedClient.delete(
      `${BASE}/${encodeURIComponent(communityId)}/bans/${encodeURIComponent(userId)}`,
    );
  }

  /** The community's bans, for its moderators. */
  async bans(communityId: string): Promise<CommunityBan[]> {
    const res = await authenticatedClient.get<{ data: CommunityBansResponse }>(
      `${BASE}/${encodeURIComponent(communityId)}/bans`,
    );
    return res.data?.data?.bans ?? [];
  }
}

export const communityService = new CommunityService();
