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
const bruteForceProtection = slowDown({
  windowMs: 15 * 60 * 1000, // 15 minutes
  delayAfter: 50000, // allow 100 requests per 15 minutes, then...
  delayMs: () => 500, // add 500ms delay per request above 100 (new behavior)
  skip: (req: Request) => req.path.startsWith('/files/upload')
});

export { rateLimiter, bruteForceProtection };
