/**
 * ContentAffinityService — Phase-2 (increment 1) of the recommendation engine.
 *
 * Computes viewer-scoped "content affinity" candidate authors: Oxy user ids the
 * viewer would likely want to FOLLOW because they already enjoy that author's
 * CONTENT. These ids are contributed to the Oxy ranking call as `boosts` (Oxy
 * injects them into its candidate pool, subject to eligibility, and weights them
 * via the `appBoost` signal). Mention only COMPUTES good candidates; Oxy ranks.
 *
 * Two Mention-only content signals, summed per author:
 *
 *  1. HASHTAG AFFINITY (weaker) — for each hashtag the viewer follows
 *     (`EntityFollow` entityType `'hashtag'`), the recent, active, PUBLIC authors
 *     posting under it. An author scores higher the more of the viewer's followed
 *     hashtags they cover (distinct-tag coverage), with a per-author post-volume
 *     bonus that saturates so a single prolific author cannot dominate.
 *
 *  2. ENGAGEMENT AFFINITY (stronger) — authors of posts the viewer LIKED, REPLIED
 *     TO, or BOOSTED. A direct, intentional signal, so it is weighted well above
 *     hashtag co-occurrence.
 *
 * Aggregation is bounded and viewer-scoped (every query is index-served and
 * limited), so this is cheap enough to run per recommendation request. Results
 * are additionally cached per-viewer in Redis with a short TTL.
 *
 * SOFT-FAIL CONTRACT: this service is additive. The caller
 * ({@link RecommendationService}) wraps it in try/catch and proceeds with no
 * boosts on any error. The service itself also degrades each individual signal
 * to empty on error so a single failing query never sinks the whole computation.
 */

import type { QueryFilter } from 'mongoose';
import { PostType, MtnConfig, isVideoSurface } from '@mention/shared-types';
import Like from '../models/Like';
import { Post, type IPost } from '../models/Post';
import { EntityFollow } from '../models/EntityFollow';
import Block from '../models/Block';
import Mute from '../models/Mute';
import Restrict from '../models/Restrict';
import { getRedisClient } from '../utils/redis';
import { logger } from '../utils/logger';

/** Recency window for content signals (days). */
const WINDOW_DAYS = 30;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Default cap on returned candidate authors. */
export const DEFAULT_CONTENT_CANDIDATE_LIMIT = 30;

/** Hard cap regardless of caller-requested limit. */
const MAX_CONTENT_CANDIDATE_LIMIT = 50;

/**
 * Bounded scan sizes. Every query that fans out over the viewer's history is
 * capped so the per-request cost stays predictable no matter how active the
 * viewer is or how many people post under a followed hashtag.
 */
// Widened modestly so a very active viewer's history is less likely to be
// truncated before it can produce candidates, while staying bounded for a
// predictable per-request cost (every query below is index-served).
const MAX_FOLLOWED_HASHTAGS = 40; // was 25
const MAX_AUTHORS_PER_HASHTAG = 200;
const MAX_LIKES_SCANNED = 500; // was 300
const MAX_VIEWER_INTERACTIONS_SCANNED = 500; // was 300

/** Per-viewer Redis cache TTL (seconds). Short so affinity stays fresh. */
const CACHE_TTL_SECONDS = 120;

/** Redis key namespace for cached content-affinity candidates. */
const CACHE_PREFIX = 'rec:affinity:v1:';

/**
 * Base weights per signal. Engagement is a direct, intentional signal and is
 * therefore weighted well above hashtag co-occurrence.
 */
const HASHTAG_TAG_WEIGHT = 1; // per distinct followed hashtag an author covers
const HASHTAG_VOLUME_BONUS_MAX = 1; // saturating bonus for posting volume under tags
const ENGAGEMENT_LIKE_WEIGHT = 3;
const ENGAGEMENT_REPLY_WEIGHT = 4;
const ENGAGEMENT_BOOST_WEIGHT = 5;

/** A single content-affinity candidate author. */
export interface ContentCandidate {
  /** Candidate author's Oxy user id. */
  userId: string;
  /** Aggregated, normalized affinity weight (>0). */
  weight: number;
  /** Human-readable signal reasons (e.g. `'hashtag'`, `'engagement'`). */
  reasons: string[];
}

