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
  type RecommendationBoostInput,
  type RecommendationExcludeType,
} from './OxyRankingClient';
import {
  contentAffinityService,
  type ContentAffinityService,
  type ContentCandidate,
} from './ContentAffinityService';
import { getMentionOxyClientId } from '../utils/oxyHelpers';

/** Default page size when the caller omits `limit`. */
export const DEFAULT_RECOMMENDATION_LIMIT = 20;

/** Hard cap on page size regardless of the caller's `limit`. */
export const MAX_RECOMMENDATION_LIMIT = 50;

/**
 * Hard cap on the pagination offset. Bounds how deep a caller may scan into the
 * ranked list so a hostile/buggy client cannot request an arbitrarily large
 * offset (which Oxy would translate into a deep skip over the candidate union).
 * Generous enough for real "who to follow" infinite scroll (e.g. 50 pages of 20
 * or 20 pages of 50).
 */
export const MAX_RECOMMENDATION_OFFSET = 1000;

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
  /** Pagination offset (clamped to [0, MAX_RECOMMENDATION_OFFSET]). */
  offset?: number;
  /** User types to exclude (parsed from the `excludeTypes` CSV query param). */
  excludeTypes?: RecommendationExcludeType[];
}

/**
 * Response payload — always this shape, even on soft-failure. The pagination
 * fields drive the frontend's infinite scroll: `hasMore` gates the next fetch
 * and `nextCursor`/`nextOffset` address the next page. Both `nextCursor` and
 * `nextOffset` are `null` whenever `hasMore` is `false`.
 */
export interface RecommendationsResult {
  recommendations: RankedProfile[];
  /** Opaque cursor for the next page; pass back as `?cursor=`. Null at the end. */
  nextCursor: string | null;
  /** Numeric offset for the next page; pass back as `?offset=`. Null at the end. */
  nextOffset: number | null;
  /** Whether another page may exist after this one. */
  hasMore: boolean;
}

/** The soft-fail / empty page payload (no results, no next page). */
const EMPTY_RESULT: RecommendationsResult = {
  recommendations: [],
  nextCursor: null,
  nextOffset: null,
  hasMore: false,
};

/**
 * Encode a numeric offset into the opaque cursor the frontend echoes back. The
 * scheme is intentionally simple (base64url of the decimal offset) — it is NOT a
 * security boundary, only a stable, URL-safe token so the API can evolve the
 * cursor format later without the frontend depending on a raw integer.
 */
export function encodeRecommendationCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

/**
 * Decode a cursor produced by {@link encodeRecommendationCursor} back into a
 * non-negative offset. Returns `null` for any malformed/invalid cursor so the
 * caller can fall back to the first page rather than error the discovery surface.
 * `Buffer.from(..., 'base64url')` decodes leniently and never throws, so no
 * try/catch is needed.
 */
export function decodeRecommendationCursor(cursor: string): number | null {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const parsed = Number.parseInt(decoded, 10);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

/** Clamp a requested limit into the supported range. */
function clampLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_RECOMMENDATION_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_RECOMMENDATION_LIMIT);
}

