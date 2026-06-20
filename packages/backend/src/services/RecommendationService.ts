/**
 * RecommendationService — Mention's `/recommendations` business logic.
 *
 * Responsibilities:
 *  - Resolve the viewer's exclusion set (blocked + muted + restricted + self).
 *  - Serve a per-viewer Redis cache (never shared between anon and authed).
 *  - Rank via {@link OxyRankingClient}, forwarding the viewer for personalization.
 *  - Fail soft: any Oxy/transport error yields an empty, valid response shape
 *    (logged, never thrown) so the discovery surface never errors the client.
 *
 * Hydration: the ranking client already maps each item to Mention's frontend
 * DTO (final avatar URL, canonical `name.displayName`), so this service does not
 * re-resolve users. It only enforces the exclusion set, caching, and soft-fail.
 */

import Block from '../models/Block';
import Mute from '../models/Mute';
import Restrict from '../models/Restrict';
import { getRedisClient } from '../utils/redis';
import { logger } from '../utils/logger';
import { config } from '../config';
import {
  oxyRankingClient,
  type OxyRankingClient,
  type RankedProfile,
  type RecommendationExcludeType,
} from './OxyRankingClient';
import { getMentionOxyClientId } from '../utils/oxyHelpers';

/** Default page size when the caller omits `limit`. */
export const DEFAULT_RECOMMENDATION_LIMIT = 20;

/** Hard cap on page size regardless of the caller's `limit`. */
export const MAX_RECOMMENDATION_LIMIT = 50;

/** Per-viewer cache TTL (seconds). Short so personalization stays fresh. */
const CACHE_TTL_SECONDS = 90;

/** Redis key namespace for cached recommendation pages. */
const CACHE_PREFIX = 'rec:v1:';

/** Inputs accepted by {@link RecommendationService.getRecommendations}. */
export interface GetRecommendationsInput {
  /** Viewer's Oxy user id, or undefined when logged out. */
  viewerId?: string;
  /** Requested page size (clamped to [1, MAX_RECOMMENDATION_LIMIT]). */
  limit?: number;
  /** User types to exclude (parsed from the `excludeTypes` CSV query param). */
  excludeTypes?: RecommendationExcludeType[];
}

/** Response payload — always this shape, even on soft-failure. */
export interface RecommendationsResult {
  recommendations: RankedProfile[];
}

/** Clamp a requested limit into the supported range. */
function clampLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_RECOMMENDATION_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_RECOMMENDATION_LIMIT);
}

/**
 * Build the per-viewer cache key. Includes the viewer (or `anon`), the limit,
 * and the SORTED excludeTypes so two requests with the same effective inputs
 * share a cache entry while anon and authed NEVER collide.
 */
function buildCacheKey(viewerId: string | undefined, limit: number, excludeTypes: string[]): string {
  const viewerPart = viewerId ? `u:${viewerId}` : 'anon';
  const typesPart = excludeTypes.length > 0 ? [...excludeTypes].sort().join(',') : 'none';
  return `${CACHE_PREFIX}${viewerPart}:l:${limit}:t:${typesPart}`;
}

export class RecommendationService {
  constructor(private readonly rankingClient: OxyRankingClient = oxyRankingClient) {}

  /**
   * Resolve the viewer's exclusion set: every user they block, mute, or
   * restrict, plus self. Runs the three queries in parallel, projects only the
   * target id, and dedupes. Returns just `[viewerId]` if the relation lookups
   * fail (self-exclusion is the floor; a DB hiccup must not surface the viewer
   * to themselves but must not throw either).
   */
  async resolveExcludeIds(viewerId: string): Promise<string[]> {
    try {
      const [blocks, mutes, restricts] = await Promise.all([
        Block.find({ userId: viewerId }, { blockedId: 1, _id: 0 }).lean(),
        Mute.find({ userId: viewerId }, { mutedId: 1, _id: 0 }).lean(),
        Restrict.find({ userId: viewerId }, { restrictedId: 1, _id: 0 }).lean(),
      ]);

      const excluded = new Set<string>([viewerId]);
      for (const b of blocks) {
        if (b.blockedId) excluded.add(b.blockedId);
      }
      for (const m of mutes) {
        if (m.mutedId) excluded.add(m.mutedId);
      }
      for (const r of restricts) {
        if (r.restrictedId) excluded.add(r.restrictedId);
      }
      return Array.from(excluded);
    } catch (error) {
      logger.warn(`[RecommendationService] Failed to resolve exclude ids for ${viewerId}:`, error);
      return [viewerId];
    }
  }

  /** Read a cached page. Returns null on miss or any cache error (graceful). */
  private async readCache(key: string): Promise<RankedProfile[] | null> {
    try {
      const client = getRedisClient();
      if (!client?.isReady) return null;
      const raw = await client.get(key);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as RankedProfile[]) : null;
    } catch (error) {
      logger.debug('[RecommendationService] cache read failed:', error);
      return null;
    }
  }

  /** Write a page to cache. Best-effort; never throws. */
  private async writeCache(key: string, value: RankedProfile[]): Promise<void> {
    try {
      const client = getRedisClient();
      if (!client?.isReady) return;
      await client.set(key, JSON.stringify(value), { EX: CACHE_TTL_SECONDS });
    } catch (error) {
      logger.debug('[RecommendationService] cache write failed:', error);
    }
  }

  /**
   * Produce a ranked recommendation page for the viewer. Always resolves to a
   * valid {@link RecommendationsResult}; an Oxy/transport error logs and returns
   * an empty list rather than throwing.
   */
  async getRecommendations(input: GetRecommendationsInput): Promise<RecommendationsResult> {
    const limit = clampLimit(input.limit);
    const excludeTypes = input.excludeTypes ?? [];
    const viewerId = input.viewerId;

    const cacheKey = buildCacheKey(viewerId, limit, excludeTypes);
    const cached = await this.readCache(cacheKey);
    if (cached) {
      return { recommendations: cached };
    }

    const excludeIds = viewerId ? await this.resolveExcludeIds(viewerId) : undefined;

    try {
      const recommendations = await this.rankingClient.rank({
        clientId: getMentionOxyClientId(),
        viewerId,
        limit,
        excludeIds,
        excludeTypes,
      });
      await this.writeCache(cacheKey, recommendations);
      return { recommendations };
    } catch (error) {
      logger.error('[RecommendationService] ranking failed; returning empty result:', error);
      return { recommendations: [] };
    }
  }
}

export const recommendationService = new RecommendationService();
export default recommendationService;