/** Options for {@link ContentAffinityService.getContentCandidates}. */
export interface GetContentCandidatesOptions {
  /** Max candidates to return (clamped to [1, MAX_CONTENT_CANDIDATE_LIMIT]). */
  limit?: number;
}

/** Mutable per-author accumulator used while aggregating signals. */
interface AuthorAccumulator {
  weight: number;
  reasons: Set<string>;
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_CONTENT_CANDIDATE_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_CONTENT_CANDIDATE_LIMIT);
}

export class ContentAffinityService {
  /**
   * Compute content-affinity candidate authors for a viewer. Always resolves;
   * any internal error degrades the offending signal to empty (and, in the worst
   * case, the whole result to `[]`). Returns `[]` when the viewer has no followed
   * hashtags and no engagement.
   */
  async getContentCandidates(
    viewerId: string,
    opts: GetContentCandidatesOptions = {},
  ): Promise<ContentCandidate[]> {
    if (!viewerId) return [];
    const limit = clampLimit(opts.limit);

    const cacheKey = `${CACHE_PREFIX}${viewerId}:l:${limit}`;
    const cached = await this.readCache(cacheKey);
    if (cached) return cached;

    const since = new Date(Date.now() - WINDOW_MS);

    // Run the (independent) exclusion lookup and the two affinity signals in
    // parallel. Each signal already self-degrades to empty on error.
    const [excluded, hashtagScores, engagementScores] = await Promise.all([
      this.resolveExcludeIds(viewerId),
      // Aggregation `$match` compares against the BSON Date path directly.
      this.computeHashtagAffinity(viewerId, since),
      // `find()` filters are typed against `IPost` (createdAt declared as string);
      // pass the ISO boundary so Mongoose casts it to a Date for the query.
      this.computeEngagementAffinity(viewerId, since.toISOString()),
    ]);

    // Merge the per-author accumulators from both signals.
    const merged = new Map<string, AuthorAccumulator>();
    for (const source of [hashtagScores, engagementScores]) {
      for (const [authorId, acc] of source) {
        if (!authorId || excluded.has(authorId)) continue;
        const existing = merged.get(authorId);
        if (existing) {
          existing.weight += acc.weight;
          for (const r of acc.reasons) existing.reasons.add(r);
        } else {
          merged.set(authorId, { weight: acc.weight, reasons: new Set(acc.reasons) });
        }
      }
    }

    if (merged.size === 0) {
      await this.writeCache(cacheKey, []);
      return [];
    }

    // Blend in a MODEST author-authority lift (follower count + reach), with a
    // popularity floor: content affinity stays the dominant signal, established
    // candidates get a small bounded boost, and small creators stay ~neutral.
    await this.applyAuthorityBlend(merged);

    const candidates: ContentCandidate[] = Array.from(merged.entries())
      .map(([userId, acc]) => ({
        userId,
        weight: acc.weight,
        reasons: Array.from(acc.reasons).sort(),
      }))
      // Highest affinity first; tie-break on id for deterministic output.
      .sort((a, b) => (b.weight - a.weight) || (a.userId < b.userId ? -1 : 1))
      .slice(0, limit);

    await this.writeCache(cacheKey, candidates);
    return candidates;
  }

