import type { FeedResponse, SlicedFeedResponse } from '@mention/shared-types';
import { loadPostRecords } from '../db/posts/postRepository';
import { postHydrationService } from './PostHydrationService';

/** Cache ranking/order, never an authorization grant or a frozen content body. */
export async function revalidateAnonymousFeed<T extends FeedResponse | SlicedFeedResponse>(
  response: T,
  requestLanguages?: string[],
): Promise<T> {
  const ids = [
    ...new Set([
      ...response.items.map((post) => post.id),
      ...('slices' in response
        ? response.slices.flatMap((slice) => slice.items.map((item) => item.post.id))
        : []),
    ]),
  ];
  if (ids.length === 0) return response;
  const records = await loadPostRecords(ids);
  const fresh = await postHydrationService.hydratePosts(records, {
    safetyRequester: { accessToken: null },
    maxDepth: 2,
    requestLanguages,
  });
  const byId = new Map(fresh.map((post) => [post.id, post]));
  const items = response.items.flatMap((post) => {
    const current = byId.get(post.id);
    return current ? [current] : [];
  });
  if (!('slices' in response)) return { ...response, items, totalCount: items.length };
  const slices = response.slices.flatMap((slice) => {
    const visible = slice.items.flatMap((item) => {
      const current = byId.get(item.post.id);
      return current ? [{ ...item, post: current }] : [];
    });
    if (!visible.length) return [];
    const { reason, ...rest } = slice;
    return [
      {
        ...rest,
        items: visible,
        isIncompleteThread: slice.isIncompleteThread || visible.length !== slice.items.length,
        ...(reason?.type === 'boost' && !fresh.some((post) => post.user.id === reason.actor.id)
          ? {}
          : { reason }),
      },
    ];
  });
  return { ...response, slices, items, totalCount: items.length };
}
