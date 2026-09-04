import type { Request } from 'express';
import rateLimit from 'express-rate-limit';
import { RedisStore } from '../middleware/rateLimitStore';
import { hashedIpKey } from '../utils/ipKey';

const CAPABILITY_AUTH_WINDOW_MS = 60_000;

/**
 * Bound signed-capability verification and live introspection before either
 * operation can spend CPU or call Oxy. Ordinary user and anonymous requests
 * skip this lane and keep their existing API budgets.
 */
export const mentionCapabilityRateLimiter = rateLimit({
  store: new RedisStore({
    prefix: 'rate-limit:mention-capability-auth:',
    windowMs: CAPABILITY_AUTH_WINDOW_MS,
  }),
  windowMs: CAPABILITY_AUTH_WINDOW_MS,
  max: 120,
  skip: (request: Request) => !request.header('authorization')?.toLowerCase().startsWith('capability '),
  keyGenerator: (request: Request) => hashedIpKey(request),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too Many Requests',
    message: 'Capability authorization rate limit exceeded. Please try again later.',
  },
});
