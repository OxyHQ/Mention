import UserBehavior from '../models/UserBehavior';
import { MtnConfig } from '@mention/shared-types';
import { extractFollowingIds } from '../utils/privacyHelpers';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';
import { explainRanking } from '../mtn/feed/RankingExplainer';
import type { SignalCombiner } from './ranking/signals/types';
import { resolveCombiner } from './ranking/combiner';
import { RANKING_SIGNALS, newGroupProducts } from './ranking/signals/registry';
import {
  buildBehaviorSets,
  buildSignalContext,
  type BehaviorSets,
  type CalculatePostScoreContext,
  type FeedRankingSettings,
  type OptInSignalContext,
  type RankablePost,
  type RankingUserBehavior,
} from './ranking/signalContext';
import { engagementScore } from './ranking/signals/engagement';
import { authorityScore } from './ranking/signals/authority';
import {
  coldStartBoost,
  conversationalBoost,
  dwellTimeBoost,
  languageMismatchPenalty,
  localBoost,
  mediaBoost,
  noveltyBoost,
  penalizeSeen,
  positivityBoost,
  reciprocityBoost,
  socialProofBoost,
  starterPackBoost,
  verifiedBoost,
} from './ranking/signals/optIn';

/**
 * FeedRankingService — Advanced feed ranking algorithm
 * Similar to Twitter/X and Facebook's feed algorithms.
 *
 * The per-post score is a PRODUCT of modular, pure ranking SIGNALS (see
 * `services/ranking/signals/*`): engagement, recency, relationship, authority,
 * personalization, quality, trending velocity, time-of-day, thread boost,
 * negative penalty, and the opt-in composite. This service is the ORCHESTRATOR:
 * it resolves the per-request {@link SignalContext} once, iterates the ordered
 * registry, guards each contribution, combines them with the configured
 * {@link SignalCombiner}, and attaches the `_rank*` breakdown for the
 * `RankingExplainer`. It also owns the pool-level pipeline in {@link rankPosts}
 * (in-memory engagement memoization, large-set approximate prefilter, the
 * sequential diversity pass, and final sort).
 */
export class FeedRankingService {
  private readonly LARGE_CANDIDATE_SET_THRESHOLD = 1000; // Use approximate ranking for sets larger than this
  private readonly TOP_K_FOR_APPROXIMATE = 500; // Top K posts to fully rank when using approximate method

  // Weight configuration sourced from MtnConfig (single source of truth).
  private readonly R = MtnConfig.ranking;

  // The combiner strategy that folds the per-signal contributions into a score.
  // Selected once by `MtnConfig.ranking.combiner` ('product' today).
  private readonly combiner: SignalCombiner = resolveCombiner(MtnConfig.ranking.combiner);

  /**
   * Resolve per-author summary maps for the unique authors of a candidate post
   * set, in a SINGLE pass:
   *   - `followerCounts` (`authorId → followerCount`) for the author-authority
   *     signal,
   *   - `verified` (`authorId → isVerified`) for the opt-in `verifiedBoost` signal,
   *     and
   *   - `starterPackScores` (`authorId → curation score`) for the opt-in
   *     `starterPackBoost` signal.
   *
   * Backed by the shared Redis user-summary cache + a single bulk Oxy fetch for
   * cold authors, so the common case (warm cache) is one Redis round trip with no
   * Oxy call. The curation score is computed and cached alongside the identity on
   * that same cache-fill (`PostHydrationService.applyStarterPackScores`), so it
   * costs NO extra query here. Authors whose value is unavailable are simply absent
   * from the relevant map and fall back to a neutral multiplier.
   */
  private async resolveAuthorSummaries(posts: RankablePost[]): Promise<{
    followerCounts: Map<string, number>;
    verified: Map<string, boolean>;
    starterPackScores: Map<string, number>;
  }> {
    const followerCounts = new Map<string, number>();
    const verified = new Map<string, boolean>();
    const starterPackScores = new Map<string, number>();

    const authorIds = Array.from(
      new Set(
        posts
          .map((p) => (p?.oxyUserId ? String(p.oxyUserId) : ''))
          .filter((id): id is string => id.length > 0),
      ),
    );
    if (authorIds.length === 0) {
      return { followerCounts, verified, starterPackScores };
    }

    try {
      // Lazy import to avoid any module-load ordering coupling between the
      // ranking and hydration services.
      const { resolveUserSummaries } = await import('./PostHydrationService.js');
      const resolved = await resolveUserSummaries(authorIds);
      for (const [authorId, value] of resolved) {
        if (typeof value.followerCount === 'number') {
          followerCounts.set(authorId, value.followerCount);
        }
        if (typeof value.user?.verified === 'boolean') {
          verified.set(authorId, value.user.verified);
        }
        if (typeof value.starterPackScore === 'number') {
          starterPackScores.set(authorId, value.starterPackScore);
        }
      }
    } catch (error) {
      logger.warn('Failed to resolve author summaries for ranking signals:', error);
    }

    return { followerCounts, verified, starterPackScores };
  }

