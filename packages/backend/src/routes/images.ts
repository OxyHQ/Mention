import express, { Response } from 'express';
import { AuthRequest } from '../types/auth';
import { logger } from '../utils/logger';
import { validateUrlSecurity } from '../utils/urlSecurity';
import { imageCacheService } from '../services/imageCacheService';
import rateLimit from 'express-rate-limit';
import { RedisStore } from '../middleware/rateLimitStore';
import { getAllowedOrigins } from '../utils/allowedOrigins';

const router = express.Router();

// Rate limiter for image optimization (generous but protective)
const imageOptimizeStore = new RedisStore({
  prefix: 'rate-limit:image-optimize:',
  windowMs: 60 * 1000, // 1 minute
});
const imageOptimizeRateLimiter = rateLimit({
  store: imageOptimizeStore,
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute per IP
  message: 'Too many image optimization requests. Please wait.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Allowed size constraints (prevent abuse with extreme dimensions)
const MAX_ALLOWED_WIDTH = 2000;
const MAX_ALLOWED_HEIGHT = 2000;
const MIN_ALLOWED_DIMENSION = 16;
const DEFAULT_QUALITY = 80;
const MIN_QUALITY = 10;
const MAX_QUALITY = 100;

/**
 * GET /api/images/optimize
 *
 * @deprecated Superseded by server-authoritative media URLs: API responses now
 * emit FINAL, ready-to-render URLs via the shared media resolver
 * (`utils/mediaResolver.ts`), so clients no longer need to optimize images
 * themselves. Retained only for older clients that still call this endpoint;
 * do not add new callers.
 *
 * Optimize and cache an external image with custom dimensions.
 * Query params:
 *   url (required) - The image URL to optimize
 *   w (optional) - Max width in pixels (default: 600, max: 2000)
 *   h (optional) - Max height in pixels (default: 600, max: 2000)
 *   q (optional) - Quality 10-100 (default: 80)
 */
router.get('/optimize', imageOptimizeRateLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const { url, w, h, q } = req.query;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'URL parameter is required',
      });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return res.status(400).json({
        success: false,
        message: 'Invalid URL format',
      });
    }

    // Validate URL length (DoS protection)
    if (url.length > 2048) {
      return res.status(400).json({
        success: false,
        message: 'URL too long',
      });
    }

    // Security validation (SSRF protection)
    const securityCheck = validateUrlSecurity(url);
    if (!securityCheck.valid) {
      logger.warn('[Images] Security check failed:', { url, error: securityCheck.error });
      return res.status(400).json({
        success: false,
        message: securityCheck.error || 'URL security validation failed',
      });
    }

    // Parse and validate dimensions
    const maxWidth = w ? Math.min(Math.max(Number(w) || 600, MIN_ALLOWED_DIMENSION), MAX_ALLOWED_WIDTH) : 600;
    const maxHeight = h ? Math.min(Math.max(Number(h) || 600, MIN_ALLOWED_DIMENSION), MAX_ALLOWED_HEIGHT) : 600;
    const quality = q ? Math.min(Math.max(Number(q) || DEFAULT_QUALITY, MIN_QUALITY), MAX_QUALITY) : DEFAULT_QUALITY;

    // Cache and optimize the image
    const result = await imageCacheService.cacheOptimizedImage(url, {
      maxWidth,
      maxHeight,
      quality,
    });

    if (!result) {
      return res.status(502).json({
        success: false,
        message: 'Failed to optimize image',
      });
    }

    // Images are now stored in S3 and served via CDN — redirect to CDN URL
    const { getCdnUrl } = require('../utils/spaces.js');
    const cdnUrl = getCdnUrl(`link-previews/${result.cacheKey}`);
    return res.redirect(301, cdnUrl);
  } catch (error) {
    logger.error('[Images] Error optimizing image:', { url: req.query.url, error });
    res.status(500).json({
      success: false,
      message: 'Failed to optimize image',
    });
  }
});

/**
 * OPTIONS /api/images/optimize
 * Handle CORS preflight
 */
router.options('/optimize', (req: AuthRequest, res: Response) => {
  const origin = req.headers.origin;

  if (origin && getAllowedOrigins().includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(204).end();
});

export default router;