/** Clamp a requested offset into the supported range (`[0, MAX]`). */
function clampOffset(offset?: number): number {
  if (typeof offset !== 'number' || !Number.isFinite(offset) || offset <= 0) {
    return 0;
  }
  return Math.min(Math.floor(offset), MAX_RECOMMENDATION_OFFSET);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Build the per-viewer cache key. Includes the viewer (or `anon`), the limit,
 * the pagination offset, and the SORTED excludeTypes so two requests with the
 * same effective inputs share a cache entry while anon and authed NEVER collide
 * and different pages (offsets) NEVER overwrite each other.
 */
function buildCacheKey(
  viewerId: string | undefined,
  limit: number,
  offset: number,
  excludeTypes: string[],
): string {
  const viewerPart = viewerId ? `u:${viewerId}` : 'anon';
  const typesPart = excludeTypes.length > 0 ? [...excludeTypes].sort().join(',') : 'none';
  return `${CACHE_PREFIX}${viewerPart}:l:${limit}:o:${offset}:t:${typesPart}`;
}

/**
 * Group content-affinity candidates into a bounded set of boost tiers. Each tier
 * shares one Oxy `appBoost` weight, so higher-affinity authors land in a
 * stronger tier. Mention only emits a small, fixed integer weight range
 * (1..{@link MAX_BOOST_TIER_WEIGHT}); Oxy clamps it to the app's profile anyway,
 * but keeping it small here avoids ever asserting an outsized boost.
 */
const MAX_BOOST_TIER_WEIGHT = 3;

/**
 * Map ranked content candidates to the `boosts` wire shape. Splits candidates
 * into {@link MAX_BOOST_TIER_WEIGHT} weight tiers by relative affinity (the top
 * candidates get the highest tier) and emits one boost entry per non-empty tier.
 * Returns `[]` for an empty candidate list.
 */
export function buildBoostsFromCandidates(candidates: ContentCandidate[]): RecommendationBoostInput[] {
  if (candidates.length === 0) return [];

  // Candidates arrive sorted by descending weight. The strongest weight defines
  // the top of the range; tier = ceil(rank within range) so the highest-affinity
  // authors get the strongest boost. Single-weight inputs collapse to one tier.
  const maxWeight = candidates[0]?.weight ?? 0;
  const minWeight = candidates[candidates.length - 1]?.weight ?? 0;
  const span = maxWeight - minWeight;

  const tiers = new Map<number, string[]>();
  for (const candidate of candidates) {
    if (!candidate.userId) continue;
    let tier: number;
    if (span <= 0) {
      tier = MAX_BOOST_TIER_WEIGHT;
    } else {
      const ratio = (candidate.weight - minWeight) / span; // 0..1
      tier = Math.max(1, Math.ceil(ratio * MAX_BOOST_TIER_WEIGHT));
    }
    const bucket = tiers.get(tier);
    if (bucket) bucket.push(candidate.userId);
    else tiers.set(tier, [candidate.userId]);
  }

  const boosts: RecommendationBoostInput[] = [];
  // Emit strongest tiers first for readability/determinism.
  for (const weight of [...tiers.keys()].sort((a, b) => b - a)) {
    const userIds = tiers.get(weight);
    if (userIds && userIds.length > 0) {
      boosts.push({ userIds, weight, reason: 'content-affinity' });
    }
  }
  return boosts;
}

export class RecommendationService {
  constructor(
    private readonly rankingClient: OxyRankingClient = oxyRankingClient,
    private readonly affinityService: ContentAffinityService = contentAffinityService,
  ) {}

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

  /**
   * Read a cached page (the full {@link RecommendationsResult}, including its
   * pagination metadata). Returns null on miss, a shape mismatch, or any cache
   * error (graceful).
   */
  private async readCache(key: string): Promise<RecommendationsResult | null> {
    try {
      const client = getRedisClient();
      if (!client?.isReady) return null;
      const raw = await client.get(key);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && Array.isArray(parsed.recommendations)) {
        return parsed as unknown as RecommendationsResult;
      }
      return null;
    } catch (error) {
      logger.debug('[RecommendationService] cache read failed:', error);
      return null;
    }
  }

  /** Write a page to cache. Best-effort; never throws. */
  private async writeCache(key: string, value: RecommendationsResult): Promise<void> {
    try {
      const client = getRedisClient();
      if (!client?.isReady) return;
      await client.set(key, JSON.stringify(value), { EX: CACHE_TTL_SECONDS });
    } catch (error) {
      logger.debug('[RecommendationService] cache write failed:', error);
    }
  }

  /**
   * Compute viewer-scoped content-affinity `boosts` for the ranking call.
   * SOFT-FAIL: any error in candidate computation logs and yields `[]` so the
   * recommendation still returns (boosts are purely additive). Logged-out callers
   * have no content history, so this is a no-op for them.
   */
  private async resolveBoosts(viewerId: string | undefined): Promise<RecommendationBoostInput[]> {
    if (!viewerId) return [];
    try {
      const candidates = await this.affinityService.getContentCandidates(viewerId);
      return buildBoostsFromCandidates(candidates);
    } catch (error) {
      logger.warn(
        `[RecommendationService] content-affinity boosts failed for ${viewerId}; proceeding with none:`,
        error,
      );
      return [];
    }
  }

  /**
   * Produce a ranked recommendation page for the viewer. Always resolves to a
   * valid {@link RecommendationsResult}; an Oxy/transport error logs and returns
   * an empty list rather than throwing.
   */
  async getRecommendations(input: GetRecommendationsInput): Promise<RecommendationsResult> {
    const limit = clampLimit(input.limit);
    const offset = clampOffset(input.offset);
    const excludeTypes = input.excludeTypes ?? [];
    const viewerId = input.viewerId;

    const cacheKey = buildCacheKey(viewerId, limit, offset, excludeTypes);
    const cached = await this.readCache(cacheKey);
    if (cached) {
      return cached;
    }

    // Exclusions and content-affinity boosts are independent and viewer-scoped;
    // resolve them together. Both are individually soft-failing.
    const [excludeIds, boosts] = await Promise.all([
      viewerId ? this.resolveExcludeIds(viewerId) : Promise.resolve<string[] | undefined>(undefined),
      this.resolveBoosts(viewerId),
    ]);

    try {
      const { profiles, rawCount } = await this.rankingClient.rank({
        clientId: getMentionOxyClientId(),
        viewerId,
        limit,
        offset,
        excludeIds,
        excludeTypes,
        boosts: boosts.length > 0 ? boosts : undefined,
      });

      // Offset pagination: a FULL upstream page (rawCount >= limit) implies a next
      // page may exist. Advance the cursor by the raw count Oxy returned (NOT the
      // mapped `profiles.length`) so any dropped malformed items never shift the
      // window into duplicates/skips. Stop offering a next page once it would
      // exceed the offset cap, so the cursor can never loop on a clamped offset.
      const candidateNextOffset = offset + rawCount;
      const hasMore = rawCount >= limit && candidateNextOffset <= MAX_RECOMMENDATION_OFFSET;
      const nextOffset = hasMore ? candidateNextOffset : null;
      const nextCursor = nextOffset !== null ? encodeRecommendationCursor(nextOffset) : null;

      const result: RecommendationsResult = {
        recommendations: profiles,
        nextCursor,
        nextOffset,
        hasMore,
      };
      await this.writeCache(cacheKey, result);
      return result;
    } catch (error) {
      logger.error('[RecommendationService] ranking failed; returning empty result:', error);
      return { ...EMPTY_RESULT };
    }
  }
}

export const recommendationService = new RecommendationService();
export default recommendationService;
