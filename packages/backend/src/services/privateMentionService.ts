import type {
  PrivateMentionConversation,
  PrivateMentionConversationsResponse,
} from '@mention/shared-types';
import { listPrivateMentionConversations } from '../db/posts/postAudience';
import { loadPostRecords } from '../db/posts/postRepository';
import type { ChronoCursorData } from '../utils/chronoCursor';
import { encodeChronoCursor } from '../utils/chronoCursor';
import { type HydrationOptions, postHydrationService } from './PostHydrationService';

/**
 * A page of the viewer's private-mention conversations — the direct posts they
 * wrote or were sent, grouped by thread root — newest activity first.
 *
 * Each item is a thread root plus its newest post, hydrated through the ordinary
 * post ACL, so a conversation whose latest post this viewer may no longer read
 * (an author who blocked them since) is left out rather than shown blank.
 * `cursor` is the decoded previous `nextCursor`: `(lastActivityAt, rootId)`.
 */
export async function listPrivateMentionConversationsPage(
  viewerId: string,
  page: { limit: number; cursor?: ChronoCursorData },
  hydration: Omit<HydrationOptions, 'viewerId' | 'maxDepth'>,
): Promise<PrivateMentionConversationsResponse> {
  const rows = await listPrivateMentionConversations(viewerId, {
    limit: page.limit + 1,
    ...(page.cursor
      ? { before: { lastActivityAt: page.cursor.createdAt, rootId: page.cursor.id } }
      : {}),
  });
  const hasMore = rows.length > page.limit;
  const shown = hasMore ? rows.slice(0, page.limit) : rows;

  const records = await loadPostRecords(shown.map((row) => row.latestPostId));
  const hydrated = await postHydrationService.hydratePosts(records, {
    ...hydration,
    viewerId,
    maxDepth: 1,
  });
  const postById = new Map(hydrated.map((post) => [post.id, post]));
  const recordById = new Map(records.map((record) => [record.id, record]));

  const items: PrivateMentionConversation[] = shown.flatMap((row) => {
    const latestPost = postById.get(row.latestPostId);
    const record = recordById.get(row.latestPostId);
    if (!latestPost || !record) return [];
    const participantIds = [...new Set([record.oxyUserId ?? '', ...record.recipients])].filter(
      (id) => id && id !== viewerId,
    );
    return [
      {
        rootId: row.rootId,
        lastActivityAt: row.lastActivityAt.toISOString(),
        postCount: row.postCount,
        participantIds,
        latestPost,
      },
    ];
  });

  const anchor = hasMore ? shown[shown.length - 1] : undefined;
  return {
    items,
    hasMore,
    ...(anchor ? { nextCursor: encodeChronoCursor(anchor.lastActivityAt, anchor.rootId) } : {}),
  };
}