  /**
   * Resolve the per-request OPT-IN (Phase 2b) signal context for a candidate
   * pool. Each map/set is populated ONLY when its signal appears in
   * `enabledSignals`, so a feed that enables no opt-in signals (every preset)
   * returns an effectively-empty context and every opt-in scorer stays neutral —
   * no extra queries, no ranking change. Every resolution is fail-soft: a failure
   * yields an absent map, which the scorer treats as "no signal" (neutral).
   *
   * Content signals (`mediaBoost` / `positivity` / `conversational` /
   * `coldStartBoost`) read only fields already on the candidate post (plus the
   * follower counts resolved for authority), so they need nothing resolved here.
   */
  private async resolveOptInContext(params: {
    posts: RankablePost[];
    userId: string | undefined;
    enabledSignals: Set<string> | undefined;
    /** Verified flags already resolved alongside the authority follower counts. */
    authorVerified: Map<string, boolean>;
    /** Starter-pack curation scores already resolved alongside the follower counts. */
    authorStarterPackScores: Map<string, number>;
    /** The viewer's seen post ids (for `penalizeSeen`). */
    seenPostIds?: string[];
    /** The viewer's following ids (for `socialProof`'s network set). */
    followingIds: string[];
    /** The viewer's mutual ids (for `socialProof` + `reciprocityBoost`). */
    mutualIds?: string[];
  }): Promise<OptInSignalContext> {
    const {
      posts,
      userId,
      enabledSignals,
      authorVerified,
      authorStarterPackScores,
      seenPostIds,
      followingIds,
      mutualIds,
    } = params;
    if (!enabledSignals || enabledSignals.size === 0) {
      return {};
    }

    const optIn: OptInSignalContext = { enabledSignals };
    const postIds = (): string[] =>
      posts.map((p) => (p?._id != null ? String(p._id) : '')).filter((id) => id.length > 0);

    if (enabledSignals.has('verifiedBoost')) {
      optIn.authorVerified = authorVerified;
    }

    if (enabledSignals.has('starterPackBoost')) {
      optIn.authorStarterPackScores = authorStarterPackScores;
    }

    if (enabledSignals.has('penalizeSeen') && seenPostIds && seenPostIds.length > 0) {
      optIn.seenPostIdsSet = new Set(seenPostIds);
    }

    if (enabledSignals.has('reciprocityBoost') && mutualIds && mutualIds.length > 0) {
      optIn.mutualIdsSet = new Set(mutualIds);
    }

    if (enabledSignals.has('dwellTime')) {
      const { getDwellAverages } = await import('./dwellAggregate.js');
      optIn.dwellAverages = await getDwellAverages(postIds());
    }

    if (enabledSignals.has('socialProof')) {
      const engagerIds = Array.from(new Set([...(followingIds ?? []), ...(mutualIds ?? [])]));
      if (engagerIds.length > 0) {
        const { getNetworkEngagerCounts } = await import('./networkEngagement.js');
        optIn.networkEngagerCounts = await getNetworkEngagerCounts(postIds(), engagerIds);
      }
    }

    if (enabledSignals.has('noveltyBoost') && userId) {
      const { getRecentTopics } = await import('./viewerRecentTopics.js');
      optIn.viewerRecentTopics = await getRecentTopics(userId);
    }

    return optIn;
  }

  /**
   * Author-authority multiplier from the author's follower count — a bounded
   * popularity floor. Public delegator to the pure `authorityScore` signal so
   * controllers/tests can reuse it directly.
   */
  public calculateAuthorityScore(followerCount: number | undefined): number {
    return authorityScore(followerCount);
  }