  /**
   * Multiply each merged candidate's affinity weight by a MODEST author-authority
   * factor derived from the candidate's follower count (a proxy for reach). The
   * factor is the shared, bounded `calculateAuthorityScore` (floor ~0.9, ceiling
   * ~1.4), so:
   *   - content affinity remains the dominant ranking signal,
   *   - established/high-reach candidates get a small lift, and
   *   - small creators and authors whose follower count is unknown stay ~neutral
   *     (popularity FLOOR philosophy — never zeroed, never dominating).
   *
   * Follower counts come from the shared, cache-backed user-summary resolver, so
   * this is one batched Redis read + at most one bulk Oxy fetch for cold authors.
   * SOFT-FAIL: any error leaves the weights as the pure content-affinity values.
   */
  private async applyAuthorityBlend(merged: Map<string, AuthorAccumulator>): Promise<void> {
    const authorIds = Array.from(merged.keys());
    if (authorIds.length === 0) return;

    try {
      // Lazy imports to avoid any module-load ordering coupling.
      const [{ resolveUserSummaries }, { feedRankingService }] = await Promise.all([
        import('./PostHydrationService.js'),
        import('./FeedRankingService.js'),
      ]);

      const resolved = await resolveUserSummaries(authorIds);
      for (const [authorId, acc] of merged) {
        const followerCount = resolved.get(authorId)?.followerCount;
        const authority = feedRankingService.calculateAuthorityScore(followerCount);
        acc.weight *= authority;
      }
    } catch (error) {
      logger.warn('[ContentAffinity] authority blend failed; using pure content affinity:', error);
    }
  }

  /**
   * Resolve the viewer's exclusion set (self + blocked + muted + restricted) as a
   * Set for O(1) membership tests during the merge. Degrades to just `{viewer}`
   * if the relation lookups fail (self must never be a candidate).
   */
  private async resolveExcludeIds(viewerId: string): Promise<Set<string>> {
    try {
      const [blocks, mutes, restricts] = await Promise.all([
        Block.find({ userId: viewerId }, { blockedId: 1, _id: 0 }).lean(),
        Mute.find({ userId: viewerId }, { mutedId: 1, _id: 0 }).lean(),
        Restrict.find({ userId: viewerId }, { restrictedId: 1, _id: 0 }).lean(),
      ]);
      const set = new Set<string>([viewerId]);
      for (const b of blocks) if (b.blockedId) set.add(b.blockedId);
      for (const m of mutes) if (m.mutedId) set.add(m.mutedId);
      for (const r of restricts) if (r.restrictedId) set.add(r.restrictedId);
      return set;
    } catch (error) {
      logger.warn(`[ContentAffinity] exclude-id resolution failed for ${viewerId}:`, error);
      return new Set<string>([viewerId]);
    }
  }

  /**
   * HASHTAG AFFINITY. Reads the viewer's followed hashtags, then aggregates the
   * recent PUBLIC, published authors posting under any of them. Each author's
   * weight rises with how many DISTINCT followed hashtags they cover plus a
   * saturating post-volume bonus.
   */
  private async computeHashtagAffinity(
    viewerId: string,
    since: Date,
  ): Promise<Map<string, AuthorAccumulator>> {
    const result = new Map<string, AuthorAccumulator>();
    try {
      const follows = await EntityFollow.find(
        { userId: viewerId, entityType: 'hashtag' },
        { entityId: 1, _id: 0 },
      )
        .limit(MAX_FOLLOWED_HASHTAGS)
        .lean();

      const tags = follows
        .map((f) => (typeof f.entityId === 'string' ? f.entityId.trim().toLowerCase() : ''))
        .filter((t) => t.length > 0);
      if (tags.length === 0) return result;

      // One aggregation: recent public posts under any followed tag, grouped by
      // author, tracking how many distinct followed tags they cover and their
      // post volume. Index-served by {hashtags, visibility, status, createdAt}.
      const rows = await Post.aggregate<{
        _id: string;
        matchedTags: string[];
        postCount: number;
      }>([
        {
          $match: {
            hashtags: { $in: tags },
            visibility: 'public',
            status: 'published',
            type: { $ne: 'boost' },
            oxyUserId: { $ne: null },
            createdAt: { $gte: since },
          },
        },
        { $sort: { createdAt: -1 } },
        { $limit: MAX_AUTHORS_PER_HASHTAG * tags.length },
        {
          $group: {
            _id: '$oxyUserId',
            // Distinct followed tags this author covered (intersection with `tags`).
            matchedTags: { $addToSet: { $setIntersection: ['$hashtags', tags] } },
            postCount: { $sum: 1 },
          },
        },
        { $limit: MAX_AUTHORS_PER_HASHTAG },
      ]);

      for (const row of rows) {
        const authorId = row._id;
        if (typeof authorId !== 'string' || authorId.length === 0 || authorId === viewerId) {
          continue;
        }
        // `matchedTags` is an array-of-arrays (one inner array per post); flatten
        // to the distinct set of followed tags this author actually covered.
        const distinctTags = new Set<string>();
        for (const inner of row.matchedTags ?? []) {
          if (Array.isArray(inner)) {
            for (const t of inner) if (typeof t === 'string') distinctTags.add(t);
          }
        }
        const coverage = distinctTags.size;
        if (coverage === 0) continue;

        const postCount = row.postCount ?? 0;
        // Saturating volume bonus: log-scaled so a prolific author gets a modest,
        // capped lift rather than dominating purely on volume.
        const volumeBonus =
          HASHTAG_VOLUME_BONUS_MAX * (Math.log1p(postCount) / Math.log1p(postCount + 4));
        const weight = coverage * HASHTAG_TAG_WEIGHT + volumeBonus;

        result.set(authorId, { weight, reasons: new Set(['hashtag']) });
      }
    } catch (error) {
      logger.warn(`[ContentAffinity] hashtag affinity failed for ${viewerId}:`, error);
      return new Map();
    }
    return result;
  }

