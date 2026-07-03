import { createSyraClient } from '@syra.fm/sdk';
import type { PostPodcastContent } from '@mention/shared-types';
import { config } from '../config';
import { logger } from './logger';

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

/**
 * One row in the episode picker. Deliberately carries NO audio URL: the picker
 * only needs enough to render + select a row, and the playable `enclosureUrl`
 * stays server-owned so a client can never hand us an arbitrary media URL to
 * ingest (see {@link resolvePodcastEpisode}). `episodeId` is the opaque handle
 * the client sends back at stream-start.
 */
export interface PodcastEpisodeListItem {
  episodeId: string;
  title: string;
  durationSec?: number;
  publishedAt?: string;
  artworkUrl?: string;
}

/**
 * List a Syra podcast show's episodes for the picker, denormalized from the Syra
 * catalog (never the client). Each {@link EpisodeSummary} is mapped to a
 * {@link PodcastEpisodeListItem} — WITHOUT its `enclosureUrl`, which is resolved
 * server-side only at stream-start. Pagination stays offset-based for parity
 * with the profile-media search: the SDK's page-based endpoint is hidden behind
 * its uniform `SearchPage`, so callers advance `offset` by `limit` (never by
 * `items.length`). Propagates SDK errors; callers own the drop-vs-500 policy.
 */
export const listPodcastEpisodes = async (
  podcastId: string,
  opts?: { offset?: number },
): Promise<{ items: PodcastEpisodeListItem[]; hasMore: boolean; offset: number; limit: number }> => {
  const page = await syraClient.getPodcastEpisodes(podcastId, { offset: opts?.offset });

  const items: PodcastEpisodeListItem[] = page.items.map((ep) => ({
    episodeId: ep.id,
    title: ep.title,
    durationSec: ep.duration,
    publishedAt: ep.pubDate,
    artworkUrl: syraClient.episodeImageUrl(ep),
  }));

  return { items, hasMore: page.hasMore, offset: page.offset, limit: page.limit };
};

/**
 * The server-resolved playable form of a podcast episode. `audioUrl` is the
 * Syra `enclosureUrl` (a direct audio file) fed straight into the LiveKit URL
 * ingress; the remaining fields denormalize the "now playing" card metadata.
 */
export interface ResolvedPodcastEpisode {
  audioUrl: string;
  title: string;
  artworkUrl?: string;
  durationSec?: number;
}

/**
 * Resolve a single Syra episode by id into its playable {@link
 * ResolvedPodcastEpisode}, denormalized from the Syra catalog — the client never
 * supplies the audio URL. This is an O(1) by-id lookup (no page scan). When
 * `expectedPodcastId` is provided, the resolved episode's `podcastId` must match
 * it, else `null` is returned (guards against pairing an episode id with a
 * mismatched show). Returns `null` — never throws — when the SDK cannot resolve
 * the episode (e.g. not found); the caller owns the 404 so a missing episode is
 * indistinguishable from a mismatched one at the transport layer.
 */
export const resolvePodcastEpisode = async (
  episodeId: string,
  expectedPodcastId?: string,
): Promise<ResolvedPodcastEpisode | null> => {
  try {
    const episode = await syraClient.getEpisode(episodeId);
    if (expectedPodcastId && episode.podcastId !== expectedPodcastId) {
      return null;
    }
    return {
      audioUrl: episode.enclosureUrl,
      title: episode.title,
      artworkUrl: syraClient.episodeImageUrl(episode),
      durationSec: episode.duration,
    };
  } catch (err) {
    logger.warn('[SyraPodcast] Failed to resolve episode', { episodeId, expectedPodcastId, error: err });
    return null;
  }
};