  // ---------------------------------------------------------------------------
  // OPT-IN (Phase 2b) signal delegators.
  //
  // Each forwards to the pure scorer in `ranking/signals/optIn`, preserving the
  // public surface controllers/tests call directly. Applied to the score ONLY
  // for the signals a feed definition enabled (via the opt-in composite in the
  // registry); these delegators expose the individual scorers for reuse.
  // ---------------------------------------------------------------------------

  /** `mediaBoost` — favor posts that carry media. See `ranking/signals/optIn`. */
  public calculateMediaBoost(post: RankablePost): number {
    return mediaBoost(post);
  }

  /** `positivity` — favor classified positive-sentiment posts. */
  public calculatePositivityBoost(post: RankablePost): number {
    return positivityBoost(post);
  }

  /** `conversational` — favor constructive / conversational posts. */
  public calculateConversationalBoost(post: RankablePost): number {
    return conversationalBoost(post);
  }

  /** `coldStartBoost` — discovery lift for fresh posts / low-follower authors. */
  public calculateColdStartBoost(post: RankablePost, followerCount: number | undefined): number {
    return coldStartBoost(post, followerCount);
  }

  /** `penalizeSeen` — soft de-prioritization of already-seen posts. */
  public calculatePenalizeSeen(post: RankablePost, seenPostIds: Set<string> | undefined): number {
    return penalizeSeen(post, seenPostIds);
  }

  /** `verifiedBoost` — small lift for verified authors. */
  public calculateVerifiedBoost(post: RankablePost, authorVerified: Map<string, boolean> | undefined): number {
    return verifiedBoost(post, authorVerified);
  }

  /** `dwellTime` — favor high-dwell posts. */
  public calculateDwellTimeBoost(post: RankablePost, dwellAverages: Map<string, number> | undefined): number {
    return dwellTimeBoost(post, dwellAverages);
  }

  /** `socialProof` — favor posts engaged by the viewer's network. */
  public calculateSocialProofBoost(
    post: RankablePost,
    networkEngagerCounts: Map<string, number> | undefined,
  ): number {
    return socialProofBoost(post, networkEngagerCounts);
  }

  /** `reciprocityBoost` — favor mutual + preferred authors. */
  public calculateReciprocityBoost(
    post: RankablePost,
    userBehavior: RankingUserBehavior | undefined,
    mutualIdsSet: Set<string> | undefined,
  ): number {
    return reciprocityBoost(post, userBehavior, mutualIdsSet);
  }

  /** `noveltyBoost` — exploration lift for novel-topic posts. */
  public calculateNoveltyBoost(post: RankablePost, viewerRecentTopics: Set<string> | undefined): number {
    return noveltyBoost(post, viewerRecentTopics);
  }

  /** `localBoost` — modest lift for local (non-federated) posts. */
  public calculateLocalBoost(post: RankablePost): number {
    return localBoost(post);
  }

  /** `languageMismatchPenalty` — soft downrank of off-language discovery posts. */
  public calculateLanguageMismatchPenalty(post: RankablePost, viewerLanguages: string[] | undefined): number {
    return languageMismatchPenalty(post, viewerLanguages);
  }

  /** `starterPackBoost` — bounded lift for authors curated into others' starter packs. */
  public calculateStarterPackBoost(
    post: RankablePost,
    authorStarterPackScores: Map<string, number> | undefined,
  ): number {
    return starterPackBoost(post, authorStarterPackScores);
  }

