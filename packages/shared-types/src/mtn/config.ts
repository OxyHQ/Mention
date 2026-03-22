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
      repostWeight: 2.5,
      commentWeight: 2.0,
      saveWeight: 1.5,
      viewWeight: 0.1,
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
    },
    diversity: {
      sameAuthorPenalty: 0.95,
      sameTopicPenalty: 0.92,
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
      repost: 2.0,
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
  },

  // --- Protocol constants ---
  protocol: {
    version: 1,
    nsidPrefix: 'mtn.social',
  },
} as const;

export type MtnConfigType = typeof MtnConfig;
