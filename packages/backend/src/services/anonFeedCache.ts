import { createHash } from 'crypto';
import type { FeedResponse, SlicedFeedResponse } from '@mention/shared-types';
import { getRedisClient } from '../utils/redis';
import { logger } from '../utils/logger';

/**
 * Redis cache for the ANONYMOUS main-feed page.
 *
 * The anonymous feed is identical for every logged-out viewer (no personalized
 * blocked/muted filtering, no per-user seen-set), yet the controller recomputes
 * a full-collection engagement sort AND re-hydrates every post on every request.
 * Caching the fully-built response for a short window turns the common default
 * anon feed into a single shared cache read while staying fresh enough that new
 * posts surface within the TTL.
 *
 * Everything here is FAIL-SOFT (mirrors {@link TrendingService.getTrending}): a
 * missing/unready Redis, or any read/write error, degrades to a live recompute —
 * it never throws into the request path. Only anonymous requests are ever cached;
 * authenticated feeds are personalized and must never be shared.
 */

/** The two response shapes the main feed produces; both are plain JSON. */
type CacheableFeedResponse = FeedResponse | SlicedFeedResponse;

interface AnonFeedCacheKeyInput {
  /**
   * Optional keyspace isolator. Two callers cache different response SHAPES for
   * overlapping `type` names (the legacy feed controller emits a flat
   * {@link FeedResponse}; the MTN controller emits a {@link SlicedFeedResponse}),
   * so each passes a distinct namespace to guarantee they never read each other's
   * entries. Omitted ⇒ the legacy (unnamespaced) keyspace.
   */
  namespace?: string;
  /** Feed type descriptor (e.g. `mixed`, `posts`, `media`, or an MTN descriptor). */
  type: string;
  /** Optional sort mode (`recent` | `best` | `oldest`). */
  sort?: string;
  /** Page size. */
  limit: number;
  /** Pagination cursor for the page. */
  cursor?: string;
  /** Fully-resolved feed filters (authors, keywords, language, …). */
  filters?: Record<string, unknown>;
}

/**
 * Deterministic JSON serialization: object keys are sorted at every level so two
 * structurally-equal filter objects always produce the same string (and thus the
 * same cache key) regardless of insertion order.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const record = val as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = record[key];
          return acc;
        }, {});
    }
    return val;
  });
}

class AnonFeedCache {
  // Short TTL: the anon feed is shared, so this collapses a burst of anonymous
  // requests into one recompute, while new posts still appear within ~1 minute.
  private readonly TTL_SECONDS = 45;
  private readonly KEY_PREFIX = 'anonfeed:v1:';

  /**
   * Build a collision-free cache key. Distinct filters/sort/cursor/limit map to
   * distinct keys, so two different anon requests never share an entry. The
   * (potentially large) filter object is fingerprinted with a short SHA-256 so
   * the key stays bounded.
   */
  buildKey(input: AnonFeedCacheKeyInput): string {
    const hasFilters = input.filters && Object.keys(input.filters).length > 0;
    const filtersFingerprint = hasFilters
      ? createHash('sha256').update(stableStringify(input.filters)).digest('hex').slice(0, 16)
      : 'none';
    const namespacedType = input.namespace ? `${input.namespace}:${input.type}` : input.type;
    return [
      this.KEY_PREFIX + namespacedType,
      input.sort ?? 'default',
      String(input.limit),
      input.cursor ?? 'first',
      filtersFingerprint,
    ].join(':');
  }

  /** Read a cached anon page, or `null` on miss / any Redis failure. */
  async read(key: string): Promise<CacheableFeedResponse | null> {
    const redis = getRedisClient();
    if (!redis) return null;
    try {
      const cached = await redis.get(key);
      if (!cached) return null;
      return JSON.parse(cached) as CacheableFeedResponse;
    } catch (error) {
      logger.warn('[AnonFeedCache] Redis read failed:', error);
      return null;
    }
  }

  /** Persist an anon page. Fail-soft: a write error is logged and swallowed. */
  async write(key: string, response: CacheableFeedResponse): Promise<void> {
    const redis = getRedisClient();
    if (!redis) return;
    try {
      await redis.setEx(key, this.TTL_SECONDS, JSON.stringify(response));
    } catch (error) {
      logger.warn('[AnonFeedCache] Redis write failed:', error);
    }
  }
}

export const anonFeedCache = new AnonFeedCache();