  /**
   * Calculate the comprehensive feed score for a single post.
   *
   * ORCHESTRATOR: builds the per-request {@link SignalContext} once, iterates the
   * ordered {@link RANKING_SIGNALS} registry, guards each contribution against
   * NaN/Infinity, combines them with the configured {@link SignalCombiner}
   * (product by default), and clamps to a non-negative score. In the SAME pass it
   * accumulates each signal's multiplier into its explainer group so the
   * `_rank*` breakdown fields (read by `RankingExplainer`) are reproduced exactly:
   *   - engagement, recency
   *   - relationship = relationship · authority
   *   - personalization = personalization · optIn
   *   - quality = quality · trendingVelocity · timeOfDay · threadBoost
   *   - diversity = negativePenalty
   *
   * @param post - Post document (mutated in place with the `_rank*` breakdown).
   * @param userId - Oxy user ID (from req.user?.id) or undefined for anonymous.
   * @param context - Additional ranking context (following, behavior, opt-in…).
   */
  public async calculatePostScore(
    post: RankablePost,
    userId: string | undefined, // Oxy user ID
    context: CalculatePostScoreContext = {},
  ): Promise<number> {
    // Guard each sub-score against NaN/Infinity, per-signal fallback (1 = neutral).
    const safe = (score: number, fallback: number): number =>
      Number.isFinite(score) ? score : fallback;

    const ctx = buildSignalContext(userId, context);

    // Collect each signal's guarded contribution (in registry order) and, in the
    // same pass, accumulate it into its explainer group.
    const contributions = new Map<string, number>();
    const groupProducts = newGroupProducts();
    for (const signal of RANKING_SIGNALS) {
      const value = safe(signal.score(post, ctx), signal.fallback ?? 1);
      contributions.set(signal.id, value);
      groupProducts[signal.group] *= value;
    }

    const finalScore = this.combiner(contributions);
    const safeScore = Math.max(0, finalScore); // Ensure non-negative

    // Attach ranking factor breakdowns for RankingExplainer.
    post._rankEngagement = groupProducts.engagement;
    post._rankRecency = groupProducts.recency;
    post._rankRelationship = groupProducts.relationship;
    post._rankPersonalization = groupProducts.personalization;
    post._rankQuality = groupProducts.quality;
    post._rankDiversity = groupProducts.diversity;

    return safeScore;
  }

