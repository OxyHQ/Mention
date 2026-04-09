import { logger } from '../utils/logger';

/**
 * Centralized configuration with environment variable validation.
 * All magic numbers and timeouts are defined here.
 */
export const config = {
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
