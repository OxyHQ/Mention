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
  },

  // --- Cache TTLs (milliseconds) ---
  cache: {
    l1: {
      ttlMs: 60 * 1000, // 1 minute
      maxEntries: 1000,
      evictionPercent: 0.1,
    },
    l2: {
      ttlMs: 15 * 60 * 1000, // 15 minutes
    },
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
