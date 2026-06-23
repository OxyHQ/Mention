import { Post } from '../models/Post';
import UserBehavior from '../models/UserBehavior';
import mongoose from 'mongoose';
import { MtnConfig } from '@mention/shared-types';
import type { PostClassificationScores } from '@mention/shared-types';
import { BASELINE_CLASSIFIER_VERSION } from './BaselineContentClassifier';
import { isSensitivePost } from '../mtn/feed/feedSafety';
import { extractFollowingIds } from '../utils/privacyHelpers';
import { logger } from '../utils/logger';
import { getRedisClient } from '../utils/redis';
import { withRedisFallback } from '../utils/redisHelpers';
import { metrics } from '../utils/metrics';
import { explainRanking } from '../mtn/feed/RankingExplainer';

interface BehaviorSets {
  hiddenAuthors: Set<string>;
  mutedAuthors: Set<string>;
  blockedAuthors: Set<string>;
  hiddenTopics: Set<string>;
  preferredTopicIds: Set<string>;
}

/**
 * FeedRankingService - Advanced feed ranking algorithm
 * Similar to Twitter/X and Facebook's feed algorithms
 * 
 * Ranking factors:
 * 1. Engagement Score - likes, boosts, comments, views (with weights)
 * 2. Recency Score - time decay function
 * 3. Author Relationship - follow status, interaction history, relationship strength
 * 4. Personalization - user preferences, topic interests, post type preferences
 * 5. Content Quality - engagement rate, completion rate, skip rate
 * 6. Diversity - avoid echo chambers, mix content types
 * 7. Negative Signals - hidden, muted, blocked content
 */
export class FeedRankingService {
  private redis: ReturnType<typeof getRedisClient>;
  private readonly ENGAGEMENT_SCORE_CACHE_TTL = 5 * 60; // 5 minutes
  private readonly ENGAGEMENT_SCORE_CACHE_PREFIX = 'engagement:score:';
  private readonly LARGE_CANDIDATE_SET_THRESHOLD = 1000; // Use approximate ranking for sets larger than this
  private readonly TOP_K_FOR_APPROXIMATE = 500; // Top K posts to fully rank when using approximate method
  
  // Weight configuration sourced from MtnConfig (single source of truth)
  private readonly R = MtnConfig.ranking;

  // Shares weight is not in MtnConfig yet; keep a local constant until added
  private readonly SHARE_WEIGHT = 2.0;

  constructor() {
    this.redis = getRedisClient();
  }

