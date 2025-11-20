import rateLimit from "express-rate-limit";
import slowDown from "express-slow-down";
import { Request, Response } from "express";
import { AuthRequest } from "../types/auth";

// Rate limiting middleware (exclude file uploads)
const rateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50000, // limit each IP to 50000 requests per window
  message: "Too many requests from this IP, please try again later.",
  skip: (req: Request) => req.path.startsWith('/files/upload')
});

// Brute force protection middleware (exclude file uploads)
const bruteForceProtection: any = slowDown({
  windowMs: 15 * 60 * 1000, // 15 minutes
  delayAfter: 50000, // allow 50000 requests per 15 minutes, then...
  delayMs: () => 500, // add 500ms delay per request above limit (new behavior)
  skip: (req: Request) => req.path.startsWith('/files/upload')
});

/**
 * Generate a rate limit key based on user authentication status
 * Uses user ID for authenticated users, IP address for unauthenticated users
 */
function generateRateLimitKey(req: Request, res: Response, prefix: string): string {
  const authReq = req as AuthRequest;
  if (authReq.user?.id) {
    return `${prefix}:user:${authReq.user.id}`;
  }
  // Extract IP address with fallback for proper handling
  // Express sets req.ip when trust proxy is configured, otherwise use socket address
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  return `${prefix}:ip:${ip}`;
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
export const linkRefreshRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: (req: Request) => getRateLimitMax(req, 50, 20),
  keyGenerator: (req: Request, res: Response) => generateRateLimitKey(req, res, 'link-refresh'),
  message: "Too many link refresh requests. Please wait before refreshing more links.",
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

// Rate limiter for clearing cache (very strict - should be rare)
export const linkCacheClearRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: (req: Request) => getRateLimitMax(req, 10, 5),
  keyGenerator: (req: Request, res: Response) => generateRateLimitKey(req, res, 'link-cache-clear'),
  message: "Too many cache clear requests. Please wait before clearing cache again.",
  standardHeaders: true,
  legacyHeaders: false,
});

export { rateLimiter, bruteForceProtection };
