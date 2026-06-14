/**
 * Tunables for the activity-based federated media S3 cache.
 *
 * The cache is NOT a permanent mirror: remote media is copied to Oxy S3 on
 * activity, evicted when idle past {@link MEDIA_CACHE_TTL_MS}, and re-cached on
 * the next access. All values are named constants (no inline magic numbers).
 */

const BYTES_PER_MIB = 1024 * 1024;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MS_PER_DAY = MS_PER_SECOND * SECONDS_PER_MINUTE * MINUTES_PER_HOUR * HOURS_PER_DAY;

/**
 * Idle TTL: a `cached` entry whose `lastAccessedAt` is older than this is
 * evicted from Oxy S3 (the row is kept as `evicted` for re-caching on access).
 */
export const MEDIA_CACHE_TTL_MS = 30 * MS_PER_DAY;

/**
 * Maximum size of a VIDEO we will copy into the cache. Videos over this stay
 * proxy-only (the entry is marked `failed`). Kept generous for fediverse video.
 */
export const MEDIA_CACHE_MAX_VIDEO_BYTES = 200 * BYTES_PER_MIB;

/**
 * Maximum size of an IMAGE (or audio) we will copy into the cache. Smaller than
 * the video cap; over-cap images stay proxy-only.
 */
export const MEDIA_CACHE_MAX_IMAGE_BYTES = 32 * BYTES_PER_MIB;

/**
 * Content-type families this cache is willing to store. Mirrors the proxy's
 * allow-list; anything else is skipped (proxy-only) and never uploaded.
 */
export const MEDIA_CACHE_ALLOWED_TYPE_PREFIXES = ['image/', 'video/', 'audio/'] as const;

/**
 * Content types rejected even though they match an allowed prefix. SVG is an XML
 * document that can embed scripts; we never store/serve it same-origin.
 */
export const MEDIA_CACHE_REJECTED_TYPES: ReadonlySet<string> = new Set(['image/svg+xml']);

/** Prefix used to detect a video content type for poster extraction. */
export const MEDIA_CACHE_VIDEO_TYPE_PREFIX = 'video/';

/**
 * Number of leading bytes of a video to buffer for poster-frame extraction. A
 * keyframe lives near the start of a faststart container; we never need the
 * whole file just for the poster.
 */
export const MEDIA_CACHE_POSTER_PREFIX_BYTES = 24 * BYTES_PER_MIB;

/** Max consecutive failed cache attempts before an entry is marked `failed`. */
export const MEDIA_CACHE_MAX_FAIL_COUNT = 4;

/** Base backoff between failed cache attempts; multiplied by 2^(failCount-1). */
export const MEDIA_CACHE_BACKOFF_BASE_MS = 5 * MS_PER_SECOND * SECONDS_PER_MINUTE;

/** Cap on the computed exponential backoff so it never grows unbounded. */
export const MEDIA_CACHE_BACKOFF_MAX_MS = 6 * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

/** Visibility for cached media in Oxy — public so the CDN can serve it freely. */
export const MEDIA_CACHE_OXY_VISIBILITY = 'public' as const;

/** Oxy asset metadata `app` tag so cached objects are attributable/auditable. */
export const MEDIA_CACHE_OXY_APP = 'mention-federation-media-cache' as const;

// --- Worker / scheduler bounds ----------------------------------------------

/** Max pending entries a single cache-worker run will claim and process. */
export const MEDIA_CACHE_WORKER_BATCH_SIZE = 20;

/** Concurrent downloads+uploads within one worker run (matches fed job style). */
export const MEDIA_CACHE_WORKER_CONCURRENCY = 3;

/** How often the cache worker drains pending entries. */
export const MEDIA_CACHE_WORKER_INTERVAL_MS = 60 * MS_PER_SECOND;

/** Max cached+idle entries evicted from S3 per eviction-job run. */
export const MEDIA_CACHE_EVICTION_BATCH_SIZE = 50;

/** Concurrent Oxy deletes within one eviction run. */
export const MEDIA_CACHE_EVICTION_CONCURRENCY = 3;

/** How often the eviction job sweeps for idle cached entries. */
export const MEDIA_CACHE_EVICTION_INTERVAL_MS = 60 * SECONDS_PER_MINUTE * MS_PER_SECOND;

/**
 * MASTER ENABLE FLAG for the write side of the cache (worker + eviction).
 *
 * The proxy read-path hooks (cache lookup, serve-from-Oxy when already cached,
 * access bump, pending upsert) are always safe and active. The WORKER (which
 * uploads bytes to Oxy) and the EVICTION job (which deletes Oxy objects) require
 * a backend service-client capability that does NOT yet exist upstream: the Oxy
 * `/assets/upload` and `DELETE /assets/:id` routes are gated by `authMiddleware`
 * (session-user tokens only) and reject service tokens, and the SDK's
 * `uploadRawFile`/`deleteFile` do not attach the service token. See the upstream
 * report. Until oxy-api/oxy-core expose a service-token upload+delete path, this
 * stays `false` so no half-working write traffic is generated. Flip to `true`
 * (and wire the real upload/delete calls in oxyMediaStore.ts) once upstream lands.
 */
export const MEDIA_CACHE_WRITE_ENABLED =
  process.env.FEDERATION_MEDIA_CACHE_WRITE_ENABLED === 'true';
