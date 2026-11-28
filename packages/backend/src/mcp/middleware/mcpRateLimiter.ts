import type { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { RedisStore } from '../../middleware/rateLimitStore';
import { hashedIpKey } from '../../utils/ipKey';
import { bearerLooksLikeMcpToken } from './mcpAuth';

const MCP_TOKEN_WINDOW_MS = 15 * 60 * 1000;

/**
 * The app-wide budget for a request carrying an MCP bearer: the anonymous
 * per-IP budget it was always charged, without the session resolution.
 */
const mcpTokenRateLimiter = rateLimit({
  store: new RedisStore({ prefix: 'rate-limit:mcp-token:', windowMs: MCP_TOKEN_WINDOW_MS }),
  windowMs: MCP_TOKEN_WINDOW_MS,
  max: 600,
  keyGenerator: hashedIpKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too Many Requests',
    message: 'Rate limit exceeded. Please try again later.',
  },
});

/**
 * Route the app-wide rate limit by bearer kind. Oxy's limiter resolves the
 * caller as an Oxy session to key its bucket, and an MCP bearer is not one: it
 * was refused there on every request (`INVALID_TOKEN_PAYLOAD`, a warning each)
 * before the MCP middleware authenticated it. So an MCP bearer never reaches
 * the session resolver; it is budgeted per IP, as it already was.
 */
export function routeRateLimitByBearer(sessionRateLimiter: RequestHandler): RequestHandler {
  return (req, res, next) =>
    bearerLooksLikeMcpToken(req)
      ? mcpTokenRateLimiter(req, res, next)
      : sessionRateLimiter(req, res, next);
}
