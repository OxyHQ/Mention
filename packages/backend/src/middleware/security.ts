import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import slowDown from "express-slow-down";
import type { RequestHandler } from "express";
import { Request, Response } from "express";
import { AuthRequest } from "../types/auth";
import { RedisStore } from "./rateLimitStore";

// Realistic thresholds for global slow-down. The shared global rate limiter is
// owned by @oxyhq/core/server; this file only contains app-specific throttles.
const AUTHENTICATED_LIMIT_PER_WINDOW = 5000; // per 15 min
const UNAUTHENTICATED_LIMIT_PER_WINDOW = 600; // per 15 min

/**
 * Generate a rate limit key based on user authentication status.
 * Uses user ID for authenticated users, IP address for unauthenticated users.
 *
 * Per-user keying is essential behind the ALB: many users egress through a
 * small pool of proxy IPs, so IP-only keying would force unrelated users to
 * share a single bucket and trip 429s. `optionalAuth` runs globally before the
 * limiter (see server.ts), so `req.user.id` is populated by the time this runs.
 */
function generateRateLimitKey(req: Request, prefix: string): string {
  const authReq = req as AuthRequest;
  if (authReq.user?.id) {
    return `${prefix}:user:${authReq.user.id}`;
  }
  // Extract IP and use ipKeyGenerator helper for proper IPv6 handling
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  // ipKeyGenerator takes the IP string and properly handles IPv6 subnets
  const ipKey = ipKeyGenerator(ip);
  return `${prefix}:${ipKey}`;
}

/**
 * Get rate limit max value based on authentication status
 */
function getRateLimitMax(req: Request, authenticatedLimit: number, unauthenticatedLimit: number): number {
  const authReq = req as AuthRequest;
  return authReq.user?.id ? authenticatedLimit : unauthenticatedLimit;
}

/**
 * Shared predicate for requests that must never be slowed down.
 *
 * Exemptions:
 *  - OPTIONS preflight: CORS checks must always succeed instantly.
 *  - File uploads: large multipart bodies are inherently low-frequency and
 *    counting them against the API budget breaks media posting.
 *  - Image proxy / optimization ('/images/'): a single feed render pulls many
 *    images through our origin; these must not consume the API budget.
 *  - Media streaming / proxy ('/media/'): range-seeking generates many
 *    sub-requests per asset that should not count as API calls.
 *  - Health / liveness probes ('/health'): load balancer + ECS probes hit this
 *    constantly and must never be throttled.
 */
function isRateLimitExempt(req: Request): boolean {
  if (req.method === 'OPTIONS') {
    return true;
  }
  const path = req.path;
  return (
    path.startsWith('/files/upload') ||
    path.includes('/images/') ||
    path.includes('/media/') ||
    path.startsWith('/health')
  );
}

// Brute force protection middleware. Mirrors the rate limiter's auth-aware
// threshold and shares the same exemption predicate.
const bruteForceProtection: RequestHandler = slowDown({
  windowMs: 15 * 60 * 1000, // 15 minutes
  delayAfter: (req: Request) => getRateLimitMax(req, AUTHENTICATED_LIMIT_PER_WINDOW, UNAUTHENTICATED_LIMIT_PER_WINDOW),
  delayMs: () => 500, // add 500ms delay per request above limit
  // Key per-user (fallback to IP) for the same reason as the rate limiter:
  // shared ALB IPs must not lump distinct authenticated users together.
  keyGenerator: (req: Request) => generateRateLimitKey(req, 'brute-force'),
  skip: isRateLimitExempt,
});

// Rate limiter for link refresh operations (stricter limits)
// Link refresh is expensive (fetching HTML, downloading images, processing)
const linkRefreshStore = new RedisStore({ 
  prefix: 'rate-limit:link-refresh:',
  windowMs: 60 * 60 * 1000 // 1 hour
});
export const linkRefreshRateLimiter = rateLimit({
  store: linkRefreshStore,
  windowMs: 60 * 60 * 1000, // 1 hour
  max: (req: Request) => getRateLimitMax(req, 50, 20),
  keyGenerator: (req: Request) => generateRateLimitKey(req, 'link-refresh'),
  message: "Too many link refresh requests. Please wait before refreshing more links.",
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for clearing cache (very strict - should be rare)
const linkCacheClearStore = new RedisStore({ 
  prefix: 'rate-limit:link-cache-clear:',
  windowMs: 60 * 60 * 1000 // 1 hour
});
export const linkCacheClearRateLimiter = rateLimit({
  store: linkCacheClearStore,
  windowMs: 60 * 60 * 1000, // 1 hour
  max: (req: Request) => getRateLimitMax(req, 10, 5),
  keyGenerator: (req: Request) => generateRateLimitKey(req, 'link-cache-clear'),
  message: "Too many cache clear requests. Please wait before clearing cache again.",
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for feed endpoints (per user: 100 requests/minute)
const feedStore = new RedisStore({ 
  prefix: 'rate-limit:feed:',
  windowMs: 60 * 1000 // 1 minute
});
export const feedRateLimiter = rateLimit({
  store: feedStore,
  windowMs: 60 * 1000, // 1 minute
  max: (req: Request) => {
    const authReq = req as AuthRequest;
    // Authenticated users: 100 requests per minute
    // Unauthenticated users: 50 requests per minute
    return authReq.user?.id ? 100 : 50;
  },
  keyGenerator: (req: Request) => {
    const authReq = req as AuthRequest;
    if (authReq.user?.id) {
      return `user:${authReq.user.id}`;
    }
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    return ipKeyGenerator(ip);
  },
  message: "Too many feed requests. Please slow down.",
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for feed endpoints (per IP: 10 requests/second)
const feedIPStore = new RedisStore({ 
  prefix: 'rate-limit:feed-ip:',
  windowMs: 1000 // 1 second
});
export const feedIPRateLimiter = rateLimit({
  store: feedIPStore,
  windowMs: 1000, // 1 second
  max: 10, // 10 requests per second per IP
  keyGenerator: (req: Request) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    return ipKeyGenerator(ip);
  },
  message: "Too many requests from this IP. Please slow down.",
  standardHeaders: true,
  legacyHeaders: false,
});

// Request throttling for expensive feed operations (For You feed with ranking)
const feedThrottleStore = new RedisStore({ 
  prefix: 'rate-limit:feed-throttle:',
  windowMs: 60 * 1000 // 1 minute
});
export const feedThrottle: RequestHandler = slowDown({
  store: feedThrottleStore,
  windowMs: 60 * 1000, // 1 minute
  delayAfter: (req: Request) => {
    // Throttle expensive operations (For You feed, Explore feed)
    const feedType = (req.query.type as string) || '';
    if (feedType === 'for_you' || feedType === 'explore') {
      const authReq = req as AuthRequest;
      return authReq.user?.id ? 20 : 10; // Lower limit for expensive operations
    }
    return 100; // Higher limit for simple operations
  },
  delayMs: () => 1000, // Add 1 second delay per request above limit
  keyGenerator: (req: Request) => {
    const authReq = req as AuthRequest;
    const feedType = (req.query.type as string) || 'mixed';
    if (authReq.user?.id) {
      return `user:${authReq.user.id}:${feedType}`;
    }
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    return `${ipKeyGenerator(ip)}:${feedType}`;
  },
  skip: (req: Request) => {
    // Don't throttle simple feed types
    const feedType = (req.query.type as string) || '';
    return !['for_you', 'explore'].includes(feedType);
  }
});

export { bruteForceProtection };
