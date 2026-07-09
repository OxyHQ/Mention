/**
 * MTN Protocol Configuration
 *
 * Centralized constants replacing magic numbers scattered across strategies.
 * All ranking weights, cache TTLs, feed params in one place.
 */

export const MtnConfig = {
  // --- Ranking weights ---
  ranking: {
    engagement: {
      likeWeight: 1.0,
      boostWeight: 2.5,
      commentWeight: 2.0,
      saveWeight: 1.5,
      // Raised from 0.1 → 0.3 now that real impression-backed view counts flow
      // in (frontend impression reporting + deduped server-side view counting).
      // Views are a weak-but-real signal; this keeps them subordinate to likes
      // and boosts while letting a heavily-seen post edge out an unseen one.
      viewWeight: 0.3,
    },
    recency: {
      halfLifeMs: 24 * 60 * 60 * 1000, // 24 hours
      maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
    relationship: {
      followBoost: 1.8,
      strongRelation: 1.5,
      weakRelation: 1.2,
      noRelation: 0.9,
    },
    personalization: {
      topicMatch: 1.4,
      postTypeMatch: 1.3,
      languageMatch: 1.2,
    },
    /**
     * EXPLORE RELEVANCE — a LIGHT, BOUNDED lift applied ONLY to the
     * authenticated Explore (discovery) feed on top of its engagement×recency
     * score. Explore stays DISCOVERY of non-followed content — these weights do
     * NOT personalize-via-follows and they are NOT a hard filter: a non-matching
     * post still appears (for serendipity), it just ranks a bit lower than an
     * equally-engaging post that matches the viewer's learned signals.
     *
     * Deliberately GENTLER than `personalization` above (Explore is discovery,
     * not the curated For You feed) so the engagement×recency trending signal
     * still dominates. Each matched dimension multiplies in; the product is
     * clamped to `maxBoost` so no single viewer signal can dominate ranking.
     *
     * Anonymous Explore passes NO viewer signals, so every multiplier collapses
     * to exactly 1.0 (neutral) and behavior is unchanged.
     */
    exploreRelevance: {
      /**
       * Multiplier when one or more of the post's classified topics
       * (`postClassification.topics`) overlaps the viewer's `preferredTopics`.
       * Applied ONCE (presence of overlap), not scaled by match count, so a
       * multi-topic post can't run away with the score.
       */
      topicMatch: 1.25,
      /**
       * Multiplier when ANY of the post's `postClassification.languages` is one
       * of the viewer's preferred languages.
       */
      languageMatch: 1.15,
      /**
       * Multiplier when the post's `postClassification.region` equals the
       * viewer's learned coarse region. Region is best-effort/sparse, so this is
       * usually neutral (1.0); it only lifts when both sides actually carry one.
       */
      regionMatch: 1.1,
      /**
       * Hard ceiling on the COMBINED relevance multiplier (topic × language ×
       * region). Bounds the lift so relevance nudges, never overwhelms, the
       * engagement×recency trending order.
       */
      maxBoost: 1.5,
    },
    quality: {
      highEngagement: 1.3,
      lowEngagement: 0.8,
      /**
       * Minimum view count before a LOW engagement-rate post is penalized.
       * Lowered 100 → 20: real view counts are now far lower than the inflated
       * federated aggregates that existed when 100 was chosen, so the old gate
       * almost never fired. 20 views is enough signal to trust a low rate.
       */
      lowEngagementMinViews: 20,
      /**
       * Floor applied to the per-view divisor when computing engagement RATE, so
       * a post with a handful of views (e.g. 2 views, 1 like = rate 0.5) is not
       * spuriously promoted to "high quality". Below this many views we treat the
       * rate as neutral rather than letting a tiny denominator inflate it.
       */
      minViewsForRate: 20,
    },
    diversity: {
      // Strengthened so the feed mixes authors/topics more aggressively and
      // avoids a single prolific author or trending tag dominating a session.
      sameAuthorPenalty: 0.85, // was 0.95
      sameTopicPenalty: 0.80, // was 0.92
      /**
       * Minimum number of OTHER items that must appear between two items by the
       * same author in the emitted page. The soft multiplicative `sameAuthorPenalty`
       * above only nudges scores and a high-scoring author easily overpowers it,
       * producing the "5 posts in a row from one user" clustering. This is the HARD
       * spacing the post-ranking diversity rerank enforces.
       *
       * 1 = never two consecutive items by the same author.
       * 2 = at least one different author must sit between two same-author items.
       */
      authorMinGap: 2,
      /**
       * Hard cap on how many items a single author may contribute to one rendered
       * page. Prevents a prolific author from filling the page even with spacing.
       * The reranker never DROPS items — it defers an author's overflow items to
       * the tail of the page (so they appear after everyone else, or roll to the
       * next page via pagination) rather than removing them.
       */
      maxPerAuthorPerPage: 3,
    },
    /**
     * Author authority (follower-count) signal. A bounded multiplier that gives
     * established accounts a MODEST lift without letting them dominate — small
     * creators stay at the neutral floor (~1.0). Shape: 1 + k * log1p(followers),
     * clamped to [min, max]. Defaults to `max=1.0`-neutral effect only when the
     * follower count is unavailable (handled in code, not here).
     */
    authority: {
      logScale: 0.05, // k — how fast the boost grows with log(followers)
      min: 0.9, // floor (a 0-follower / unknown-but-present author)
      max: 1.4, // ceiling (a very large account)
    },
    /**
     * AI content-classification signals (`postClassification.scores`, each 0..1)
     * folded into ranking — see `FeedRankingService`. These ONLY apply when a
     * post is fully AI-classified (`postClassification.status === 'classified'`
     * AND `scores` present). Unscored / baseline / pending / failed posts are
     * treated as NEUTRAL (every multiplier below collapses to exactly 1.0), so
     * the feed never empties when AI scores are absent.
     *
     * SAFETY (spam + toxicity) folds into the negative penalty; QUALITY folds
     * into / augments the engagement-rate quality score. All effects are bounded.
     */
    aiQuality: {
      /**
       * SAFETY downrank — spam & toxicity. A score AT OR ABOVE the threshold is
       * "high" and earns the strong multiplicative penalty. Both signals share
       * the same penalty (the worse of the two dominates, since penalties
       * multiply). The penalty is strong enough to push a flagged post out of
       * the feed without hard-deleting it (multiplicative, not a filter).
       */
      safety: {
        /** spam score ≥ this → high-spam → strong downrank. */
        spamThreshold: 0.7,
        /** toxicity score ≥ this → high-toxicity → strong downrank. */
        toxicityThreshold: 0.7,
        /**
         * Multiplier applied to a high-spam OR high-toxicity post. ~0.1 pushes
         * it ~10x down — effectively out of the visible feed — while keeping the
         * model multiplicative (no special-case exclusion).
         */
        highRiskPenalty: 0.1,
      },
      /**
       * QUALITY adjustment from the AI `quality` score (0..1). At/above
       * `highThreshold` → modest boost; at/below `lowThreshold` → modest
       * downrank; in between → neutral (1.0). Bounded, so a single AI signal
       * never dominates the multiplicative score. When the AI quality score is
       * present it REPLACES the engagement-rate quality heuristic; otherwise the
       * engagement-rate behavior is preserved unchanged.
       */
      quality: {
        /** quality score ≥ this → high quality → modest boost. */
        highThreshold: 0.7,
        /** quality score ≤ this → low quality → modest downrank. */
        lowThreshold: 0.3,
        /** Multiplier for a high-quality (AI) post. */
        highBoost: 1.3,
        /** Multiplier for a low-quality (AI) post. */
        lowPenalty: 0.7,
      },
    },

    /**
     * OPT-IN ranking signals (Phase 2b).
     *
     * Each of these is default-NEUTRAL (multiplier exactly 1.0) and is applied by
     * `FeedRankingService` ONLY when a feed definition explicitly enables the
     * matching signal module (custom feeds + deliberate future tuning). They are
     * NOT part of any preset's default signal set, so For You / Explore / Videos /
     * Media ranking is unchanged. Every weight below is deliberately CONSERVATIVE
     * and bounded so a single opt-in signal nudges — never dominates — the score.
     */
    optInSignals: {
      /** Favor posts that carry media (image / video / gif). */
      mediaBoost: {
        /** Multiplier for a post with at least one media attachment. */
        boost: 1.15,
      },
      /** Favor positive-sentiment posts (AI Stage-B `sentiment`, provenance-gated). */
      positivity: {
        /** Multiplier for a `sentiment === 'positive'` classified post. */
        boost: 1.1,
      },
      /**
       * Favor constructive / conversational posts. Scales with the classified
       * `constructiveness` score (provenance-gated) or, absent that, the reply
       * ratio derived from `stats`. The multiplier is `1 + signal * (maxBoost-1)`,
       * so a signal of 0 collapses to neutral.
       */
      conversational: {
        /** Ceiling on the conversational multiplier (signal === 1). */
        maxBoost: 1.2,
      },
      /**
       * DISCOVERY lift for brand-new posts and low-follower ("cold") authors, to
       * help fresh content surface. Applied when the post is within `windowMs` of
       * creation OR the author's follower count is below `newAuthorFollowerThreshold`.
       */
      coldStartBoost: {
        boost: 1.15,
        /** Posts newer than this get the freshness lift. 6h. */
        windowMs: 6 * 60 * 60 * 1000,
        /** Authors with fewer followers than this are treated as cold-start authors. */
        newAuthorFollowerThreshold: 25,
      },
      /**
       * SOFT de-prioritize (not hard-exclude) posts the viewer has already seen —
       * a gentle downrank so seen content can still appear but yields to fresh
       * content. Multiplier < 1.
       */
      penalizeSeen: {
        penalty: 0.5,
      },
      /** Small lift for verified authors (Oxy `isVerified`). */
      verifiedBoost: {
        boost: 1.1,
      },
      /**
       * Lift scaled by how many of the viewer's network (following ∪ mutuals)
       * engaged the post (liked / boosted). Multiplier is `1 + count * perEngager`,
       * clamped to `maxBoost`.
       */
      socialProof: {
        perEngager: 0.1,
        maxBoost: 1.5,
      },
      /**
       * Lift for authors the viewer MUTUALLY engages with — an author who is both
       * a mutual follow AND in the viewer's learned `preferredAuthors` (weight ≥
       * `minAuthorWeight`).
       */
      reciprocityBoost: {
        boost: 1.2,
        /** Minimum learned author-affinity weight for the reciprocity lift to apply. */
        minAuthorWeight: 0.3,
      },
      /**
       * Lift for high-dwell posts — posts whose average impression duration meets
       * `thresholdMs`. Scales linearly from `boost` (at threshold) toward `maxBoost`
       * for longer dwell; neutral below threshold or when no dwell data exists.
       */
      dwellTime: {
        thresholdMs: 4000,
        boost: 1.15,
        maxBoost: 1.25,
      },
      /**
       * EXPLORATION lift for posts whose topics the viewer has NOT recently seen,
       * to break out of topic echo chambers. Applied when a post has at least one
       * topic and NONE of its topics are in the viewer's recent-topic set.
       */
      noveltyBoost: {
        boost: 1.15,
      },
    },
  },

  // --- Feed parameters ---
  feed: {
    candidateMultiplier: 3,
    sliceOverfetchMultiplier: 1.5,
    maxSliceSize: 3,
    defaultLimit: 30,
    maxLimit: 100,
    trendingWindowMs: 24 * 60 * 60 * 1000, // 24 hours
    /** Minimum score difference to distinguish cursor position */
    scoreEpsilon: 0.001,

    /**
     * MULTI-SOURCE candidate generation for the AUTHENTICATED For You feed.
     *
     * The old behavior ranked only the global newest-N public posts, so ranking
     * never even SAW relevant posts from followed / affinity / preferred-topic
     * authors unless they happened to be in the global-recency window. On a noisy
     * federated instance that is mostly irrelevant. Instead we gather a UNION of
     * several bounded, parallel candidate sub-queries — each consuming a
     * different personalization signal — and feed that union into the SAME
     * rank → dedup → never-blank → diversify → page → cursor pipeline.
     *
     * Every source is recency-windowed and per-source capped; the merged pool is
     * additionally bounded by `maxPool`. All caps live here — NO magic numbers in
     * the candidate-generation code.
     */
    candidateSources: {
      /**
       * Hard ceiling on the merged (deduped) candidate pool fed into ranking.
       * Bounds ranking + slicing cost regardless of how many sources contribute.
       * ~150 keeps the pool rich enough for personalization + diversity while
       * staying cheap to rank.
       */
      maxPool: 150,
      /**
       * Recency window (ms) every source draws from. A post older than this is
       * not a candidate. 3 days balances freshness against having enough
       * personalized supply on a low-volume instance.
       */
      recencyWindowMs: 3 * 24 * 60 * 60 * 1000,
      /**
       * Hard cap on how many distinct author ids any single id-set source
       * (FOLLOWING, AFFINITY) may query with. Bounds the `$in` width and keeps
       * the query index-served and predictable.
       */
      maxAuthorIds: 500,
      /** Per-source result caps (each query `.limit()`s to its cap). */
      perSource: {
        /** Recent posts from authors the viewer FOLLOWS (incl. federated + subscribed lists). */
        following: 60,
        /** Recent posts from AFFINITY authors (preferredAuthors ∪ ContentAffinityService). */
        affinity: 40,
        /** DISCOVERY: recent posts matching the viewer's preferred topics. */
        topics: 30,
        /** DISCOVERY: recent posts in the viewer's preferred language(s). */
        language: 20,
        /** DISCOVERY: recent posts in the viewer's region. */
        region: 15,
        /** DISCOVERY: recent high-engagement (trending) posts. */
        trending: 25,
        /** DISCOVERY: recent public posts (the old global behavior) — small, for serendipity. */
        global: 20,
      },
      /**
       * How many top author ids to draw from each affinity source before
       * unioning + de-duplicating them (then clamped to `maxAuthorIds`).
       */
      maxPreferredAuthors: 100,
      maxAffinityCandidates: 50,
      /**
       * How many of the viewer's preferred topic slugs / languages to query with.
       * Bounds the multikey `$in` width on the indexed discovery sources.
       */
      maxPreferredTopics: 20,
      maxPreferredLanguages: 5,
      /** Per-source query time budget (ms). */
      maxTimeMS: 4000,
    },
  },

  /** Videos (Reels) feed — metadata-backed filters (no runtime probing). */
  videosFeed: {
    /** Default minimum video duration in seconds for the ranked videos feed. */
    minDurationSec: 20,
    /** Default orientation filter — Reels surface is portrait-first. */
    defaultOrientation: 'portrait' as const,
  },

  // --- Cache TTLs (milliseconds) ---
  cache: {
    /** Per-feed-type TTLs for frontend caching */
    feedTtl: {
      for_you: 2000,
      following: 5000,
      explore: 30000,
      videos: 5000,
      media: 5000,
      saved: 10000,
      author: 10000,
      custom: 10000,
      hashtag: 15000,
      topic: 15000,
      list: 10000,
      feedgen: 5000,
      trending: 15000,
      mutuals: 5000,
      friends_popular: 10000,
      friends_of_friends: 10000,
    } as Record<string, number>,
  },

  // --- User preference learning ---
  preferences: {
    weights: {
      like: 1.0,
      boost: 2.0,
      comment: 2.5,
      save: 1.5,
      share: 1.8,
      view: 0.2,
      skip: -0.5,
      hide: -2.0,
      mute: -3.0,
      block: -5.0,
    },
    maxPreferredAuthors: 100,
    maxPreferredTopics: 200,
    /**
     * Safety ceiling on the learned `preferredRegions` multiset. Regions are a
     * small, coarse space (country/zone codes), so this is just an upper bound a
     * roaming viewer can't blow past — not an expected trim point.
     */
    maxPreferredRegions: 20,
    decayDays: 30,
    viewTimeAlpha: 0.1,
    /**
     * How long a (viewer, post) view is remembered for de-duplication, so a
     * single post counts at most one view per viewer within this window even if
     * it is impressed repeatedly (re-scroll, refresh). 24h.
     */
    viewDedupeTtlMs: 24 * 60 * 60 * 1000,
    /**
     * Dwell (visible duration) below this threshold is treated as a SKIP — the
     * viewer scrolled past without engaging — and feeds the negative `skip`
     * preference signal. At/above it the impression feeds the positive `view`
     * signal. Mirrors the frontend's MIN_VISIBLE_MS qualification (1s) but kept
     * here as the authoritative server-side classification boundary.
     */
    dwellSkipThresholdMs: 2000,
    /**
     * Hard upper bound (ms) on a single impression's client-reported dwell before
     * it is folded into a post's rolling dwell average. Client telemetry is
     * UNTRUSTED — an unbounded `durationMs` (a backgrounded tab, a forged report)
     * would otherwise dominate the average and let a caller pump a post's
     * `dwellTime` ranking signal. Clamped in `FeedInteractionTracker` before
     * `recordDwell`. 5 minutes — generous for a genuine read, small enough that a
     * forged sample cannot swamp the mean.
     */
    maxDwellMs: 5 * 60 * 1000,
    /**
     * SURFACE-AWARE attribution. An engagement's meaning depends on WHERE it
     * happened. A like on the Videos/reels surface means "I like this VIDEO
     * content" (topic + post-type), NOT "I want to follow this author" — reels
     * are consumed by topic/algorithm, rarely by author. So on video-first
     * surfaces we DAMPEN author-affinity accrual and (slightly) AMPLIFY content
     * (post-type / topic) affinity. On every other surface attribution is full
     * (factor 1.0), preserving the prior behavior.
     */
    engagementContext: {
      /**
       * Feed-descriptor tokens treated as video-first surfaces. The canonical
       * reels feed is `videos`; matched case-insensitively and also by a
       * `videos|...` / `reels...` descriptor prefix so scoped variants count.
       */
      videoSurfaces: ['videos', 'reels'] as readonly string[],
      /**
       * Multiplier applied to AUTHOR-affinity accrual for an engagement that
       * originated on a video-first surface. 0.25 = a video like counts about a
       * quarter as much toward "follow this author" as a home/for-you like.
       */
      videoSurfaceAuthorAffinityFactor: 0.25,
      /**
       * Multiplier applied to CONTENT (post-type + topic) affinity accrual for a
       * video-surface engagement. 1.3 = a video like counts a bit MORE toward
       * "I like video content / these topics", reinforcing the surface's intent.
       */
      videoSurfaceContentBoost: 1.3,
    },
  },

  // --- Protocol constants ---
  protocol: {
    version: 1,
    nsidPrefix: 'mtn.social',
  },
} as const;

export type MtnConfigType = typeof MtnConfig;

/**
 * Classify an originating feed surface (a feed-descriptor string, e.g. `videos`,
 * `for_you`, `author|<id>`, `hashtag|<tag>`) as VIDEO-FIRST.
 *
 * Matching is case-insensitive and tolerant of scoped descriptors: a descriptor
 * is video-first when its leading token (before any `|`) equals, or starts with,
 * one of {@link MtnConfig.preferences.engagementContext.videoSurfaces}. So
 * `videos`, `VIDEOS`, `videos|trending`, and `reels` all count, while
 * `for_you`, `following`, `author|x`, `hashtag|video` do NOT.
 *
 * Returns `false` for an absent/blank surface so the default (no context) path
 * keeps the prior full-attribution behavior.
 */
export function isVideoSurface(surface: string | undefined | null): boolean {
  if (!surface || typeof surface !== 'string') return false;
  const token = surface.trim().toLowerCase().split('|')[0];
  if (!token) return false;
  return MtnConfig.preferences.engagementContext.videoSurfaces.some(
    (s) => token === s || token.startsWith(s),
  );
}
