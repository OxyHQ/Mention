import type {
  FeedResponse,
  HydratedPost,
  HydratedPostSummary,
  SlicedFeedResponse,
} from '@mention/shared-types';
import { loadPostRecords } from '../db/posts/postRepository';
import type { PostRecord } from '../db/posts/postRecord';
import { UNRATED_MATERIAL_ITEM } from './contentAccessBatcher';
import { hydratePostMedia } from './hydratePostMedia';
import { postRevision, type HydrationRevisions } from './hydrationRevisions';
import { postHydrationService } from './PostHydrationService';

/** A cached anonymous page and what it was hydrated from. */
export interface AnonymousFeedSnapshot<T extends FeedResponse | SlicedFeedResponse>
  extends HydrationRevisions {
  page: T;
}

const ANONYMOUS = { accessToken: null } as const;

/**
 * Serve a cached anonymous page to a new reader.
 *
 * The cache holds ranking/order and a rendering, never an authorization grant
 * or a frozen content body. Every read:
 *   1. loads the CURRENT records of every post the page renders (each post, its
 *      quoted/boosted original, and the parents its replies name);
 *   2. asks Oxy for current content decisions on them, uncached and fail-closed
 *      (a failure rejects; nothing cached is returned);
 *   3. serves the cached rendering only when every record is the revision it was
 *      rendered from, every post is still allowed and the unrated-material answer
 *      is unchanged. Otherwise the page is hydrated again from the current
 *      records, which drops what is no longer allowed and renders edits.
 *
 * Step 3's common case skips the whole hydration pipeline, which is what a
 * cache hit used to cost against Postgres.
 */
export async function revalidateAnonymousFeed<T extends FeedResponse | SlicedFeedResponse>(
  snapshot: AnonymousFeedSnapshot<T>,
  requestLanguages?: string[],
): Promise<T> {
  const { page } = snapshot;
  const topLevel = topLevelPosts(page);
  if (topLevel.length === 0) return page;
  const rendered = renderedSummaries(topLevel);
  const graphIds = [
    ...new Set(
      rendered.flatMap((summary) =>
        summary.parentPostId ? [summary.id, summary.parentPostId] : [summary.id],
      ),
    ),
  ];
  const records = await loadPostRecords(graphIds);
  if (await isUnchanged(snapshot, graphIds, records)) {
    await hydratePostMedia(rendered, ANONYMOUS);
    return page;
  }
  const byId = new Map(records.map((record) => [record.id, record]));
  return rehydrate(
    page,
    topLevel.flatMap((post) => byId.get(post.id) ?? []),
    requestLanguages,
  );
}

async function isUnchanged(
  snapshot: HydrationRevisions,
  graphIds: readonly string[],
  records: readonly PostRecord[],
): Promise<boolean> {
  if (snapshot.unratedMaterialAllowed === undefined) return false;
  const current = new Map(records.map((record) => [record.id, record]));
  for (const id of graphIds) {
    const revision = snapshot.revisions[id];
    const record = current.get(id);
    if (!revision || !record || postRevision(record) !== revision) return false;
  }
  const decisions = await postHydrationService.authorizeAnonymousRecords(records);
  if (!graphIds.every((id) => decisions.get(id)?.allowed === true)) return false;
  const unrated = decisions.get(UNRATED_MATERIAL_ITEM.resourceId)?.allowed === true;
  return unrated === snapshot.unratedMaterialAllowed;
}

/** Every top-level post the page renders, once each. */
function topLevelPosts(page: FeedResponse | SlicedFeedResponse): HydratedPost[] {
  const byId = new Map<string, HydratedPost>();
  for (const post of page.items) byId.set(post.id, post);
  if ('slices' in page)
    for (const slice of page.slices)
      for (const item of slice.items) byId.set(item.post.id, item.post);
  return [...byId.values()];
}

/** Every summary object the page renders, nested ones included. */
function renderedSummaries(posts: readonly HydratedPost[]): HydratedPostSummary[] {
  const seen = new Set<HydratedPostSummary>();
  for (const post of posts) {
    for (const summary of [post, post.quotedPost, post.originalPost, post.boost?.originalPost])
      if (summary) seen.add(summary);
  }
  return [...seen];
}

async function rehydrate<T extends FeedResponse | SlicedFeedResponse>(
  response: T,
  records: readonly PostRecord[],
  requestLanguages?: string[],
): Promise<T> {
  const fresh = await postHydrationService.hydratePosts([...records], {
    safetyRequester: ANONYMOUS,
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
