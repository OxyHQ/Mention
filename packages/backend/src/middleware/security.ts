import rateLimit from "express-rate-limit";
import slowDown from "express-slow-down";
import { Request, Response, NextFunction } from "express";

// Rate limiting middleware (exclude file uploads)
const rateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50000, // limit each IP to 100 requests per window
  message: "Too many requests from this IP, please try again later.",
  skip: (req: Request) => req.path.startsWith('/files/upload')
});

// Brute force protection middleware (exclude file uploads)
const bruteForceProtection: any = slowDown({
  windowMs: 15 * 60 * 1000, // 15 minutes
  delayAfter: 50000, // allow 100 requests per 15 minutes, then...
  delayMs: () => 500, // add 500ms delay per request above 100 (new behavior)
  skip: (req: Request) => req.path.startsWith('/files/upload')
});

// Rate limiter for link refresh operations (stricter limits)
// Link refresh is expensive (fetching HTML, downloading images, processing)
export const linkRefreshRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: (req: Request) => {
    // Authenticated users get higher limits (50 per hour)
    // Unauthenticated users get lower limits (20 per hour)
    const user = (req as any).user;
    return user?.id ? 50 : 20;
  },
  keyGenerator: (req: Request) => {
    // Use user ID for authenticated users, IP for unauthenticated
    const user = (req as any).user;
    return user?.id ? `link-refresh:user:${user.id}` : `link-refresh:ip:${req.ip}`;
  },
  message: "Too many link refresh requests. Please wait before refreshing more links.",
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

// Rate limiter for clearing cache (very strict - should be rare)
export const linkCacheClearRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: (req: Request) => {
    // Authenticated users get slightly higher limits (10 per hour)
    // Unauthenticated users get lower limits (5 per hour)
    const user = (req as any).user;
    return user?.id ? 10 : 5;
  },
  keyGenerator: (req: Request) => {
    // Use user ID for authenticated users, IP for unauthenticated
    const user = (req as any).user;
    return user?.id ? `link-cache-clear:user:${user.id}` : `link-cache-clear:ip:${req.ip}`;
  },
  message: "Too many cache clear requests. Please wait before clearing cache again.",
  standardHeaders: true,
  legacyHeaders: false,
});

export { rateLimiter, bruteForceProtection };