  /**
   * Resolve `authorId → followerCount` for the unique authors of a candidate
   * post set, used by the author-authority signal. Backed by the shared
   * Redis user-summary cache + a single bulk Oxy fetch for cold authors, so the
   * common case (warm cache) is one Redis round trip with no Oxy call. Authors
   * whose follower count is unavailable are simply absent from the map and fall
   * back to a neutral authority multiplier.
   */
  private async resolveAuthorFollowerCounts(posts: any[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();

    const authorIds = Array.from(
      new Set(
        posts
          .map((p) => (p?.oxyUserId ? String(p.oxyUserId) : ''))
          .filter((id): id is string => id.length > 0),
      ),
    );
    if (authorIds.length === 0) {
      return counts;
    }

    try {
      // Lazy import to avoid any module-load ordering coupling between the
      // ranking and hydration services.
      const { resolveUserSummaries } = await import('./PostHydrationService.js');
      const resolved = await resolveUserSummaries(authorIds);
      for (const [authorId, value] of resolved) {
        if (typeof value.followerCount === 'number') {
          counts.set(authorId, value.followerCount);
        }
      }
    } catch (error) {
      logger.warn('Failed to resolve author follower counts for authority signal:', error);
    }

    return counts;
  }

  private buildBehaviorSets(userBehavior: any): BehaviorSets | undefined {
    if (!userBehavior) return undefined;
    return {
      hiddenAuthors: new Set<string>(userBehavior.hiddenAuthors || []),
      mutedAuthors: new Set<string>(userBehavior.mutedAuthors || []),
      blockedAuthors: new Set<string>(userBehavior.blockedAuthors || []),
      hiddenTopics: new Set<string>((userBehavior.hiddenTopics || []).map((t: string) => t.toLowerCase())),
      preferredTopicIds: new Set<string>(
        (userBehavior.preferredTopics || [])
          .filter((t: any) => t.topicId && t.weight > 0.3)
          .map((t: any) => t.topicId.toString()),
      ),
    };
  }

  /**
   * Resolve a post's content-classification scores when they are safe to use for
   * ranking — from EITHER source:
   *   - the deterministic Stage-A BASELINE (any non-`classified` status that has
   *     been baselined to the current ruleset `version`), or
   *   - the async AI Stage-B enrichment (status `classified`).
   *
   * This is what lets the SAME ranking path downrank spam/low-quality posts
   * deterministically before any AI runs; when the AI batch later overwrites
   * `scores` with higher-fidelity values (and flips status to `classified`), this
   * method transparently uses those instead.
   *
   * PROVENANCE GUARD — why we don't just trust `scores` being present: the Post
   * schema seeds a DEFAULT `scores` of all-zeros on every new doc, so a post that
   * was never actually scored carries `quality:0` (which would otherwise be read
   * as "very low quality"). We therefore only honor scores that have a real
   * provenance marker:
   *   - `status === 'classified'` → AI scores are real, OR
   *   - `version >= BASELINE_CLASSIFIER_VERSION` → the current deterministic
   *     baseline actually computed and wrote these scores.
   * A post with the default placeholder (no current `version`, not classified) is
   * treated as having NO usable signal.
   *
   * It remains the SINGLE neutral-when-absent guard for the ranking signals:
   * every caller (safety penalty + quality boost) treats a `null` return as
   * "no usable signal" and contributes exactly 1.0 (neutral). A post with no
   * `scores`, only the default placeholder, or a malformed value is therefore
   * NEVER penalized or boosted — the feed can never empty because scores are
   * absent.
   *
   * @returns the validated scores, or `null` when the signal must be ignored.
   */
  private getClassifiedScores(post: any): PostClassificationScores | null {
    const classification = post?.postClassification;
    if (!classification) {
      return null;
    }

    // Provenance: scores are real only if AI-classified OR baselined to the
    // current deterministic ruleset version. Otherwise they're the schema default
    // placeholder (all-zeros) and must be ignored (neutral).
    const isClassified = classification.status === 'classified';
    const version = classification.version;
    const isCurrentBaseline =
      typeof version === 'number' && version >= BASELINE_CLASSIFIER_VERSION;
    if (!isClassified && !isCurrentBaseline) {
      return null;
    }

    const scores = classification.scores;
    if (!scores || typeof scores !== 'object') {
      return null;
    }

    // Validate every field we rank on: finite and within the documented 0..1
    // range. A single bad value (or an unset field) disqualifies the whole object
    // (treated as absent → neutral) rather than letting a malformed score skew
    // ranking.
    const inUnitRange = (value: unknown): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

    if (
      !inUnitRange(scores.spam) ||
      !inUnitRange(scores.toxicity) ||
      !inUnitRange(scores.quality)
    ) {
      return null;
    }

    return scores as PostClassificationScores;
  }

  /**
   * The canonical resolved topics for a post, PREFERRING the new
   * `postClassification.topicRefs` (registry-linked, the single source of truth)
   * and FALLING BACK to the legacy `extracted.topics` for posts that predate the
   * canonical list. Returns `[]` when neither is present so every topic signal is
   * NEUTRAL for a topic-less post — the feed never empties when topics are absent.
   *
   * Both shapes expose the same fields readers need (`topicId`, `name`), so this
   * is a single normalization point: the rest of the ranking code reads one list.
   */
  private getCanonicalTopics(post: any): Array<{ topicId?: unknown; name?: unknown }> {
    const refs = post?.postClassification?.topicRefs;
    if (Array.isArray(refs) && refs.length > 0) {
      return refs;
    }
    const extracted = post?.extracted?.topics;
    if (Array.isArray(extracted) && extracted.length > 0) {
      return extracted;
    }
    return [];
  }

  /**
   * AI SAFETY penalty from the classified spam / toxicity scores.
   *
   * Returns a multiplier in `(0, 1]`: exactly `1.0` (neutral) when there is no
   * usable AI signal, or when neither spam nor toxicity crosses its configured
   * threshold; the strong `highRiskPenalty` (~0.1) when EITHER is high, pushing
   * the flagged post effectively out of the feed without hard-excluding it. This
   * is folded INTO the existing negative penalty, so it composes multiplicatively
   * with hidden/muted/blocked/hidden-topic penalties.
   */
  private calculateAiSafetyPenalty(post: any): number {
    const scores = this.getClassifiedScores(post);
    if (!scores) {
      return 1.0; // No usable AI signal → neutral.
    }

    const { spamThreshold, toxicityThreshold, highRiskPenalty } = this.R.aiQuality.safety;
    if (scores.spam >= spamThreshold || scores.toxicity >= toxicityThreshold) {
      return highRiskPenalty;
    }

    return 1.0;
  }

  /**
   * AI QUALITY multiplier from the classified `quality` score (0..1).
   *
   * Returns `null` when there is no usable AI signal so the caller falls back to
   * the engagement-rate quality heuristic. When present: a modest `highBoost`
   * for quality ≥ `highThreshold`, a modest `lowPenalty` for quality ≤
   * `lowThreshold`, and neutral `1.0` in between. Bounded by config, so the AI
   * quality signal nudges — never dominates — the multiplicative score.
   */
  private calculateAiQualityMultiplier(post: any): number | null {
    const scores = this.getClassifiedScores(post);
    if (!scores) {
      return null; // No usable AI signal → defer to engagement-rate quality.
    }

    const { highThreshold, lowThreshold, highBoost, lowPenalty } = this.R.aiQuality.quality;
    if (scores.quality >= highThreshold) {
      return highBoost;
    }
    if (scores.quality <= lowThreshold) {
      return lowPenalty;
    }

    return 1.0;
  }

  /**
   * Get cached engagement score or calculate and cache
   */
  private async getCachedEngagementScore(postId: string, post: any): Promise<number> {
    const cacheKey = `${this.ENGAGEMENT_SCORE_CACHE_PREFIX}${postId}`;
    
    // Try to get from cache
    const cached = await withRedisFallback(
      this.redis,
      async () => {
        const data = await this.redis.get(cacheKey);
        return data ? parseFloat(data) : null;
      },
      null,
      'engagement score cache'
    );
    
    if (cached !== null) {
      return cached;
    }
    
    // Calculate and cache
    const score = this.calculateEngagementScore(post);
    await withRedisFallback(
      this.redis,
      async () => {
        await this.redis.setEx(cacheKey, this.ENGAGEMENT_SCORE_CACHE_TTL, score.toString());
      },
      undefined,
      'engagement score cache set'
    );
    
    return score;
  }

  /**
   * Calculate comprehensive feed score for a post
   * Public method for use in controllers
   * 
   * @param post - Post document
   * @param userId - Oxy user ID (from req.user?.id) or undefined for anonymous users
   * @param context - Additional context for ranking (followingIds, userBehavior, etc.)
   */
  public async calculatePostScore(
    post: any,
    userId: string | undefined, // Oxy user ID
    context: {
      followingIds?: string[];
      userBehavior?: any;
      recentAuthors?: string[];
      recentTopics?: string[];
      feedSettings?: any; // User feed settings
      engagementScoreCache?: Map<string, number>; // Optional pre-calculated engagement scores
      followingIdsSet?: Set<string>;
      recentAuthorsSet?: Set<string>;
      recentTopicsSet?: Set<string>;
      behaviorSets?: BehaviorSets;
      /** Oxy authorId → follower count, for the author-authority signal. */
      authorFollowerCounts?: Map<string, number>;
      /**
       * Whether the viewer opted in to sensitive/NSFW content. When true, the
       * sensitive/NSFW hard-zero in the negative penalty is skipped so sensitive
       * posts rank normally for this viewer. Defaults to false (SFW).
       */
      showSensitiveContent?: boolean;
    } = {}
  ): Promise<number> {
    // Helper to guard each sub-score against NaN/Infinity
    const safe = (score: number, fallback: number = 1): number =>
      Number.isFinite(score) ? score : fallback;

    // Resolve Sets for O(1) lookups (use pre-computed if available, else create from arrays)
    const followingIdsSet = context.followingIdsSet ?? new Set(context.followingIds || []);
    const recentAuthorsSet = context.recentAuthorsSet ?? new Set(context.recentAuthors || []);
    const recentTopicsSet = context.recentTopicsSet ?? new Set(context.recentTopics || []);

    // Base engagement score (use cache if available, otherwise calculate)
    const postId = post._id?.toString() || '';
    let engagementScore: number;
    if (context.engagementScoreCache?.has(postId)) {
      engagementScore = safe(context.engagementScoreCache.get(postId)!, 0);
    } else {
      engagementScore = safe(this.calculateEngagementScore(post), 0);
    }

    // Recency score with time decay (using user settings if provided)
    const recencyScore = safe(this.calculateRecencyScore(
      post.createdAt,
      context.feedSettings?.recency?.halfLifeHours,
      context.feedSettings?.recency?.maxAgeHours
    ));

    // Author relationship score
    const authorScore = safe(await this.calculateAuthorScore(
      post.oxyUserId,
      userId,
      followingIdsSet,
      context.userBehavior
    ));

    // Author authority score (follower-count based, viewer-independent). Neutral
    // (1.0) when the author's follower count is unavailable, so it never crashes
    // or penalizes posts whose authors we couldn't resolve.
    const authorityScore = safe(this.calculateAuthorityScore(
      context.authorFollowerCounts?.get(String(post.oxyUserId)),
    ));

    // Personalization score
    const personalizationScore = safe(await this.calculatePersonalizationScore(
      post,
      context.userBehavior,
      context.behaviorSets,
    ));

    // Content quality score (with improved metrics)
    const qualityScore = safe(this.calculateQualityScore(post));

    // Trending boost (for posts gaining traction)
    const trendingBoost = safe(this.calculateTrendingBoost(post));

    // Time-of-day relevance score
    const timeOfDayScore = safe(this.calculateTimeOfDayScore(post, context.userBehavior));

    // Diversity penalty (apply after all boosts, using user settings if provided)
    const diversityPenalty = safe(this.calculateDiversityPenalty(
      post,
      recentAuthorsSet,
      recentTopicsSet,
      context.feedSettings?.diversity
    ));

    // Apply negative signals
    const negativePenalty = safe(await this.calculateNegativePenalty(
      post,
      userId,
      context.userBehavior,
      context.behaviorSets,
      context.showSensitiveContent === true,
    ));

    // Thread boost: thread roots with replies get a bump (encourages thread engagement)
    const threadBoost = safe(this.calculateThreadBoost(post));

    // Combine all scores (each sub-score is already guarded)
    const finalScore = engagementScore
      * recencyScore
      * authorScore
      * authorityScore
      * personalizationScore
      * qualityScore
      * trendingBoost
      * timeOfDayScore
      * threadBoost
      * diversityPenalty
      * negativePenalty;

    const safeScore = Math.max(0, finalScore); // Ensure non-negative

    // Attach ranking factor breakdowns for RankingExplainer
    post._rankEngagement = engagementScore;
    post._rankRecency = recencyScore;
    // Relationship breakdown folds in the viewer-independent authority signal so
    // the explainer reflects the full author contribution to the score.
    post._rankRelationship = authorScore * authorityScore;
    post._rankPersonalization = personalizationScore;
    post._rankQuality = qualityScore * trendingBoost * timeOfDayScore * threadBoost;
    post._rankDiversity = diversityPenalty * negativePenalty;

    return safeScore;
  }

  /**
   * Calculate engagement score from post stats with logarithmic normalization
   * Uses log scaling to prevent extremely popular posts from dominating
   */
  private calculateEngagementScore(post: any): number {
    const stats = post.stats || {};
    const metadata = post.metadata || {};
    
    // Get saves count from metadata.savedBy array
    const savesCount = Array.isArray(metadata.savedBy) 
      ? metadata.savedBy.length 
      : 0;
    
    // Calculate raw engagement score
    const rawScore = (
      (stats.likesCount || 0) * this.R.engagement.likeWeight +
      (stats.boostsCount || 0) * this.R.engagement.boostWeight +
      (stats.commentsCount || 0) * this.R.engagement.commentWeight +
      savesCount * this.R.engagement.saveWeight +
      (stats.viewsCount || 0) * this.R.engagement.viewWeight +
      (stats.sharesCount || 0) * this.SHARE_WEIGHT
    );
    
    // Apply logarithmic scaling to prevent extremely popular posts from dominating
    // log(1 + x) normalizes the score, +1 prevents log(0)
    // Scale factor of 10 provides good normalization range
    return Math.log1p(rawScore / 10);
  }

  /**
   * Calculate recency score with improved time decay
   * Uses configurable decay curve (exponential by default, can be linear or logarithmic)
   * 
   * @param createdAt - Post creation date
   * @param halfLifeHours - Optional custom half-life (from user settings)
   * @param maxAgeHours - Optional custom max age (from user settings)
   */
  private calculateRecencyScore(
    createdAt: Date | string,
    halfLifeHours?: number,
    maxAgeHours?: number
  ): number {
    const postDate = new Date(createdAt);
    if (isNaN(postDate.getTime())) {
      return 0; // Invalid date, treat as very old post
    }
    const now = new Date();
    const ageHours = (now.getTime() - postDate.getTime()) / (1000 * 60 * 60);

    const maxAge = maxAgeHours || this.R.recency.maxAgeMs / (1000 * 60 * 60);
    // If post is older than max age, return 0
    if (ageHours > maxAge) {
      return 0;
    }
    
    const halfLife = halfLifeHours || this.R.recency.halfLifeMs / (1000 * 60 * 60);
    
    // Very recent posts (within 1 hour) get full score
    if (ageHours < 1) {
      return 1.0;
    }
    
    // Exponential decay with half-life: value = 0.5 ^ (age / halfLife)
    // This provides smooth decay that accelerates as posts age
    const decayFactor = Math.pow(0.5, ageHours / halfLife);
    
    // Ensure minimum value to prevent complete zero for recent posts
    return Math.max(0.05, decayFactor);
  }

  /**
   * Calculate author relationship score
   * 
   * @param authorId - Oxy user ID of post author
   * @param userId - Oxy user ID of current user (or undefined)
   * @param followingIds - Array of Oxy user IDs that current user follows
   * @param userBehavior - User behavior data from UserBehavior model
   */
  private async calculateAuthorScore(
    authorId: string, // Oxy user ID
    userId: string | undefined, // Oxy user ID
    followingIdsSet: Set<string>, // Set of Oxy user IDs
    userBehavior: any
  ): Promise<number> {
    if (!userId) {
      return 1.0; // No personalization for anonymous users
    }

    // Check if following
    const isFollowing = followingIdsSet.has(authorId);
    if (isFollowing) {
      return this.R.relationship.followBoost;
    }
    
    // Check relationship strength from behavior data
    if (userBehavior?.preferredAuthors) {
      const authorPreference = userBehavior.preferredAuthors.find(
        (a: any) => a.authorId === authorId
      );
      
      if (authorPreference) {
        // Strong relationship (weight > 0.7)
        if (authorPreference.weight > 0.7) {
          return this.R.relationship.strongRelation;
        }
        // Weak relationship (weight > 0.3)
        if (authorPreference.weight > 0.3) {
          return this.R.relationship.weakRelation;
        }
      }
    }
    
    // No relationship - slight penalty
    return this.R.relationship.noRelation;
  }

  /**
   * Calculate author-authority score from the author's follower count.
   *
   * Philosophy: a POPULARITY FLOOR, not domination. Small creators (and authors
   * whose follower count we couldn't resolve) sit at ~1.0 — no penalty — while
   * established accounts get a MODEST, logarithmically-bounded lift. The log
   * curve means going from 0→1k followers matters far more than 100k→101k, so a
   * handful of mega-accounts never crowd out everyone else.
   *
   * Shape: `1 + k * log1p(followers)`, clamped to `[min, max]`.
   *
   * @param followerCount - author's follower count, or `undefined` when unknown.
   * @returns a multiplier in `[min, max]`; exactly `1.0` (neutral) when unknown.
   */
  public calculateAuthorityScore(followerCount: number | undefined): number {
    // Unknown follower count → neutral. Never penalize an unresolved author.
    if (typeof followerCount !== 'number' || !Number.isFinite(followerCount) || followerCount < 0) {
      return 1.0;
    }

    const { logScale, min, max } = this.R.authority;
    const raw = 1 + logScale * Math.log1p(followerCount);
    return Math.min(max, Math.max(min, raw));
  }

  /**
   * Calculate personalization score based on user preferences
   */
  private async calculatePersonalizationScore(
    post: any,
    userBehavior: any,
    behaviorSets?: BehaviorSets,
  ): Promise<number> {
    if (!userBehavior) {
      return 1.0;
    }
    
    let score = 1.0;
    
    // Topic matching (hashtags + AI-extracted topics)
    if (userBehavior.preferredTopics) {
      let matchCount = 0;

      // Match via hashtags (existing behavior)
      if (post.hashtags && post.hashtags.length > 0) {
        matchCount += post.hashtags.filter((tag: string) =>
          userBehavior.preferredTopics.some((t: any) =>
            t.topic.toLowerCase() === tag.toLowerCase() && t.weight > 0.3
          )
        ).length;
      }

      // Match via classified topic IDs (richer signal). Prefer the canonical
      // `postClassification.topicRefs`, falling back to legacy `extracted.topics`.
      const prefTopicIds = behaviorSets?.preferredTopicIds;
      if (prefTopicIds && prefTopicIds.size > 0) {
        matchCount += this.getCanonicalTopics(post).filter(
          (t: any) => t.topicId && prefTopicIds.has(t.topicId.toString()),
        ).length;
      }

      if (matchCount > 0) {
        score *= 1 + (matchCount * 0.1) * this.R.personalization.topicMatch;
      }
    }
    
    // Post type preference
    if (userBehavior.preferredPostTypes) {
      const postType = post.type?.toLowerCase() || 'text';
      const typeCount: number = (userBehavior.preferredPostTypes[postType as keyof typeof userBehavior.preferredPostTypes] as number) || 0;
      const totalTypes: number = Object.values(userBehavior.preferredPostTypes).reduce(
        (a: number, b: unknown) => a + (typeof b === 'number' ? b : 0), 0
      ) as number;
      
      if (totalTypes > 0 && typeCount > 0) {
        const typePreference = typeCount / totalTypes;
        if (typePreference > 0.3) { // User prefers this type
          score *= this.R.personalization.postTypeMatch;
        }
      }
    }
    
    // Language preference
    if (post.language && userBehavior.preferredLanguages?.length > 0) {
      if (userBehavior.preferredLanguages.includes(post.language)) {
        score *= this.R.personalization.languageMatch;
      }
    }
    
    return Math.min(score, 2.0); // Cap at 2x boost
  }

  /**
   * Calculate content quality score with improved metrics.
   *
   * Combines two orthogonal factors, both bounded:
   * 1. CONTENT quality — the AI `quality` score when the post is classified
   *    ({@link calculateAiQualityMultiplier}); otherwise the engagement-rate
   *    heuristic preserved below (rewarding genuine high-rate posts, penalizing
   *    high-view/no-engagement ones). An unscored post falls back to the exact
   *    prior engagement-rate behavior — it is never penalized for lacking AI.
   * 2. VELOCITY — recent engagement is more relevant (freshness multiplier).
   *
   * VELOCITY always applies; the AI quality signal, when present, REPLACES the
   * engagement-rate tier (they measure the same thing — content quality — so we
   * trust the AI judgment over the noisy engagement ratio rather than stacking
   * them).
   */
  private calculateQualityScore(post: any): number {
    const stats = post.stats || {};
    const viewsCount = stats.viewsCount || 0;

    // Engagement velocity: posts with recent engagement are more relevant.
    const createdAtMs = new Date(post.createdAt).getTime();
    const postAge = isNaN(createdAtMs) ? Infinity : (Date.now() - createdAtMs) / (1000 * 60 * 60); // hours
    const velocityBoost = postAge < 6 ? 1.2 : postAge < 24 ? 1.1 : 1.0;

    // Prefer the AI content-quality signal when this post is classified. It is
    // bounded by config and replaces the engagement-rate tier (same concept,
    // higher-fidelity signal). `null` → no usable AI signal → fall through to the
    // engagement-rate heuristic below so unscored posts behave exactly as before.
    const aiQuality = this.calculateAiQualityMultiplier(post);
    if (aiQuality !== null) {
      return aiQuality * velocityBoost;
    }

    // Calculate raw engagement (before log scaling for rate calculation)
    const rawEngagement = (
      (stats.likesCount || 0) * this.R.engagement.likeWeight +
      (stats.boostsCount || 0) * this.R.engagement.boostWeight +
      (stats.commentsCount || 0) * this.R.engagement.commentWeight +
      (Array.isArray(post.metadata?.savedBy) ? post.metadata.savedBy.length : 0) * this.R.engagement.saveWeight +
      (stats.sharesCount || 0) * this.SHARE_WEIGHT
    );

    // ROBUST engagement rate at low view counts: a post with only a few views
    // must not be promoted to "high quality" off a tiny denominator (2 views,
    // 1 like = rate 0.5). Below `minViewsForRate` we cannot trust the rate at
    // all, so quality is neutral (only velocity applies). At/above it we divide
    // by the ACTUAL view count.
    const minViewsForRate = this.R.quality.minViewsForRate;
    if (viewsCount < minViewsForRate) {
      return 1.0 * velocityBoost; // Not enough views to judge quality — neutral.
    }

    const engagementRate = rawEngagement / viewsCount;

    // High engagement rate = quality content
    if (engagementRate > 0.5) {
      return this.R.quality.highEngagement * velocityBoost;
    }

    // Medium engagement rate = decent quality
    if (engagementRate > 0.2) {
      return 1.0 * velocityBoost;
    }

    // Low engagement rate = lower quality (only once the post has enough views
    // to make that judgment — the gate was lowered 100 → config.lowEngagementMinViews).
    if (engagementRate < 0.1 && viewsCount > this.R.quality.lowEngagementMinViews) {
      return this.R.quality.lowEngagement;
    }

    return 1.0;
  }

  /**
   * Calculate trending boost for posts with accelerating engagement
   * Detects posts that are gaining traction rapidly
   */
  private calculateTrendingBoost(post: any): number {
    const stats = post.stats || {};
    const createdAtMs = new Date(post.createdAt).getTime();
    const postAge = isNaN(createdAtMs) ? Infinity : (Date.now() - createdAtMs) / (1000 * 60 * 60); // hours

    // Only consider posts less than 24 hours old for trending
    if (postAge > 24) {
      return 1.0;
    }
    
    // Calculate engagement density (engagement per hour)
    const rawEngagement = (
      (stats.likesCount || 0) * this.R.engagement.likeWeight +
      (stats.boostsCount || 0) * this.R.engagement.boostWeight +
      (stats.commentsCount || 0) * this.R.engagement.commentWeight +
      (Array.isArray(post.metadata?.savedBy) ? post.metadata.savedBy.length : 0) * this.R.engagement.saveWeight +
      (stats.sharesCount || 0) * this.SHARE_WEIGHT
    );
    
    const engagementPerHour = rawEngagement / Math.max(postAge, 0.1);
    
    // Boost posts with high engagement density (trending)
    if (engagementPerHour > 50) {
      return 1.5; // Strong trending boost
    } else if (engagementPerHour > 20) {
      return 1.3; // Moderate trending boost
    } else if (engagementPerHour > 10) {
      return 1.15; // Light trending boost
    }
    
    return 1.0; // No trending boost
  }

  /**
   * Calculate thread boost for thread root posts with replies.
   * Thread roots that sparked conversation are more valuable feed items,
   * especially since they'll be displayed as grouped slices.
   */
  private calculateThreadBoost(post: any): number {
    const hasThread = post.threadId && !post.parentPostId;
    const hasReplies = (post.stats?.commentsCount || 0) > 0;

    if (hasThread && hasReplies) {
      return 1.1; // 10% boost for thread roots with conversation
    }
    return 1.0;
  }

  /**
   * Calculate time-of-day relevance score
   * Boosts posts created during user's active hours
   */
  private calculateTimeOfDayScore(
    post: any,
    userBehavior: any
  ): number {
    if (!userBehavior?.activeHours || userBehavior.activeHours.length === 0) {
      return 1.0; // No preference data
    }
    
    const postDate = new Date(post.createdAt);
    const postHour = postDate.getHours();
    
    // Check if post was created during user's active hours
    if (userBehavior.activeHours.includes(postHour)) {
      return 1.2; // Boost for posts created during active hours
    }
    
    // Check adjacent hours (within 1 hour of active time)
    const adjacentHours = [
      (postHour + 23) % 24, // Previous hour
      (postHour + 1) % 24   // Next hour
    ];
    
    if (adjacentHours.some(h => userBehavior.activeHours.includes(h))) {
      return 1.1; // Slight boost for adjacent hours
    }
    
    return 1.0; // No boost
  }

  /**
   * Calculate diversity penalty to avoid echo chambers
   * Uses user settings if provided, otherwise uses defaults
   */
  private calculateDiversityPenalty(
    post: any,
    recentAuthorsSet: Set<string>,
    recentTopicsSet: Set<string>,
    diversitySettings?: any
  ): number {
    // If diversity is disabled, return no penalty
    if (diversitySettings?.enabled === false) {
      return 1.0;
    }
    
    // Use user settings or defaults
    const sameAuthorPenalty = diversitySettings?.sameAuthorPenalty ?? this.R.diversity.sameAuthorPenalty;
    const sameTopicPenalty = diversitySettings?.sameTopicPenalty ?? this.R.diversity.sameTopicPenalty;
    
    let penalty = 1.0;
    
    // Penalize if same author appeared recently
    if (recentAuthorsSet.has(post.oxyUserId)) {
      penalty *= sameAuthorPenalty;
    }
    
    // Penalize if same topics appeared recently
    if (post.hashtags && post.hashtags.length > 0) {
      const recentTopicMatches = post.hashtags.filter((tag: string) =>
        recentTopicsSet.has(tag.toLowerCase())
      );
      
      if (recentTopicMatches.length > 0) {
        penalty *= sameTopicPenalty;
      }
    }
    
    return penalty;
  }

  /**
   * Calculate negative signals penalty.
   *
   * Combines three kinds of penalty, multiplicatively:
   * 1. SENSITIVE/NSFW hard exclusion — a sensitive/NSFW post
   *    ({@link isSensitivePost}: classifier/metadata/federation flag OR an
   *    NSFW-blocklisted hashtag) returns `0`, fully removing it from the ranked
   *    feeds. VIEWER-CONDITIONAL: applied only when the viewer is in safe-for-work
   *    mode (`showSensitiveContent` is false/undefined — the default, including
   *    anonymous viewers). When the viewer has opted in (`showSensitiveContent`
   *    is true), a sensitive post is NOT zeroed and ranks normally (still carrying
   *    its sensitive flag for client-side blur / content warnings). This is the
   *    belt-and-suspenders guard for SFW viewers: even if a sensitive post slips
   *    into the candidate pool, it can never surface in their ranked feed. NEUTRAL
   *    for clean posts, so normal ranking is unchanged.
   * 2. VIEWER negative signals — hidden / muted / blocked authors and hidden
   *    topics (require a logged-in viewer with behavior data).
   * 3. CONTENT AI-safety penalty — high spam / toxicity from the classified
   *    scores ({@link calculateAiSafetyPenalty}). This is viewer-INDEPENDENT, so
   *    it applies on EVERY path (including anonymous) — but it is exactly `1.0`
   *    (neutral) for any post that isn't AI-classified with high-risk scores, so
   *    the feed never empties when AI scores are absent.
   */
  private async calculateNegativePenalty(
    post: any,
    userId: string | undefined,
    userBehavior: any,
    behaviorSets?: BehaviorSets,
    showSensitiveContent: boolean = false,
  ): Promise<number> {
    // Sensitive/NSFW is a HARD exclusion from ranked feeds (For You / Explore /
    // Videos / Media) for safe-for-work viewers — short-circuit to 0 so the post
    // can never surface no matter how strong its other signals are. When the
    // viewer has explicitly opted in to sensitive content, skip this guard so the
    // post ranks normally (it keeps its sensitive flag for client-side blur/CW).
    if (!showSensitiveContent && isSensitivePost(post)) {
      return 0;
    }

    // Content-level AI safety penalty applies regardless of viewer/behavior.
    const aiSafetyPenalty = this.calculateAiSafetyPenalty(post);

    if (!userId || !userBehavior) {
      return aiSafetyPenalty;
    }

    const authorId = post.oxyUserId;

    // Use pre-computed Sets if available, else create from arrays
    const sets = behaviorSets ?? this.buildBehaviorSets(userBehavior)!;

    // Check if author is hidden, muted, or blocked
    if (
      sets.hiddenAuthors.has(authorId) ||
      sets.mutedAuthors.has(authorId) ||
      sets.blockedAuthors.has(authorId)
    ) {
      return 0; // Completely hide
    }

    // Check if topic is hidden (via hashtags or canonical classified topic
    // names). Topic names come from the canonical `postClassification.topicRefs`,
    // falling back to legacy `extracted.topics`.
    if (sets.hiddenTopics.size > 0) {
      const hasHiddenHashtag = post.hashtags?.some((tag: string) =>
        sets.hiddenTopics.has(tag.toLowerCase())
      );

      const hasHiddenClassifiedTopic = this.getCanonicalTopics(post).some(
        (t: any) => typeof t.name === 'string' && sets.hiddenTopics.has(t.name.toLowerCase()),
      );

      if (hasHiddenHashtag || hasHiddenClassifiedTopic) {
        return 0.5 * aiSafetyPenalty; // Reduce visibility (composes with AI safety)
      }
    }

    return aiSafetyPenalty;
  }

  /**
   * Rank and sort posts by score
   * Optimized with batch processing and score caching
   * 
   * @param posts - Array of post documents to rank
   * @param userId - Oxy user ID (from req.user?.id) or undefined for anonymous users
   * @param context - Additional context (followingIds, userBehavior, feedSettings)
   */
  async rankPosts(
    posts: any[],
    userId: string | undefined, // Oxy user ID
    context: {
      followingIds?: string[]; // Array of Oxy user IDs
      userBehavior?: any;
      feedSettings?: any; // User feed settings
      /**
       * Oxy authorId → follower count for the author-authority signal. When
       * omitted, it is resolved here from the candidate posts' authors (cache +
       * bulk fetch). Pass it explicitly to reuse counts already in hand and
       * avoid the resolution round trip.
       */
      authorFollowerCounts?: Map<string, number>;
      /**
       * Whether the viewer opted in to sensitive/NSFW content. Threaded into
       * per-post scoring so the sensitive/NSFW hard-zero is applied ONLY for
       * safe-for-work viewers. Defaults to false (SFW), so anonymous and
       * default viewers behave exactly as before.
       */
      showSensitiveContent?: boolean;
    } = {}
  ): Promise<any[]> {
    const rankingStartTime = Date.now();
    
    // Early return for empty posts
    if (posts.length === 0) {
      return [];
    }
    
    // Load user behavior if not provided (batch load once)
    let userBehavior = context.userBehavior;
    if (userId && !userBehavior) {
      try {
        userBehavior = await UserBehavior.findOne({ oxyUserId: userId }).lean();
      } catch (error) {
        logger.warn('Failed to load user behavior:', error);
      }
    }
    
    // Get following list if not provided (batch load once)
    let followingIds = context.followingIds;
    if (userId && !followingIds) {
      try {
        // Lazy import to avoid circular dependency with server.ts
        const { oxy } = await import('../../server.js');
        const followingRes = await oxy.getUserFollowing(userId);
        followingIds = extractFollowingIds(followingRes);
      } catch (error) {
        logger.warn('Failed to load following list:', error);
        followingIds = [];
      }
    }
    
    // Pre-compute Sets for O(1) lookups in scoring loop
    const followingIdsSet = new Set(followingIds || []);
    const behaviorSets = this.buildBehaviorSets(userBehavior);

    // Resolve author follower counts ONCE for the authority signal (unless the
    // caller already supplied them). Cache-backed + bulk-fetched, so this is a
    // single batched round trip for the cold authors only.
    const authorFollowerCounts = context.authorFollowerCounts
      ?? await this.resolveAuthorFollowerCounts(posts);

    // Pre-calculate engagement scores with caching (batch load from cache)
    const engagementScoreCache = new Map<string, number>();
    const engagementScorePromises = posts.map(async (post) => {
      const postId = post._id?.toString() || '';
      if (!engagementScoreCache.has(postId)) {
        const score = await this.getCachedEngagementScore(postId, post);
        engagementScoreCache.set(postId, score);
      }
    });
    await Promise.all(engagementScorePromises);
    
    // For large candidate sets, use approximate ranking (top-k selection)
    let postsToRank = posts;
    if (posts.length > this.LARGE_CANDIDATE_SET_THRESHOLD) {
      logger.debug(`Using approximate ranking for large candidate set (${posts.length} posts)`);
      // Quick pre-ranking based on engagement score only (fast approximation)
      const quickScores = posts.map((post, index) => {
        const postId = post._id?.toString() || '';
        const engagementScore = engagementScoreCache.get(postId) || 0;
        // Simple recency boost
        const createdMs = new Date(post.createdAt).getTime();
        const postAge = isNaN(createdMs) ? Infinity : (Date.now() - createdMs) / (1000 * 60 * 60);
        const recencyBoost = postAge < 24 ? Math.exp(-postAge / 24) : 0.1;
        return {
          post,
          quickScore: engagementScore * recencyBoost,
          originalIndex: index
        };
      });
      
      // Sort by quick score and take top K
      quickScores.sort((a, b) => b.quickScore - a.quickScore);
      postsToRank = quickScores.slice(0, this.TOP_K_FOR_APPROXIMATE).map(item => item.post);
      logger.debug(`Reduced candidate set from ${posts.length} to ${postsToRank.length} posts for full ranking`);
    }
    
    // Calculate base scores for all posts in parallel (without diversity)
    // Preserve original index to maintain MongoDB's createdAt sort order for tie-breaking
    const postsWithBaseScores = await Promise.all(
      postsToRank.map(async (post, originalIndex) => {
        const score = await this.calculatePostScore(post, userId, {
          userBehavior,
          feedSettings: context.feedSettings,
          engagementScoreCache,
          followingIdsSet,
          behaviorSets,
          authorFollowerCounts,
          showSensitiveContent: context.showSensitiveContent,
        });
        return { post, score, originalIndex };
      })
    );

    // Apply diversity penalty sequentially — each post's penalty depends on previously seen authors/topics
    // Per-slice awareness: posts that will be grouped into the same thread slice
    // (same threadId + same oxyUserId) only penalize once for their author
    const recentAuthorsSet = new Set<string>();
    const recentTopicsSet = new Set<string>();
    const penalizedThreadIds = new Set<string>();
    const safe = (v: number, fallback: number = 1) => Number.isFinite(v) ? v : fallback;

    const postsWithScores = postsWithBaseScores.map((item) => {
      // For thread children by the same author, skip diversity penalty
      // if the thread root was already counted (they'll appear in the same slice)
      const threadKey = item.post.threadId && item.post.oxyUserId
        ? `${item.post.threadId}:${item.post.oxyUserId}`
        : null;
      const isAlreadyPenalizedThread = threadKey && penalizedThreadIds.has(threadKey);

      const diversityPenalty = isAlreadyPenalizedThread
        ? 1.0 // Skip penalty — this post will be grouped with its thread root
        : safe(this.calculateDiversityPenalty(
            item.post,
            recentAuthorsSet,
            recentTopicsSet,
            context.feedSettings?.diversity
          ));

      // Track this post's author/topics for subsequent posts
      if (item.post.oxyUserId && !isAlreadyPenalizedThread) {
        recentAuthorsSet.add(item.post.oxyUserId);
      }
      if (item.post.hashtags && !isAlreadyPenalizedThread) {
        item.post.hashtags.forEach((tag: string) => {
          recentTopicsSet.add(tag.toLowerCase());
        });
      }
      if (threadKey) {
        penalizedThreadIds.add(threadKey);
      }

      return { ...item, score: item.score * diversityPenalty };
    });
    
    // Sort by score (descending), preserving MongoDB's createdAt order for ties
    // MongoDB already sorted by createdAt: -1, so originalIndex reflects that order
    postsWithScores.sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (Math.abs(scoreDiff) > 0.001) {
        return scoreDiff; // Significant score difference, use score
      }
      // Scores are very close or equal - preserve MongoDB's createdAt order
      // Lower originalIndex = newer post (MongoDB sorted createdAt: -1)
      return a.originalIndex - b.originalIndex;
    });
    
    // CRITICAL: Attach finalScore and ranking explanation to each post for later reuse
    // This avoids expensive recalculation during cursor filtering
    // Performance optimization: saves ~60-100ms per request for large feeds
    postsWithScores.forEach(({ post, score }) => {
      (post as any).finalScore = score;
      (post as any).rankingExplanation = explainRanking(post);
    });
    
    // Record ranking metrics
    const rankingDuration = Date.now() - rankingStartTime;
    metrics.recordLatency('feed_ranking_duration_ms', rankingDuration, { 
      post_count: posts.length.toString(),
      user_id: userId || 'anonymous'
    });
    metrics.setGauge('feed_ranking_posts_processed', posts.length);
    
    // Return ranked posts with scores attached
    return postsWithScores.map(item => item.post);
  }
}

export const feedRankingService = new FeedRankingService();

