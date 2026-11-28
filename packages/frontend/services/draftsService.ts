import type { HydratedPost } from '@mention/shared-types';
import { api } from '@/utils/api';

const POSTS_PATH = '/posts';

interface DraftsResponse {
  posts?: HydratedPost[];
}

/**
 * The drafts stored on the viewer's ACCOUNT — posts with `status: 'draft'`.
 *
 * The one place the app talks to the server about drafts, so the hook that
 * caches them (`useServerDrafts`) and anything added later — the composer
 * saving its own drafts here, an offline outbox replaying them — go through the
 * same three calls rather than each spelling a path.
 *
 * NOTHING HERE CATCHES. A refused publish or delete has to reach the caller,
 * which rolls its optimistic removal back and tells the person; swallowing it
 * would leave a draft looking published that is still a draft.
 */
class DraftsService {
  /**
   * Every draft the caller can act on, newest first: their own and those of
   * each channel they operate, hydrated like any other post listing.
   */
  async list(): Promise<HydratedPost[]> {
    const { data } = await api.get<DraftsResponse>(`${POSTS_PATH}/drafts`);
    return Array.isArray(data?.posts) ? data.posts : [];
  }

  /**
   * Publish one draft now. The server runs it through the scheduled pipeline —
   * invites, MTN record, notifications, federation — exactly once.
   */
  async publish(postId: string): Promise<void> {
    await api.post(`${POSTS_PATH}/${encodeURIComponent(postId)}/publish`);
  }

  /** Delete one draft. It is never published. */
  async remove(postId: string): Promise<void> {
    await api.delete(`${POSTS_PATH}/${encodeURIComponent(postId)}`);
  }
}

export const draftsService = new DraftsService();
