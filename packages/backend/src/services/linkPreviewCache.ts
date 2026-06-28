import { createHash } from 'node:crypto';
import type { PostLinkPreview } from '@mention/shared-types';
import { getRedisClient } from '../utils/redis';
import { withRedisFallback, ensureRedisConnected } from '../utils/redisHelpers';
import { logger } from '../utils/logger';

/**
 * Redis-backed cache for resolved link previews (Open Graph / Twitter Card
 * metadata) keyed by post URL.
 *
 * WHY THIS EXISTS — feed response path must never block on remote fetches.
 * Resolving a link preview requires fetching the remote HTML page (a network
 * round trip with a multi-second timeout). Doing that synchronously while
 * building a feed response means a single feed render fans out to dozens of
 * remote sites; if any are slow or time out (common for federated/external
 * links such as news sites), the feed response blocks for minutes. This cache
 * decouples preview RESOLUTION (slow, background, fire-and-forget) from preview
 * READS on the response path (fast Redis GET, hard-bounded).
 *
 * Design constraints (mirror {@link ../services/mediaCache/negativeCache}):
 *  - Uses the shared {@link getRedisClient} singleton — never opens a new socket.
 *  - When Redis is unavailable (no `REDIS_URL`, or the server is down) every
 *    operation degrades to a no-op via {@link withRedisFallback}: the feed still
 *    renders, just without a cached preview (and without blocking on a fetch).
 *  - A short NEGATIVE marker is stored for URLs that fail to resolve so a dead
 *    or preview-less URL is not re-fetched on every feed render.
 */

/** Redis key prefix for positive link-preview entries (mirrors the `rl:` convention). */
const LINK_PREVIEW_PREFIX = 'linkpreview:meta:';

/** Redis key prefix for negative markers (URL resolved to no usable preview / failed). */
const LINK_PREVIEW_NEG_PREFIX = 'linkpreview:neg:';

/**
 * TTL for a resolved preview. Link metadata changes rarely; a day balances
 * freshness against re-fetch cost. Tunable via env without a redeploy.
 */
const PREVIEW_TTL_SECONDS = Number(process.env.LINK_PREVIEW_CACHE_TTL_SECONDS ?? 24 * 60 * 60);

/**
 * TTL for a negative marker. Kept short so a transiently-unreachable site, or a
 * page that later gains OG tags, recovers without operator action.
 */
const NEGATIVE_TTL_SECONDS = Number(process.env.LINK_PREVIEW_NEG_TTL_SECONDS ?? 10 * 60);

/**
 * Hard upper bound on the time the feed response path will spend reading the
 * preview cache, across ALL URLs in the feed. A slow Redis must never gate the
 * feed — once this budget is exhausted, remaining lookups are treated as misses
 * (the preview simply won't appear on this render; it warms in the background).
 */
const READ_BUDGET_MS = Number(process.env.LINK_PREVIEW_READ_BUDGET_MS ?? 250);

/**
 * Whether a resolved preview is worth storing as a POSITIVE cache entry.
 *
 * A preview with no image, no description, and a title that is just the raw
 * URL/hostname (the metadata fetcher's hostname fallback, or junk parsed from an
 * anti-bot / consent wall) is not a usable preview: it renders as a bare link
 * yet would stick for the full positive TTL, blocking the URL from ever being
 * re-resolved into a real preview. Such hollow results must be marked NEGATIVE
 * (short TTL → auto-recovers) instead.
 *
 * Usable when it has an image OR a description OR a title that is meaningful text
 * (not effectively a URL or the bare host).
 *
 * Shared by the live warm path ({@link PostHydrationService.warmLinkPreviews})
 * and the backfill script, so it lives here rather than at a single call site.
 */
export function isUsablePreview(p: {
  title?: string;
  description?: string;
  image?: string;
  url?: string;
}): boolean {
  if (p.image && p.image.trim().length > 0) return true;
  if (p.description && p.description.trim().length > 0) return true;

  const title = p.title?.trim();
  if (!title) return false;

  // A title that is itself a URL (or starts like one) is not a usable preview.
  if (/^(https?:\/\/|www\.)/i.test(title)) return false;

  // A title equal to the URL's host is the hostname fallback, not real metadata.
  if (p.url) {
    try {
      const host = new URL(p.url).hostname.toLowerCase();
      const titleLower = title.toLowerCase();
      if (titleLower === host || titleLower === host.replace(/^www\./, '')) {
        return false;
      }
    } catch {
      // Unparseable url — the title is non-URL text, so treat it as usable.
    }
  }

  return true;
}

