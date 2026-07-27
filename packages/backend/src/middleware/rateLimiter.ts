import rateLimit from 'express-rate-limit';
import { RedisStore } from './rateLimitStore';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { hashedIpKey } from '../utils/ipKey';

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
    return hashedIpKey(req);
  },
});
