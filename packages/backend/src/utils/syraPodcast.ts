import { createSyraClient } from '@syra.fm/sdk';
import type { PostPodcastContent } from '@mention/shared-types';
import { config } from '../config';

/**
 * The single shared Syra catalog client. Every backend path that resolves Syra
 * tracks/podcasts (post + thread + reply creation, profile media) reuses this
 * one instance instead of constructing its own.
 */
export const syraClient = createSyraClient({ baseURL: config.syra.apiUrl });

/**
 * Extract ONLY the untrusted `syraPodcastId` reference from a podcast attachment
 * input. The canonical title/author/artwork and show URL are NEVER taken from
 * the client — they are resolved + denormalized server-side from the Syra
 * catalog (see {@link resolvePodcastContent}) after this returns. Returns `null`
 * when no valid id is present.
 */
export const sanitizePodcast = (input: unknown): { syraPodcastId: string } | null => {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const syraPodcastId = typeof obj.syraPodcastId === 'string' ? obj.syraPodcastId.trim() : '';
  if (!syraPodcastId) return null;
  return { syraPodcastId };
};

/**
 * Resolve a Syra podcast show by id and denormalize it into the canonical
 * {@link PostPodcastContent} shape persisted on a post. The title/author/artwork
 * and show URL come from the Syra catalog — never the client. Throws when the
 * show cannot be resolved; callers own the drop-vs-400 policy.
 */
export const resolvePodcastContent = async (id: string): Promise<PostPodcastContent> => {
  const show = await syraClient.getPodcast(id);
  return {
    syraPodcastId: id,
    title: show.title,
    author: show.author,
    artworkUrl: syraClient.podcastArtworkUrl(show),
    showUrl: syraClient.podcastUrl(id),
  };
};
