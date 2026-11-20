import { type Entity, entity, useEntity } from '@oxy.so/bloom-data';
import type { HydratedPost, HydratedPostSummary } from '@mention/shared-types';
import type { FeedItem } from '@/db/schema';
import { toFeedItem } from '@/db/feedItem';
import { SCHEMA_VERSION } from '@/db/migrations';
import { notifyPostsStored } from '@/db/postObservers';

/**
 * Posts, by id, held once (`@oxy.so/bloom-data`).
 *
 * The one copy every surface reads: a feed row, the detail screen, a quote
 * card, a boosted original. A quoted or boosted post is its own record
 * (`refs`), so a like on the original reaches every boost that embeds it.
 * Records are written in the background to this account's SQLite file and
 * read back when a screen opens, never while a row renders.
 */

export const isValidPostId = (id: unknown): id is string =>
  typeof id === 'string' && id !== '' && id !== 'undefined' && id !== 'null';

/**
 * Whether a post can be drawn on its own. A `type:'boost'` post has an empty
 * body and is drawn only through its embedded `boost.originalPost`.
 */
export const isRenderableBoost = (item: FeedItem): boolean =>
  !item.boost || Boolean(item.boost.originalPost?.id);

export const Post: Entity<FeedItem> = entity<FeedItem>('post', {
  id: (post) => (isValidPostId(String(post.id)) ? String(post.id) : undefined),
  refs: {
    originalPost: () => Post,
    quotedPost: () => Post,
    'boost.originalPost': () => Post,
  },
  // A broadcast (`feed:updated`) is hydrated for no viewer: it never demotes
  // the viewer's own state or permissions on a post they hold (#1140).
  viewerFields: ['viewerState', 'permissions'],
  // An under-hydrated boost (its original lost) never replaces a hydrated one.
  accept: (incoming, held) => isRenderableBoost(incoming) || !isRenderableBoost(held),
  // Every stored post carries the server's view count, and its pending link
  // cards are asked for again (`stores/pendingDocuments`).
  onStore: (posts) => {
    PostViews.put(
      posts.map((post) => ({ id: String(post.id), views: post.engagement?.views ?? null })),
    );
    notifyPostsStored(posts);
  },
  // Moving the persisted shape moves this number (`db/__tests__/cacheShapeVersion`).
  persist: { version: SCHEMA_VERSION },
});

/**
 * How many people have watched a post: the one number that moves while the
 * reader is reading (the impression report answers it for every post scrolled
 * past). It is its own record so that answer re-renders only what draws it, a
 * grid cell, never a feed row: the row reads `engagement.views` from the post,
 * as it was read.
 */
export interface PostViewCount {
  id: string;
  views: number | null;
}

export const PostViews = entity<PostViewCount>('post-views', { id: (count) => count.id });

/**
 * Store posts the server returned, in the shape every surface reads. Returns
 * them converted. `anonymous` marks a payload hydrated for no viewer.
 */
export function storePosts(
  posts: readonly (HydratedPost | HydratedPostSummary | FeedItem)[],
  options: { anonymous?: boolean } = {},
): FeedItem[] {
  const items = posts
    .map((post) => toFeedItem(post as HydratedPost))
    .filter((item) => isValidPostId(String(item.id)));
  if (items.length > 0) Post.put(items, options);
  return items;
}

/** One post as the shared copy holds it now, or `null`. Not for render: use `usePost`. */
export function getPost(postId: string | undefined | null): FeedItem | null {
  return postId ? (Post.get(postId) ?? null) : null;
}

/**
 * One post, read with field-level subscriptions: the component re-renders
 * only when a field it read changed.
 */
export function usePost(postId: string | undefined | null): FeedItem | null {
  return useEntity(Post, postId ?? undefined) ?? null;
}

/**
 * A post's view count and nothing else about it. `undefined`: no copy of the
 * post is held; `null`: the copy has no count (hidden, or never returned).
 */
export function useViewCount(postId: string | undefined | null): number | null | undefined {
  return useEntity(PostViews, postId ?? undefined, (count) => count?.views);
}
