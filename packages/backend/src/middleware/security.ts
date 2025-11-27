import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import slowDown from "express-slow-down";
import { Request, Response } from "express";
import { AuthRequest } from "../types/auth";
import { RedisStore } from "./rateLimitStore";

// Create Redis store for distributed rate limiting
const redisStore = new RedisStore({ 
  prefix: 'rate-limit:api:',
  windowMs: 15 * 60 * 1000 // 15 minutes
});

// Rate limiting middleware with Redis store for distributed rate limiting
// Realistic limits for production scale
const rateLimiter = rateLimit({
  store: redisStore,
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: (req: Request) => {
    const authReq = req as AuthRequest;
    // Authenticated users: 1000 requests per 15 minutes
    // Unauthenticated users: 100 requests per 15 minutes
    return authReq.user?.id ? 1000 : 100;
  },
  keyGenerator: (req: Request) => {
    const authReq = req as AuthRequest;
    if (authReq.user?.id) {
      return `user:${authReq.user.id}`;
    }
    // Extract IP and use ipKeyGenerator helper for proper IPv6 handling
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    // ipKeyGenerator takes the IP string and properly handles IPv6 subnets
    return ipKeyGenerator(ip);
  },
  message: "Too many requests, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req: Request) => req.path.startsWith('/files/upload')
});

// Brute force protection middleware (exclude file uploads)
const bruteForceProtection: any = slowDown({
  windowMs: 15 * 60 * 1000, // 15 minutes
  delayAfter: (req: Request) => {
    const authReq = req as AuthRequest;
    return authReq.user?.id ? 1000 : 100;
  },
  delayMs: () => 500, // add 500ms delay per request above limit
  skip: (req: Request) => req.path.startsWith('/files/upload')
});

/**
 * Generate a rate limit key based on user authentication status
 * Uses user ID for authenticated users, IP address for unauthenticated users
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

export { rateLimiter, bruteForceProtection };
