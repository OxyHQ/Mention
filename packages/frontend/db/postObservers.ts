import type { FeedItem } from './schema';

/**
 * Listeners told about every post the local cache stores, whichever path stored
 * it: a single upsert, a batch, or a feed page (SQLite or the web memory store).
 * This is the one place every fetched post passes through, so a reaction to a
 * post's server state (today: link cards still pending) hangs here rather than
 * on each of the store's many call sites, or on a per-row hook.
 */
type PostsStoredListener = (posts: readonly FeedItem[]) => void;

const listeners = new Set<PostsStoredListener>();

/** Subscribe; returns the unsubscribe. */
export function onPostsStored(listener: PostsStoredListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyPostsStored(posts: readonly FeedItem[]): void {
  if (posts.length === 0 || listeners.size === 0) return;
  for (const listener of listeners) {
    try {
      listener(posts);
    } catch {
      // A listener is an observer: it can never fail the write that told it.
    }
  }
}
