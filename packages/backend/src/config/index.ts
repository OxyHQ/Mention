import { logger } from '../utils/logger';

/**
 * Centralized configuration with environment variable validation.
 * All magic numbers and timeouts are defined here.
 */
export const config = {
  /**
   * The backend's own public origin (no trailing slash). Used to build FINAL,
   * self-hosted media URLs (e.g. `/media/proxy`, `/media/poster`) that the
   * frontend renders directly.
   *
   * No existing config points at the backend's public origin: `FEDERATION_DOMAIN`
   * is the FRONTEND apex (`mention.earth`) and `OXY_API_URL` is the Oxy API
   * origin — so this is a dedicated variable. MUST be set to
   * `https://api.mention.earth` on the ECS task; otherwise prod would emit
   * localhost proxy URLs.
   */
  publicApiUrl: (process.env.MENTION_PUBLIC_API_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  cache: {
    userTTL: parseInt(process.env.CACHE_USER_TTL || '300', 10),        // 5 min
    postTTL: parseInt(process.env.CACHE_POST_TTL || '120', 10),        // 2 min
    feedTTL: parseInt(process.env.CACHE_FEED_TTL || '900', 10),        // 15 min
    followTTL: parseInt(process.env.CACHE_FOLLOW_TTL || '600', 10),    // 10 min
    l1MaxEntries: 1000,
    l1TTL: 60,  // 1 min in-memory
  },
  rateLimit: {
    authenticated: { max: 1000, windowMs: 15 * 60 * 1000 },
    unauthenticated: { max: 100, windowMs: 15 * 60 * 1000 },
  },
  socket: {
    pingTimeout: 60000,
    pingInterval: 20000,
    upgradeTimeout: 30000,
    connectTimeout: 45000,
    maxBufferSize: 1e6, // 1MB - prevents DoS via oversized socket payloads
    compressionThreshold: 1024,
  },
  db: {
    socketTimeoutMS: parseInt(process.env.MONGODB_SOCKET_TIMEOUT_MS || '45000', 10),
    serverSelectionTimeoutMS: parseInt(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || '20000', 10),
    maxRetries: parseInt(process.env.MONGODB_MAX_RETRIES || '5', 10),
    maxPoolSize: parseInt(process.env.MONGODB_MAX_POOL_SIZE || '100', 10),
    minPoolSize: parseInt(process.env.MONGODB_MIN_POOL_SIZE || '10', 10),
    maxIdleTimeMS: parseInt(process.env.MONGODB_MAX_IDLE_TIME_MS || '60000', 10),
    heartbeatFrequencyMS: parseInt(process.env.MONGODB_HEARTBEAT_FREQUENCY_MS || '10000', 10),
  },
  feed: {
    defaultLimit: 20,
    maxLimit: 100,
    queryTimeoutMs: 15000,
    slowQueryThresholdMs: 100,
    rankedCandidateMultiplier: 2,
    scoreEpsilon: 0.001,
  },
  posts: {
    maxSources: 5,
    maxSourceTitleLength: 200,
    maxArticleTitleLength: 280,
    maxArticleExcerptLength: 280,
    defaultPollDurationDays: 7,
    maxPollDurationDays: 30,
    maxEventNameLength: 200,
    maxEventLocationLength: 200,
    maxEventDescriptionLength: 500,
    defaultPageSize: 20,
    maxPageSize: 100,
    defaultNearbyRadiusMeters: 10000,
    maxNearbyPosts: 50,
    maxAreaPosts: 100,
    defaultLikesLimit: 50,
    maxHashtagLength: 100,
    maxHashtagsPerPost: 30,
    maxTextLength: 25000, // Maximum post text length (characters)
    maxAltTextLength: 2000, // Maximum per-image accessibility (alt) text length (characters)
  },
  search: {
    maxDateRangeDays: 365,
  },
  alia: {
    apiUrl: process.env.ALIA_API_URL || 'https://api.alia.onl',
    apiKey: process.env.ALIA_API_KEY || '',
    model: 'alia-v1',
    timeoutMs: 30_000,
  },
  /**
   * Syra public catalog API. Used to verify + denormalize a user's pinned
   * "profile media" (a song or podcast show) server-side (via `@syra.fm/sdk`)
   * and to proxy catalog search for the media picker. Public reads only — no auth.
   */
  syra: {
    apiUrl: (process.env.SYRA_API_URL || 'https://api.syra.fm').replace(/\/+$/, ''),
  },
  /**
   * AI-powered post classification (topics, sentiment, intent, quality/safety
   * signals). Provider/model selection lives INSIDE Alia (the Oxy multi-provider
   * AI gateway) — never stored on the post. Disabled by default; the service
   * also no-ops when Alia itself is not configured.
   */
  classification: {
    enabled: process.env.POST_CLASSIFICATION_ENABLED === 'true',
  },
  /**
   * Cross-instance metrics aggregation (see `services/metricsAggregator.ts`).
   * Counters are accumulated in memory on the hot path and pushed to Redis on a
   * timer, so `/metrics` can serve a fleet-wide total instead of one task's
   * fragment.
   */
  metrics: {
    /** How often each task pushes its accumulated counter deltas to Redis. */
    flushIntervalMs: parseInt(process.env.METRICS_FLUSH_INTERVAL_MS || '10000', 10), // 10s
    /**
     * Expiry on the Redis counter keys, REFRESHED on every flush. It never expires
     * a live metric — it only reclaims keys for metrics no task emits any more.
     */
    redisKeyTtlSeconds: parseInt(process.env.METRICS_REDIS_KEY_TTL_SECONDS || '2592000', 10), // 30 days
  },
} as const;

// Validate critical environment variables at startup
export function validateEnvironment(): void {
  const required = ['MONGODB_URI'];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    logger.warn(`Missing environment variables: ${missing.join(', ')}. Some features may not work.`);
  }

  if (!process.env.ALIA_API_KEY) {
    logger.warn('ALIA_API_KEY not set — AI features (topic extraction, translation, summaries) will be disabled');
  }

  if (process.env.NODE_ENV === 'production') {
    if (!process.env.FRONTEND_URL) {
      logger.warn('FRONTEND_URL not set in production - CORS may be restrictive');
    }
  }
}
