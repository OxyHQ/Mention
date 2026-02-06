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
    maxBufferSize: 1e8,
    compressionThreshold: 1024,
  },
  db: {
    socketTimeoutMS: 45000,
    serverSelectionTimeoutMS: 20000,
    maxRetries: 5,
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
    maxEventNameLength: 200,
    maxEventLocationLength: 200,
    maxEventDescriptionLength: 500,
    defaultPageSize: 20,
    maxPageSize: 100,
    defaultNearbyRadiusMeters: 10000,
    maxNearbyPosts: 50,
    maxAreaPosts: 100,
    defaultLikesLimit: 50,
  },
} as const;

// Validate critical environment variables at startup
export function validateEnvironment(): void {
  const required = ['MONGODB_URI'];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    logger.warn(`Missing environment variables: ${missing.join(', ')}. Some features may not work.`);
  }

  // JWT_SECRET is critical for authentication security
  const hasJwtSecret = process.env.JWT_SECRET || process.env.OXY_JWT_SECRET;
  if (!hasJwtSecret) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('FATAL: JWT_SECRET or OXY_JWT_SECRET must be set in production. Exiting.');
      process.exit(1);
    } else {
      logger.warn('JWT_SECRET not set - socket token authentication will be unavailable');
    }
  }

  if (process.env.NODE_ENV === 'production') {
    if (!process.env.FRONTEND_URL) {
      logger.warn('FRONTEND_URL not set in production - CORS may be restrictive');
    }
  }
}
