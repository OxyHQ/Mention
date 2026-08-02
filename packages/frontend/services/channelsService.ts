import type {
  Channel,
  ChannelMemberSummary,
  CreateChannelRequest,
  UpdateChannelRequest,
} from '@mention/shared-types';
import { authenticatedClient, publicClient } from '@/utils/api';

const CHANNELS_PATH = '/channels';

/** One page of the channel directory, most-followed first. */
export interface ChannelDirectoryPage {
  items: Channel[];
  hasMore: boolean;
  /** Keyset cursor (`<followerCount>_<id>`) for the next page, when there is one. */
  nextCursor?: string;
}

/** The backend's success envelope, as raw axios hands it back. */
interface ApiEnvelope<T> {
  data?: T;
}

/**
 * A reader-agnostic channel read, made WITHOUT a session.
 *
 * `publicClient` is raw axios and returns the backend's `{ data }` envelope
 * verbatim, while `authenticatedClient` is the Oxy linked client and unwraps it.
 * The two are therefore NOT interchangeable, and this is the one place the
 * envelope is peeled by hand.
 */
async function readPublic<T>(
  endpoint: string,
  params?: Record<string, string | number | boolean>,
): Promise<T | undefined> {
  const response = await publicClient.get<ApiEnvelope<T>>(endpoint, { params });
  return response.data?.data;
}

/**
 * Channels — a shared, multi-user DESTINATION people follow without following
 * its authors.
 *
 * Two halves with two audiences, mirroring the backend's two routers:
 *
 *  - the directory and one channel's page are reader-agnostic and answerable
 *    without a session, so a signed-out visitor can read `/channels` and
 *    `/c/<handle>`;
 *  - everything that writes, and everything scoped to the caller, is
 *    authenticated.
 *
 * **The caller says whether it has a session; this service never guesses.** Only
 * the linked client carries one, and only a signed-in read comes back with
 * `viewerState` (the follow relationship and the membership role the page needs).
 * A screen already knows the answer from `useAuth().canUsePrivateApi`, and firing
 * an authenticated read while the cold boot is still resolving buys a 401 with
 * nothing to retry it against.
 *
 * Nothing here catches. A follow that fails must surface — a button that quietly
 * does nothing is worse than one that says it failed.
 */
class ChannelsService {
  /**
   * The directory, most-followed first, keyset-paged.
   *
   * `excludeFollowed` is on by default for a signed-in reader and is not a
   * preference: the directory DTO carries no per-item `viewerState`, so a channel
   * the reader already follows would render with a live "Follow" button. Leaving
   * those out makes every listed row's follow state correct by construction. The
   * reader reaches the channels they DO follow from their own pinned home tabs
   * and from this screen's "Your channels" section.
   */
  async listDirectory(options: {
    authenticated: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<ChannelDirectoryPage> {
    const params: Record<string, string | number | boolean> = {};
    if (options.cursor) params.cursor = options.cursor;
    if (options.limit) params.limit = options.limit;

    if (!options.authenticated) {
      const page = await readPublic<ChannelDirectoryPage>(CHANNELS_PATH, params);
      return page ?? { items: [], hasMore: false };
    }

    params.excludeFollowed = true;
    const res = await authenticatedClient.get<ChannelDirectoryPage>(CHANNELS_PATH, { params });
    return res.data ?? { items: [], hasMore: false };
  }

  /**
   * ONE channel's page header, by its `_id` OR its handle — the backend resolves
   * both spellings, which is what lets `/c/<handle>` work without the client
   * looking the id up first.
   */
  async get(idOrHandle: string, options: { authenticated: boolean }): Promise<Channel | null> {
    const path = `${CHANNELS_PATH}/${encodeURIComponent(idOrHandle)}`;
    if (!options.authenticated) {
      return (await readPublic<Channel>(path)) ?? null;
    }
    const res = await authenticatedClient.get<Channel>(path);
    return res.data ?? null;
  }

  /**
   * Who publishes here. A stranger sees accepted members only; the OWNER also
   * sees the invitations still out and the ones that were declined.
   */
  async listMembers(
    idOrHandle: string,
    options: { authenticated: boolean },
  ): Promise<ChannelMemberSummary[]> {
    const path = `${CHANNELS_PATH}/${encodeURIComponent(idOrHandle)}/members`;
    if (!options.authenticated) {
      return (await readPublic<ChannelMemberSummary[]>(path)) ?? [];
    }
    const res = await authenticatedClient.get<ChannelMemberSummary[]>(path);
    return res.data ?? [];
  }

  /** The channels the caller may publish to — owned or invited-and-accepted. */
  async listMine(): Promise<Channel[]> {
    const res = await authenticatedClient.get<Channel[]>(`${CHANNELS_PATH}/mine`);
    return res.data ?? [];
  }

  /** Membership invitations awaiting the caller's answer. */
  async listInvites(): Promise<Channel[]> {
    const res = await authenticatedClient.get<Channel[]>(`${CHANNELS_PATH}/invites`);
    return res.data ?? [];
  }

  async create(body: CreateChannelRequest): Promise<Channel> {
    const res = await authenticatedClient.post<Channel>(CHANNELS_PATH, body);
    return res.data;
  }

  async update(id: string, body: UpdateChannelRequest): Promise<Channel> {
    const res = await authenticatedClient.put<Channel>(`${CHANNELS_PATH}/${id}`, body);
    return res.data;
  }

  async remove(id: string): Promise<void> {
    await authenticatedClient.delete<{ success: boolean }>(`${CHANNELS_PATH}/${id}`);
  }

  /** The owner invites somebody to publish. The invitee is notified. */
  async invite(id: string, oxyUserId: string): Promise<void> {
    await authenticatedClient.post<{ success: boolean }>(`${CHANNELS_PATH}/${id}/members`, {
      oxyUserId,
    });
  }

  async acceptInvite(id: string): Promise<void> {
    await authenticatedClient.post<{ success: boolean }>(`${CHANNELS_PATH}/${id}/members/accept`);
  }

  async declineInvite(id: string): Promise<void> {
    await authenticatedClient.post<{ success: boolean }>(`${CHANNELS_PATH}/${id}/members/decline`);
  }

  /** The owner removes a publisher, or a publisher removes themselves. */
  async removeMember(id: string, memberOxyUserId: string): Promise<void> {
    await authenticatedClient.delete<{ success: boolean }>(
      `${CHANNELS_PATH}/${id}/members/${memberOxyUserId}`,
    );
  }

  /** Subscribe. Idempotent server-side. */
  async follow(id: string): Promise<void> {
    await authenticatedClient.post<{ success: boolean }>(`${CHANNELS_PATH}/${id}/follow`);
  }

  /** Unsubscribe. Idempotent: a channel that was not followed answers the same. */
  async unfollow(id: string): Promise<void> {
    await authenticatedClient.delete<{ success: boolean }>(`${CHANNELS_PATH}/${id}/follow`);
  }

  /**
   * A follower's own notification switch — mute a channel without unfollowing it.
   * This is the per-follower state `EntityFollow` could not carry, and therefore
   * the reason channel follows are their own model.
   */
  async setNotify(id: string, notify: boolean): Promise<boolean> {
    const res = await authenticatedClient.patch<{ notify?: boolean }>(
      `${CHANNELS_PATH}/${id}/follow`,
      { notify },
    );
    return res.data?.notify ?? notify;
  }
}

export const channelsService = new ChannelsService();
