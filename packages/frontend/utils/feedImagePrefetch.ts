/**
 * Warms the images of the rows a feed is about to show, so a row that scrolls
 * in draws its avatar, media and link cover from the cache instead of leaving
 * the slots blank while they download.
 *
 * The URLs are the row's own (`postFeedImages`, the functions the row draws
 * with), so the prefetch fills the exact cache entries the row will read. Each
 * URL is asked for once per session: expo-image keeps it on disk and in memory,
 * and asking again would only cost a bridge call.
 */
import { Image } from 'expo-image';
import { postFeedImages, type FeedImagePost } from '@/utils/feedImages';

/** URLs already handed to the cache, oldest first; bounded so a long session does not grow it forever. */
const requested = new Set<string>();
const REMEMBERED = 800;

/** Prefetch every image `posts`' rows draw that has not been asked for yet. */
export function prefetchFeedImages(posts: readonly FeedImagePost[]): void {
  const uris: string[] = [];
  for (const post of posts) {
    for (const uri of postFeedImages(post)) {
      if (!uri || requested.has(uri)) continue;
      requested.add(uri);
      uris.push(uri);
    }
  }
  if (uris.length === 0) return;
  for (const uri of requested) {
    if (requested.size <= REMEMBERED) break;
    requested.delete(uri);
  }
  Image.prefetch(uris, 'memory-disk').catch(() => undefined);
}
