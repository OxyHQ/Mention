import { create } from 'zustand';
import type { WatchPost } from './watchVideo';

/** The author's content warning, or an empty string. */
export function videoContentWarning(post: Pick<WatchPost, 'metadata'> | null | undefined): string {
  const warning = post?.metadata.spoilerText;
  return typeof warning === 'string' ? warning.trim() : '';
}

/** Whether a card or preview must not show this video's poster or caption. */
export function isVideoWarned(post: Pick<WatchPost, 'metadata'>): boolean {
  return Boolean(post.metadata.isSensitive) || videoContentWarning(post).length > 0;
}

/**
 * The videos the reader chose to open on the watch page. Shared, because the
 * player and the details rail are drawn in different parts of the shell.
 */
export const useRevealedVideos = create<{ ids: ReadonlySet<string> }>(() => ({ ids: new Set() }));

export function revealVideo(postId: string) {
  useRevealedVideos.setState(({ ids }) => ({ ids: new Set(ids).add(postId) }));
}

export function concealVideo(postId: string) {
  useRevealedVideos.setState(({ ids }) => {
    const next = new Set(ids);
    next.delete(postId);
    return { ids: next };
  });
}
