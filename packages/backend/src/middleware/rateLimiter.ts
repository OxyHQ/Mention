import rateLimit from 'express-rate-limit';
import { RedisStore } from './rateLimitStore';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { hashedIpKey } from '../utils/ipKey';

/**
 * General API rate limiter for non-feed endpoints: a per-MINUTE burst bound,
 * mounted per router (`notifications.ts`), layered on top of the app-wide
 * sustained budget that `createOxyRateLimit` enforces from `runtimeApp.ts`.
 *
 * The prefix is `rate-limit:api-burst:`, NOT `rate-limit:api:`, and the
 * distinction is load-bearing rather than cosmetic. This limiter keys
 * authenticated callers as `user:<id>`, and so does the app-wide one — core's
 * `resolveTrustedAuthenticatedKey` builds the identical string. Sharing a prefix
 * therefore meant sharing a Redis KEY, and `rateLimitStore`'s Lua only sets a
 * TTL when it creates the key, so whichever limiter arrived first decided the
 * window for both. The app-wide limiter is mounted before route composition and
 * always arrives first, so this one silently inherited a 15-minute TTL and
 * counted every unrelated API request the caller made — a 200/minute bound
 * behaving as roughly 200 per quarter hour, shared with all other traffic.
 *
 * It never threw `ERR_ERL_DOUBLE_COUNT`: the two are independent `RedisStore`
 * instances rather than one shared client, so express-rate-limit's own
 * double-count detection could not see across them. Uniqueness is enforced by
 * `__tests__/middleware/rateLimitPrefixUniqueness.test.ts` instead.
 */
export const apiRateLimiter = rateLimit({
  store: new RedisStore({ prefix: 'rate-limit:api-burst:', windowMs: 60 * 1000 }),
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
