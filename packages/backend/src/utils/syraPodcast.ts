import { createSyraClient, SyraApiError } from '@syra.fm/sdk';
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
// Syra episode listings and single-episode resolves are read-heavy and highly
// re-requested (the picker paginates, and stream-start/auto-advance re-resolve
// the same episode), yet the underlying catalog is effectively immutable for a
// given id — a short-lived cache removes redundant round-trips to the Syra API
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
const EPISODE_KEY_PREFIX = 'syrapodcast:episode:v1:';

function episodesCacheKey(podcastId: string, offset: number): string {
  return `${EPISODES_KEY_PREFIX}${podcastId}:${offset}`;
}

function episodeCacheKey(episodeId: string): string {
  return `${EPISODE_KEY_PREFIX}${episodeId}`;
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
 * The cached form of a resolved episode. Carries `podcastId` (unlike the public
 * {@link ResolvedPodcastEpisode}) so the show cross-check can run against a
 * cache hit without a second Syra round-trip — the cache is keyed on the
 * episode id ALONE, since the resolved episode is identical regardless of which
 * show a caller claims it belongs to.
 */
interface CachedResolvedEpisode {
  podcastId: string;
  audioUrl: string;
  title: string;
  artworkUrl?: string;
  durationSec?: number;
}

/**
 * Tri-state outcome of {@link resolvePodcastEpisode}. Distinguishes a genuine
 * "no such episode" (a definitive answer — 404 at the route) from "Syra is
 * unavailable" (a transient outage/transport error — 503 at the route, so the
 * caller can retry) so a Syra hiccup is never mistaken for a missing episode.
 */
export type ResolvePodcastEpisodeResult =
  | { status: 'ok'; episode: ResolvedPodcastEpisode }
  | { status: 'not_found' }
  | { status: 'unavailable' };

/**
 * Resolve a single Syra episode by id into its playable {@link
 * ResolvedPodcastEpisode}, denormalized from the Syra catalog — the client never
 * supplies the audio URL. This is an O(1) by-id lookup (no page scan), served
 * from the Redis cache on a hit.
 *
 * Returns a discriminated {@link ResolvePodcastEpisodeResult}:
 *  - `not_found` — Syra answered definitively that the episode does not exist
 *    (a 4xx `SyraApiError`) OR the resolved episode's `podcastId` does not match
 *    the supplied `expectedPodcastId` (guards against pairing an episode id with
 *    a mismatched show).
 *  - `unavailable` — the SDK threw for any other reason (Syra 5xx, network,
 *    timeout, malformed payload): a transient failure the caller should retry
 *    rather than report as "not found".
 *  - `ok` — the resolved, playable episode.
 *
 * Never throws. Only successful resolutions are cached (positive cache); a
 * `not_found` / `unavailable` outcome is not cached so the next read re-checks
 * Syra.
 */
export const resolvePodcastEpisode = async (
  episodeId: string,
  expectedPodcastId?: string,
): Promise<ResolvePodcastEpisodeResult> => {
  const cacheKey = episodeCacheKey(episodeId);
  let cached = await cacheGetJson<CachedResolvedEpisode>(cacheKey);

  if (!cached) {
    let episode;
    try {
      episode = await syraClient.getEpisode(episodeId);
    } catch (err) {
      // A definitive client-side answer from Syra (404 "no such episode", or a
      // 4xx for a malformed id) is a genuine not-found. Anything else — a Syra
      // 5xx, a network/transport error, a timeout, or a malformed payload — is
      // an outage the caller should retry, NOT a missing episode.
      if (err instanceof SyraApiError && err.status >= 400 && err.status < 500) {
        logger.info('[SyraPodcast] Episode not found', { episodeId, status: err.status });
        return { status: 'not_found' };
      }
      logger.warn('[SyraPodcast] Episode resolve unavailable (Syra outage/transport error)', {
        episodeId,
        reason: err instanceof Error ? err.message : 'unknown',
      });
      return { status: 'unavailable' };
    }

    cached = {
      podcastId: episode.podcastId,
      audioUrl: episode.enclosureUrl,
      title: episode.title,
      artworkUrl: syraClient.episodeImageUrl(episode),
      durationSec: episode.duration,
    };
    await cacheSetJson(cacheKey, cached);
  }

  if (expectedPodcastId && cached.podcastId !== expectedPodcastId) {
    return { status: 'not_found' };
  }

  return {
    status: 'ok',
    episode: {
      audioUrl: cached.audioUrl,
      title: cached.title,
      artworkUrl: cached.artworkUrl,
      durationSec: cached.durationSec,
    },
  };
};