  /**
   * ENGAGEMENT AFFINITY. Authors of posts the viewer LIKED, REPLIED TO, or
   * BOOSTED within the window. Likes are resolved Like→Post→author; replies and
   * boosts are read from the viewer's OWN posts (`parentPostId` / `boostOf`
   * point at the engaged post) and resolved to those posts' authors.
   */
  private async computeEngagementAffinity(
    viewerId: string,
    since: string,
  ): Promise<Map<string, AuthorAccumulator>> {
    const result = new Map<string, AuthorAccumulator>();

    // (a) Likes → liked posts (carrying the originating surface). (b) Viewer's
    // own reply/boost posts → engaged post ids. Both bounded + index-served.
    const [likes, replyTargetIds, boostTargetIds] = await Promise.all([
      this.collectLikes(viewerId, since),
      this.collectViewerInteractionTargets(viewerId, since, 'reply'),
      this.collectViewerInteractionTargets(viewerId, since, 'boost'),
    ]);

    // Resolve every engaged post id to its author in ONE batched query, then
    // re-attribute the weight per signal. Map keeps post id → author.
    const allIds = new Set<string>([
      ...likes.map((l) => l.postId),
      ...replyTargetIds,
      ...boostTargetIds,
    ]);
    if (allIds.size === 0) return result;

    const postAuthor = await this.resolvePostAuthors(Array.from(allIds));
    if (postAuthor.size === 0) return result;

    const addWeight = (authorId: string, weight: number, reason: string): void => {
      const existing = result.get(authorId);
      if (existing) {
        existing.weight += weight;
        existing.reasons.add(reason);
      } else {
        result.set(authorId, { weight, reasons: new Set([reason]) });
      }
    };

    const apply = (postIds: string[], weightPer: number, reason: string): void => {
      for (const postId of postIds) {
        const authorId = postAuthor.get(postId);
        if (!authorId || authorId === viewerId) continue;
        addWeight(authorId, weightPer, reason);
      }
    };

    // SURFACE-AWARE likes: a like from a video-first surface (reels) is mostly
    // about the CONTENT, not the author, so it contributes only a fraction of the
    // normal like weight toward this author becoming a FOLLOW candidate. Non-video
    // likes contribute the full weight (prior behavior). The popularity-floor
    // factor (~0.25) is the same shared constant used in UserBehavior attribution.
    const videoLikeFactor = MtnConfig.preferences.engagementContext.videoSurfaceAuthorAffinityFactor;
    for (const like of likes) {
      const authorId = postAuthor.get(like.postId);
      if (!authorId || authorId === viewerId) continue;
      const weight = like.fromVideoSurface
        ? ENGAGEMENT_LIKE_WEIGHT * videoLikeFactor
        : ENGAGEMENT_LIKE_WEIGHT;
      addWeight(authorId, weight, 'engagement');
    }

    apply(replyTargetIds, ENGAGEMENT_REPLY_WEIGHT, 'engagement');
    apply(boostTargetIds, ENGAGEMENT_BOOST_WEIGHT, 'engagement');

    return result;
  }

