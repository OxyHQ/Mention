import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';
import { RedisStore } from './rateLimitStore';
import { logger } from '../utils/logger';
import { AuthRequest } from './auth';

/**
 * Rate limiter configuration for feed endpoints
 * Optimized for millions of users with Redis-backed distributed rate limiting
 */
const FEED_RATE_LIMIT = {
  // Authenticated users: 100 requests per minute
  authenticated: {
    max: 100,
    windowMs: 60 * 1000, // 1 minute
  },
  // Anonymous users: 30 requests per minute
  anonymous: {
    max: 30,
    windowMs: 60 * 1000, // 1 minute
  },
};

/**
 * Create rate limiter with Redis store for distributed rate limiting
 * Creates separate limiters for authenticated and anonymous users
 */
const authenticatedFeedLimiter = rateLimit({
  store: new RedisStore({ prefix: 'rate-limit:feed:auth:', windowMs: FEED_RATE_LIMIT.authenticated.windowMs }),
  windowMs: FEED_RATE_LIMIT.authenticated.windowMs,
  max: FEED_RATE_LIMIT.authenticated.max,
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  message: {
    error: 'Too Many Requests',
    message: `Rate limit exceeded. Please try again later.`,
  },
  // Custom key generator to use user ID for authenticated users
  // Use ipKeyGenerator helper for proper IPv6 handling
  keyGenerator: (req: AuthRequest) => {
    if (req.user?.id) {
      return `user:${req.user.id}`;
    }
    // Extract IP and use ipKeyGenerator helper for proper IPv6 handling
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    return ipKeyGenerator(ip);
  },
  // Custom handler for rate limit exceeded
  handler: (req: AuthRequest, res: Response) => {
    const identifier = req.user?.id || req.ip || req.socket.remoteAddress || 'unknown';
    logger.warn('Feed rate limit exceeded', {
      identifier,
      authenticated: !!req.user?.id,
    });

    res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Please try again later.`,
    });
  },
});

const anonymousFeedLimiter = rateLimit({
  store: new RedisStore({ prefix: 'rate-limit:feed:anon:', windowMs: FEED_RATE_LIMIT.anonymous.windowMs }),
  windowMs: FEED_RATE_LIMIT.anonymous.windowMs,
  max: FEED_RATE_LIMIT.anonymous.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too Many Requests',
    message: `Rate limit exceeded. Please try again later.`,
  },
  // Use ipKeyGenerator helper for proper IPv6 handling
  keyGenerator: (req: AuthRequest) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    return ipKeyGenerator(ip);
  },
  handler: (req: AuthRequest, res: Response) => {
    const identifier = req.ip || req.socket.remoteAddress || 'unknown';
    logger.warn('Feed rate limit exceeded (anonymous)', {
      identifier,
    });

    res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Please try again later.`,
    });
  },
});

/**
 * Rate limiting middleware for feed endpoints
 * Uses different limits for authenticated vs anonymous users
 */
export const feedRateLimiter = (req: AuthRequest, res: Response, next: NextFunction) => {
  const userId = req.user?.id;
  const limiter = userId ? authenticatedFeedLimiter : anonymousFeedLimiter;
  return limiter(req, res, next);
};

/**
 * General API rate limiter (for non-feed endpoints)
 * More lenient limits for general API usage
 */
export const apiRateLimiter = rateLimit({
  store: new RedisStore({ prefix: 'rate-limit:api:', windowMs: 60 * 1000 }),
  windowMs: 60 * 1000, // 1 minute
  max: 200, // 200 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too Many Requests',
    message: `Rate limit exceeded. Please try again later.`,
  },
  keyGenerator: (req: AuthRequest) => {
    if (req.user?.id) {
      return `user:${req.user.id}`;
    }
    // Extract IP and use ipKeyGenerator helper for proper IPv6 handling
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    return ipKeyGenerator(ip);
  },
});

