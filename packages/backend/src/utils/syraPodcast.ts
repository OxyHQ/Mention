import { createSyraClient } from '@syra.fm/sdk';
import type { PostPodcastContent } from '@mention/shared-types';
import { config } from '../config';
import { logger } from './logger';
import { getRedisClient } from './redis';
import { withRedisFallback, ensureRedisConnected } from './redisHelpers';

/**
 * The single shared Syra catalog client. Every backend path that resolves Syra
 * tracks/podcasts (post + thread + reply creation, profile media) reuses this
 * one instance instead of constructing its own.
 */
export const syraClient = createSyraClient({ baseURL: config.syra.apiUrl });

// ---------------------------------------------------------------------------
// Redis cache (fail-open, short TTL)
//
// Syra episode listings are read-heavy and highly re-requested (the picker
// paginates), yet the underlying catalog is effectively immutable for a given
// id — a short-lived cache removes redundant round-trips to the Syra API
// without risking staleness. Mirrors the fail-open Redis pattern used by
// `services/fediverseSharing.ts`: the shared {@link getRedisClient} singleton,
// {@link withRedisFallback} degrades to a no-op when Redis is unavailable, and
// every failure path treats the cache as a MISS (never throws, never blocks a
// resolve). Cache read/write failures are logged at `warn` — the cache is best
// effort, so a Redis hiccup must never surface as a request error.
// ---------------------------------------------------------------------------

/** ~5 minute TTL by default; the catalog is stable so brief staleness is safe. */
const CACHE_TTL_SECONDS = Number(process.env.SYRA_PODCAST_CACHE_TTL_SECONDS ?? 300);
const EPISODES_KEY_PREFIX = 'syrapodcast:episodes:v1:';

function episodesCacheKey(podcastId: string, offset: number): string {
  return `${EPISODES_KEY_PREFIX}${podcastId}:${offset}`;
}

/**
 * Read a JSON-serialized value from the cache. Any failure — Redis down, a
 * transport error, or an unparseable payload — is treated as a cache MISS
 * (returns `undefined`) and logged at `warn`; it never throws.
 */
async function cacheGetJson<T>(key: string): Promise<T | undefined> {
  const redis = getRedisClient();
  const raw = await withRedisFallback(
    redis,
    async () => {
      const connected = await ensureRedisConnected(redis);
      if (!connected) return undefined;
      return await redis.get(key);
    },
    undefined,
    'syraPodcastCacheGet',
  ).catch((error: unknown) => {
    logger.warn('[SyraPodcast] Cache read failed', {
      key,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return undefined;
  });

  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    logger.warn('[SyraPodcast] Cache parse failed', {
      key,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return undefined;
  }
}

/**
 * Write a JSON-serialized value to the cache with the standard TTL. A write
 * failure never affects the caller: it degrades to a no-op and is logged at
 * `warn`.
 */
async function cacheSetJson(key: string, value: unknown): Promise<void> {
  const redis = getRedisClient();
  await withRedisFallback(
    redis,
    async () => {
      const connected = await ensureRedisConnected(redis);
      if (!connected) return;
      await redis.setEx(key, CACHE_TTL_SECONDS, JSON.stringify(value));
    },
    undefined,
    'syraPodcastCacheSet',
  ).catch((error: unknown) => {
    logger.warn('[SyraPodcast] Cache write failed', {
      key,
      reason: error instanceof Error ? error.message : 'unknown',
    });
  });
}

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
 * ingest. `episodeId` is the opaque handle the client sends back.
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
export interface PodcastEpisodesPage {
  items: PodcastEpisodeListItem[];
  hasMore: boolean;
  offset: number;
  limit: number;
}

export const listPodcastEpisodes = async (
  podcastId: string,
  opts?: { offset?: number },
): Promise<PodcastEpisodesPage> => {
  // Key on the SDK's default-normalized offset (absent ⇒ page 0) so an
  // explicit `offset: 0` and an omitted offset share one cache entry.
  const cacheKey = episodesCacheKey(podcastId, opts?.offset ?? 0);
  const cached = await cacheGetJson<PodcastEpisodesPage>(cacheKey);
  if (cached) return cached;

  const page = await syraClient.getPodcastEpisodes(podcastId, { offset: opts?.offset });

  const items: PodcastEpisodeListItem[] = page.items.map((ep) => ({
    episodeId: ep.id,
    title: ep.title,
    durationSec: ep.duration,
    publishedAt: ep.pubDate,
    artworkUrl: syraClient.episodeImageUrl(ep),
  }));

  const result: PodcastEpisodesPage = {
    items,
    hasMore: page.hasMore,
    offset: page.offset,
    limit: page.limit,
  };
  await cacheSetJson(cacheKey, result);
  return result;
};
