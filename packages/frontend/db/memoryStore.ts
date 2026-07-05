/**
 * In-memory feed store — web fallback when SQLite is unavailable.
 *
 * On web, `mention.earth` does not send COOP/COEP headers, so SharedArrayBuffer
 * is absent and `expo-sqlite` cannot run (`isDbAvailable() === false`). The main
 * home feed already works around this with `utils/feedMemoryMode.ts` +
 * `hooks/useFeedState.ts` (items held in React state). The profile feeds
 * (media / videos / posts tabs) instead read through `postsStore`'s SQLite-backed
 * helpers (`getAllFeedItems`, `getPostById`, …), which return empty results on web.
 *
 * This module provides a parallel, process-local mirror of the three SQLite
 * tables — `posts`, `feed_items`, `feed_meta` — so those same helpers can serve
 * data on web. It is consulted ONLY when `isDbAvailable()` is false; native and
 * COOP/COEP-enabled web keep using SQLite unchanged.
 *
 * The structure mirrors the SQLite tables:
 *   - `posts`:      Map<postId, FeedItem>
 *   - `feed_items`: Map<feedKey, string[]>  (ordered list of post ids)
 *   - `feed_meta`:  Map<feedKey, FeedMetaData>
 *
 * Reactivity is unchanged: `postsStore` still bumps `dataVersion` after every
 * write, which re-runs the `useMemo`-wrapped selector reads.
 */

import type { FeedItem } from './schema';
import type { FeedMetaData } from './feedQueries';

// ── Storage ──────────────────────────────────────────────────────

const posts = new Map<string, FeedItem>();
const feedItems = new Map<string, string[]>();
const feedMeta = new Map<string, FeedMetaData>();

// ── Id helpers ───────────────────────────────────────────────────

function resolveId(post: FeedItem | null | undefined): string {
  if (!post) return '';
  if (post.id) return String(post.id);
  const legacyId = (post as { _id?: { toString(): string } | string })._id;
  if (legacyId) {
    return typeof legacyId === 'object' && typeof legacyId.toString === 'function'
      ? legacyId.toString()
      : String(legacyId);
  }
  return '';
}

// ── Post operations ──────────────────────────────────────────────

export function memUpsertPost(post: FeedItem): void {
  const id = resolveId(post);
  if (!id) return;
  posts.set(id, post);
}

export function memUpsertPosts(items: FeedItem[]): void {
  for (const post of items) {
    memUpsertPost(post);
  }
}

export function memGetPostById(id: string): FeedItem | null {
  if (!id) return null;
  return posts.get(id) ?? null;
}

export function memGetPostsByIds(ids: string[]): Record<string, FeedItem> {
  const result: Record<string, FeedItem> = {};
  for (const id of ids) {
    const post = posts.get(id);
    if (post) result[id] = post;
  }
  return result;
}

/**
 * Read-modify-write for a single post. Returns the updated item or null when
 * the post is absent or the updater declines the change.
 */
export function memUpdatePost(
  id: string,
  updater: (prev: FeedItem) => FeedItem | null | undefined
): FeedItem | null {
  if (!id) return null;
  const current = posts.get(id);
  if (!current) return null;
  const updated = updater(current);
  if (!updated) return null;
  posts.set(id, updated);
  return updated;
}

export function memDeletePost(id: string): void {
  if (!id) return;
  posts.delete(id);
}

// ── Feed-item operations ─────────────────────────────────────────

function applyMeta(feedKey: string, meta: Partial<FeedMetaData>, fallbackTotal: number): void {
  const current = feedMeta.get(feedKey);
  feedMeta.set(feedKey, {
    hasMore: meta.hasMore ?? current?.hasMore ?? false,
    nextCursor: meta.nextCursor !== undefined ? meta.nextCursor : current?.nextCursor,
    totalCount: meta.totalCount ?? current?.totalCount ?? fallbackTotal,
    lastUpdated: meta.lastUpdated ?? Date.now(),
    filters: meta.filters ?? current?.filters,
  });
}

/**
 * Replace an entire feed's items. Writes posts first (mirrors the SQLite FK
 * ordering, though the memory store has no constraint).
 */
export function memSetFeedItems(feedKey: string, items: FeedItem[], meta: FeedMetaData): void {
  if (!feedKey) return;
  memUpsertPosts(items);

  const ids: string[] = [];
  for (const item of items) {
    const id = resolveId(item);
    if (id) ids.push(id);
  }
  feedItems.set(feedKey, ids);
  applyMeta(feedKey, meta, ids.length);
}

/**
 * Append items to an existing feed (pagination). De-dupes against existing ids,
 * mirroring the SQLite PRIMARY KEY `INSERT OR IGNORE` behaviour.
 */
export function memAppendFeedItems(
  feedKey: string,
  items: FeedItem[],
  meta: Partial<FeedMetaData>
): void {
  if (!feedKey || items.length === 0) return;
  memUpsertPosts(items);

  const existing = feedItems.get(feedKey) ?? [];
  const seen = new Set(existing);
  const next = existing.slice();
  for (const item of items) {
    const id = resolveId(item);
    if (id && !seen.has(id)) {
      seen.add(id);
      next.push(id);
    }
  }
  feedItems.set(feedKey, next);
  applyMeta(feedKey, meta, next.length);
}

export function memGetAllFeedItems(feedKey: string): FeedItem[] {
  if (!feedKey) return [];
  const ids = feedItems.get(feedKey);
  if (!ids || ids.length === 0) return [];
  const result: FeedItem[] = [];
  for (const id of ids) {
    const post = posts.get(id);
    if (post) result.push(post);
  }
  return result;
}

export function memGetFeedMeta(feedKey: string): FeedMetaData | null {
  if (!feedKey) return null;
  return feedMeta.get(feedKey) ?? null;
}

export function memHasFeedData(feedKey: string): boolean {
  if (!feedKey) return false;
  const ids = feedItems.get(feedKey);
  return !!ids && ids.length > 0;
}

// ── Mutation operations ──────────────────────────────────────────

export function memRemoveFeedItem(feedKey: string, postId: string): void {
  if (!feedKey || !postId) return;
  const ids = feedItems.get(feedKey);
  if (!ids) return;
  const next = ids.filter((id) => id !== postId);
  feedItems.set(feedKey, next);
}

/**
 * Add a post at the start of a feed (for newly created posts). No-op when the
 * post is already present, mirroring `addFeedItemAtStart`.
 */
export function memAddFeedItemAtStart(feedKey: string, postId: string): void {
  if (!feedKey || !postId) return;
  const ids = feedItems.get(feedKey) ?? [];
  if (ids.includes(postId)) return;
  feedItems.set(feedKey, [postId, ...ids]);

  const meta = feedMeta.get(feedKey);
  if (meta) {
    feedMeta.set(feedKey, { ...meta, totalCount: meta.totalCount + 1 });
  }
}

export function memRemovePostFromAllFeeds(postId: string): void {
  if (!postId) return;
  for (const [feedKey, ids] of feedItems) {
    if (ids.includes(postId)) {
      feedItems.set(feedKey, ids.filter((id) => id !== postId));
    }
  }
}

// ── Clear operations ─────────────────────────────────────────────

export function memClearFeed(feedKey: string): void {
  if (!feedKey) return;
  feedItems.delete(feedKey);
  feedMeta.delete(feedKey);
}

export function memClearAllFeeds(): void {
  feedItems.clear();
  feedMeta.clear();
}

export function memClearAll(): void {
  posts.clear();
  memClearAllFeeds();
}
