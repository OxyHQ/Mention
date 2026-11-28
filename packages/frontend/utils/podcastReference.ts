import type { PostPodcastContent } from '@mention/shared-types/post';

/** Drops every legacy snapshot, including on draft restore and local cache reads. */
export function podcastReference(value: unknown): PostPodcastContent | null {
  if (!value || typeof value !== 'object' || !('syraPodcastId' in value)) return null;
  const id = typeof value.syraPodcastId === 'string' ? value.syraPodcastId.trim() : '';
  return id && id.length <= 256 ? { syraPodcastId: id } : null;
}
