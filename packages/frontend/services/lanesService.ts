import type {
  CreateLaneRequest,
  Lane,
  LaneOwnerType,
  LaneSummary,
  MutedLane,
  UpdateLaneRequest,
} from '@mention/shared-types';
import { authenticatedClient, publicApi } from '@/utils/api';

const LANES_PATH = '/lanes';

/**
 * Lanes — a publisher's own named carriageways, and the reader's mutes of them.
 *
 * Two halves with two audiences, mirroring the backend's two routers:
 *
 *  - {@link LanesService.listForOwner} is the reader-agnostic half: the lanes a
 *    visitor needs in order to draw a profile's tabs. It answers the same thing
 *    for everybody, so it goes out on the PUBLIC client — a signed-out visitor
 *    reading a profile must still see its tabs.
 *  - everything else is scoped to the caller and goes out authenticated.
 *
 * Nothing here catches: a lane write that fails must surface, because the whole
 * point of the feature is that the author knows which carriageway a post is on.
 * `muteService` swallows because a failed mute is recoverable by repeating it;
 * a failed lane move leaves the post visibly where it was.
 *
 * Every write that changes which posts a LIST contains routes its cache
 * invalidation through `stores/laneInvalidation` — never from a call site, so
 * the two post-list caches can never be told by one caller and not the other.
 */
class LanesService {
  /**
   * The lanes of one publisher that have a tab (`displayMode: 'tab'`).
   *
   * `mixed` has no tab of its own and `hidden` is off the showcase, so the
   * server returns neither — this is exactly the tab list, not a lane list.
   */
  async listForOwner(ownerId: string, ownerType: LaneOwnerType = 'user'): Promise<Lane[]> {
    // `publicApi` is raw axios and hands back the backend's `{ data }` envelope
    // VERBATIM — unlike `authenticatedClient`, which is the Oxy linked client and
    // peels it. The two are not interchangeable, and forgetting that here returns
    // the envelope where an array is expected: the `.map` in the caller throws
    // inside React Query, the query lands in an error state, and a profile
    // silently shows no lane tabs at all.
    const res = await publicApi.get<{ data?: Lane[] }>(LANES_PATH, { ownerType, ownerId });
    return res.data?.data ?? [];
  }

  /** The caller's own lanes, newest first, each with its current post count. */
  async listMine(): Promise<Lane[]> {
    const res = await authenticatedClient.get<Lane[]>(`${LANES_PATH}/mine`);
    return res.data ?? [];
  }

  /** The lanes the caller has silenced, newest mute first, with their publisher. */
  async listMuted(): Promise<MutedLane[]> {
    const res = await authenticatedClient.get<MutedLane[]>(`${LANES_PATH}/muted`);
    return res.data ?? [];
  }

  async create(body: CreateLaneRequest): Promise<Lane> {
    const res = await authenticatedClient.post<Lane>(LANES_PATH, body);
    return res.data;
  }

  /**
   * Rename a lane, or move it between showcase modes.
   *
   * Changing `displayMode` changes which posts the owner's profile tabs CONTAIN,
   * which is why every caller pairs this with `noteLaneListsChanged`.
   */
  async update(id: string, body: UpdateLaneRequest): Promise<Lane> {
    const res = await authenticatedClient.patch<Lane>(`${LANES_PATH}/${id}`, body);
    return res.data;
  }

  async remove(id: string): Promise<void> {
    await authenticatedClient.delete<{ success: boolean }>(`${LANES_PATH}/${id}`);
  }

  /** Silence one lane of one publisher. Idempotent server-side. */
  async mute(id: string): Promise<void> {
    await authenticatedClient.post<{ success: boolean }>(`${LANES_PATH}/${id}/mute`);
  }

  /** Unsilence. Idempotent: a lane that was not muted answers the same success. */
  async unmute(id: string): Promise<void> {
    await authenticatedClient.delete<{ success: boolean }>(`${LANES_PATH}/${id}/mute`);
  }

  /**
   * Move one of the caller's own posts between their lanes, or (with `null`) out
   * of every lane.
   *
   * `PATCH /posts/:id/lane` answers with the same `{ data, message }` envelope as
   * the rest of the API — `{ data: { postId, lane }, message }` — and the linked
   * client peels it, so what arrives here is `{ postId, lane }` and the `message`
   * never reaches this code at all.
   */
  async setPostLane(postId: string, laneId: string | null): Promise<LaneSummary | null> {
    const res = await authenticatedClient.patch<{
      postId?: string;
      lane?: LaneSummary | null;
    }>(`/posts/${postId}/lane`, { laneId });
    return res.data?.lane ?? null;
  }
}

export const lanesService = new LanesService();