  /**
   * Calculate diversity penalty to avoid echo chambers.
   *
   * Used ONLY by the sequential diversity pass in {@link rankPosts} (which feeds
   * it the running `recentAuthorsSet` / `recentTopicsSet`). It is NOT part of the
   * per-post `calculatePostScore` product: there the recent-* sets are always
   * empty, so the factor was always `1.0` and has been removed as dead code.
   */
  private calculateDiversityPenalty(
    post: RankablePost,
    recentAuthorsSet: Set<string>,
    recentTopicsSet: Set<string>,
    diversitySettings?: FeedRankingSettings['diversity'],
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
    if (post.oxyUserId && recentAuthorsSet.has(post.oxyUserId)) {
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
   * Rank and sort posts by score.
   * Optimized with batch processing and score caching.
   *
   * @param posts - Array of post documents to rank
   * @param userId - Oxy user ID (from req.user?.id) or undefined for anonymous users
   * @param context - Additional context (followingIds, userBehavior, feedSettings)
   */
  async rankPosts<T extends RankablePost>(
    posts: T[],
    userId: string | undefined, // Oxy user ID
    context: {
      followingIds?: string[]; // Array of Oxy user IDs
      userBehavior?: RankingUserBehavior;
      feedSettings?: FeedRankingSettings; // User feed settings
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
      /**
       * The `weightKey`s of the OPT-IN (Phase 2b) ranking signals the feed
       * definition enabled. Absent/empty for every preset feed, so preset ranking
       * is unchanged; a custom feed forwards its enabled opt-in signals here.
       */
      enabledSignals?: Set<string>;
      /**
       * The viewer's already-seen post ids — resolved into a set for the
       * `penalizeSeen` opt-in signal. Only consumed when `penalizeSeen` is enabled.
       */
      seenPostIds?: string[];
      /**
       * The viewer's mutual-follow author ids — used by the `socialProof`
       * (network = following ∪ mutuals) and `reciprocityBoost` opt-in signals.
       * Only consumed when one of those signals is enabled.
       */
      mutualIds?: string[];
      /**
       * The viewer's account languages (BCP-47 locales), forwarded to the
       * `languageMismatchPenalty` opt-in signal, which matches them against a
       * post's ISO 639-1 classification languages on the base subtag.
       * Empty/absent ⇒ neutral. Only consumed when that signal is enabled.
       */
      viewerLanguages?: string[];
    } = {}
  ): Promise<T[]> {
    const rankingStartTime = Date.now();

    // Early return for empty posts
    if (posts.length === 0) {
      return [];
    }

    // Load user behavior if not provided (batch load once)
    let userBehavior: RankingUserBehavior | undefined = context.userBehavior;
    if (userId && !userBehavior) {
      try {
        userBehavior = (await UserBehavior.findOne({ oxyUserId: userId }).lean()) ?? undefined;
      } catch (error) {
        logger.warn('Failed to load user behavior:', error);
      }
    }

    // Get following list if not provided (batch load once)
    let followingIds = context.followingIds;
    if (userId && !followingIds) {
      try {
        // Service-authed Oxy client — the bare `oxy` singleton in server.ts is
        // unauthenticated and reserved for validating incoming request tokens
        // (`oxy.auth()`), so resolving the following list on it returns nothing.
        const followingRes = await getServiceOxyClient().getUserFollowing(userId);
        followingIds = extractFollowingIds(followingRes);
      } catch (error) {
        logger.warn('Failed to load following list:', error);
        followingIds = [];
      }
    }

    // Pre-compute Sets for O(1) lookups in scoring loop
    const followingIdsSet = new Set(followingIds || []);
    const behaviorSets: BehaviorSets | undefined = buildBehaviorSets(userBehavior);

    // Resolve author summaries ONCE for the authority signal (follower counts) and,
    // in the same pass, the verified flags the opt-in `verifiedBoost` reads plus the
    // curation scores the opt-in `starterPackBoost` reads. Skipped entirely when the
    // caller supplied follower counts (then both opt-in maps are empty → those
    // signals stay neutral, exactly as `verifiedBoost` already behaved).
    const {
      followerCounts: resolvedFollowerCounts,
      verified: authorVerified,
      starterPackScores: authorStarterPackScores,
    } = context.authorFollowerCounts
      ? {
          followerCounts: context.authorFollowerCounts,
          verified: new Map<string, boolean>(),
          starterPackScores: new Map<string, number>(),
        }
      : await this.resolveAuthorSummaries(posts);
    const authorFollowerCounts = resolvedFollowerCounts;

    // Resolve the OPT-IN (Phase 2b) signal context ONCE for this request. Every
    // per-signal resolution is gated on the signal being enabled, so a feed that
    // enables no opt-in signals (every preset) pays nothing here and its scoring
    // is unchanged.
    const optInContext = await this.resolveOptInContext({
      posts,
      userId,
      enabledSignals: context.enabledSignals,
      authorVerified,
      authorStarterPackScores,
      seenPostIds: context.seenPostIds,
      followingIds: followingIds ?? [],
      mutualIds: context.mutualIds,
    });

    // Pre-compute engagement scores once per post, in memory. `engagementScore`
    // is a PURE function of fields already loaded on the post (`stats`/`metadata`),
    // so computing it directly is strictly cheaper than any Redis round trip — a
    // per-post cache would add 150–500 network hops per feed request to memoize a
    // few microseconds of arithmetic. The map memoizes within this request so the
    // approximate prefilter and per-post scoring share one computation per post.
    const engagementScoreCache = new Map<string, number>();
    for (const post of posts) {
      const postId = post._id?.toString() || '';
      if (!engagementScoreCache.has(postId)) {
        engagementScoreCache.set(postId, engagementScore(post));
      }
    }

    // For large candidate sets, use approximate ranking (top-k selection)
    let postsToRank = posts;
    if (posts.length > this.LARGE_CANDIDATE_SET_THRESHOLD) {
      logger.debug(`Using approximate ranking for large candidate set (${posts.length} posts)`);
      // Quick pre-ranking based on engagement score only (fast approximation)
      const quickScores = posts.map((post, index) => {
        const postId = post._id?.toString() || '';
        const engagementScoreValue = engagementScoreCache.get(postId) || 0;
        // Simple recency boost
        const createdMs = new Date(post.createdAt ?? NaN).getTime();
        const postAge = isNaN(createdMs) ? Infinity : (Date.now() - createdMs) / (1000 * 60 * 60);
        const recencyBoost = postAge < 24 ? Math.exp(-postAge / 24) : 0.1;
        return {
          post,
          quickScore: engagementScoreValue * recencyBoost,
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
          viewerLanguages: context.viewerLanguages,
          ...optInContext,
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
      post.finalScore = score;
      post.rankingExplanation = explainRanking(post);
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