/**
 * Hash the URL (SHA-256) so the key length is bounded and a long/raw URL is not
 * stored verbatim as a Redis key.
 */
function keyFor(prefix: string, url: string): string {
  const hash = createHash('sha256').update(url).digest('hex');
  return `${prefix}${hash}`;
}

/**
 * Read a single cached preview. Returns:
 *  - a `PostLinkPreview` on a positive cache hit,
 *  - `'negative'` when the URL is known to have no usable preview (do NOT warm),
 *  - `null` on a cache miss (caller should warm in the background).
 *
 * Degrades to `null` (miss) whenever Redis is unavailable.
 */
async function getCachedPreview(url: string): Promise<PostLinkPreview | 'negative' | null> {
  const redis = getRedisClient();
  return withRedisFallback(
    redis,
    async () => {
      const connected = await ensureRedisConnected(redis);
      if (!connected) return null;

      const [hit, neg] = await Promise.all([
        redis.get(keyFor(LINK_PREVIEW_PREFIX, url)),
        redis.exists(keyFor(LINK_PREVIEW_NEG_PREFIX, url)),
      ]);

      if (hit) {
        try {
          return JSON.parse(hit) as PostLinkPreview;
        } catch {
          // Corrupt entry — treat as a miss so it gets re-warmed.
          return null;
        }
      }
      if (neg === 1) return 'negative';
      return null;
    },
    null,
    'linkPreviewCacheGet',
  );
}

/**
 * Batch-read previews for many URLs under a single hard time budget.
 *
 * Returns two sets:
 *  - `previews`: URL → resolved preview for positive hits.
 *  - `toWarm`: URLs that are cache MISSES (not negatives) and should be warmed
 *    in the background by the caller.
 *
 * This is the ONLY function the feed response path awaits, and it is bounded by
 * {@link READ_BUDGET_MS}. It performs no remote network I/O.
 */
export async function readPreviews(
  urls: string[],
): Promise<{ previews: Map<string, PostLinkPreview>; toWarm: string[] }> {
  const previews = new Map<string, PostLinkPreview>();
  const toWarm: string[] = [];

  if (urls.length === 0) {
    return { previews, toWarm };
  }

  const deadline = Date.now() + READ_BUDGET_MS;

  await Promise.all(
    urls.map(async (url) => {
      // Past the budget — treat as a miss to warm so the feed never waits on Redis.
      if (Date.now() >= deadline) {
        toWarm.push(url);
        return;
      }
      const cached = await getCachedPreview(url);
      if (cached === 'negative') {
        return; // Known no-preview: do not show, do not warm.
      }
      if (cached) {
        previews.set(url, cached);
      } else {
        toWarm.push(url);
      }
    }),
  );

  return { previews, toWarm };
}

/**
 * Store a resolved preview with a TTL. A write failure must never affect a
 * response, so any error degrades to a no-op (logged at debug).
 */
export async function storePreview(url: string, preview: PostLinkPreview): Promise<void> {
  const redis = getRedisClient();
  await withRedisFallback(
    redis,
    async () => {
      const connected = await ensureRedisConnected(redis);
      if (!connected) return;
      await redis.setEx(keyFor(LINK_PREVIEW_PREFIX, url), PREVIEW_TTL_SECONDS, JSON.stringify(preview));
    },
    undefined,
    'linkPreviewCacheSet',
  ).catch((error: unknown) => {
    logger.debug('[LinkPreviewCache] Store failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  });
}

/**
 * Record that a URL has no usable preview (no title/description/image) or failed
 * to resolve, so it is not re-fetched on every feed render. Degrades to a no-op
 * when Redis is unavailable.
 */
export async function markNoPreview(url: string): Promise<void> {
  const redis = getRedisClient();
  await withRedisFallback(
    redis,
    async () => {
      const connected = await ensureRedisConnected(redis);
      if (!connected) return;
      await redis.setEx(keyFor(LINK_PREVIEW_NEG_PREFIX, url), NEGATIVE_TTL_SECONDS, '1');
    },
    undefined,
    'linkPreviewCacheNegSet',
  ).catch((error: unknown) => {
    logger.debug('[LinkPreviewCache] Negative marker write failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  });
}