  /**
   * Collect the posts the viewer liked within the window, each carrying whether
   * the like originated on a video-first surface (from the Like doc's `source`),
   * so the engagement-affinity author scan can discount reels likes. Legacy likes
   * with no `source` are treated as non-video (full weight), preserving prior
   * behavior.
   */
  private async collectLikes(
    viewerId: string,
    since: string,
  ): Promise<Array<{ postId: string; fromVideoSurface: boolean }>> {
    try {
      const likes = await Like.find(
        { userId: viewerId, value: 1, createdAt: { $gte: since } },
        { postId: 1, source: 1, _id: 0 },
      )
        .sort({ createdAt: -1 })
        .limit(MAX_LIKES_SCANNED)
        .lean();
      return likes
        .map((l) => ({
          postId: l.postId ? String(l.postId) : '',
          fromVideoSurface: isVideoSurface(typeof l.source === 'string' ? l.source : undefined),
        }))
        .filter((l) => l.postId.length > 0);
    } catch (error) {
      logger.warn(`[ContentAffinity] liked-post collection failed for ${viewerId}:`, error);
      return [];
    }
  }

  /**
   * Collect the post ids the viewer engaged with via REPLY or BOOST, read from
   * the viewer's own posts. For replies the target is `parentPostId`; for boosts
   * it is `boostOf` (the original local post id).
   */
  private async collectViewerInteractionTargets(
    viewerId: string,
    since: string,
    kind: 'reply' | 'boost',
  ): Promise<string[]> {
    try {
      const match: QueryFilter<IPost> =
        kind === 'boost'
          ? { oxyUserId: viewerId, type: PostType.BOOST, boostOf: { $ne: null }, createdAt: { $gte: since } }
          : { oxyUserId: viewerId, parentPostId: { $ne: null }, createdAt: { $gte: since } };
      const field = kind === 'boost' ? { boostOf: 1, _id: 0 } : { parentPostId: 1, _id: 0 };

      const rows = await Post.find(match, field)
        .sort({ createdAt: -1 })
        .limit(MAX_VIEWER_INTERACTIONS_SCANNED)
        .lean();

      const targets: string[] = [];
      for (const row of rows) {
        const value = kind === 'boost' ? row.boostOf : row.parentPostId;
        if (typeof value === 'string' && value.length > 0) targets.push(value);
      }
      return targets;
    } catch (error) {
      logger.warn(`[ContentAffinity] ${kind} target collection failed for ${viewerId}:`, error);
      return [];
    }
  }

  /**
   * Resolve a batch of post ids to their author oxyUserIds in one query. Ignores
   * ids that are not valid ObjectIds or whose post has no author.
   */
  private async resolvePostAuthors(postIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (postIds.length === 0) return map;
    try {
      const rows = await Post.find(
        { _id: { $in: postIds } },
        { oxyUserId: 1 },
      ).lean();
      for (const row of rows) {
        const id = row?._id ? String(row._id) : '';
        const author = typeof row?.oxyUserId === 'string' ? row.oxyUserId : '';
        if (id && author) map.set(id, author);
      }
    } catch (error) {
      logger.warn('[ContentAffinity] post-author resolution failed:', error);
      return new Map();
    }
    return map;
  }

  /** Read cached candidates. Returns null on miss or any cache error. */
  private async readCache(key: string): Promise<ContentCandidate[] | null> {
    try {
      const client = getRedisClient();
      if (!client?.isReady) return null;
      const raw = await client.get(key);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ContentCandidate[]) : null;
    } catch (error) {
      logger.debug('[ContentAffinity] cache read failed:', error);
      return null;
    }
  }

  /** Write candidates to cache. Best-effort; never throws. */
  private async writeCache(key: string, value: ContentCandidate[]): Promise<void> {
    try {
      const client = getRedisClient();
      if (!client?.isReady) return;
      await client.set(key, JSON.stringify(value), { EX: CACHE_TTL_SECONDS });
    } catch (error) {
      logger.debug('[ContentAffinity] cache write failed:', error);
    }
  }
}

export const contentAffinityService = new ContentAffinityService();
export default contentAffinityService;
