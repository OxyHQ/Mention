import express, { Response } from 'express';
import { AuthRequest } from '../types/auth';
import { linkMetadataService } from '../services/linkMetadataService';
import { logger } from '../utils/logger';
import { validateUrlSecurity } from '../utils/urlSecurity';
import { imageCacheService } from '../services/imageCacheService';
import { requireAuth } from '../middleware/auth';
import { linkRefreshRateLimiter, linkCacheClearRateLimiter } from '../middleware/security';

const router = express.Router();

/**
 * GET /api/links/metadata
 * Fetch metadata for a URL (Open Graph, Twitter Cards, etc.)
 * Query params: url (required)
 */
router.get('/metadata', async (req: AuthRequest, res: Response) => {
  try {
    const { url } = req.query;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'URL parameter is required',
      });
    }

    // Validate URL format
    let urlObj: URL;
    try {
      urlObj = new URL(url);
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
      logger.warn('[Links] Security check failed:', { url, error: securityCheck.error });
      return res.status(400).json({
        success: false,
        message: securityCheck.error || 'URL security validation failed',
      });
    }

    try {
      const metadata = await linkMetadataService.fetchMetadata(url);
      res.json({
        success: true,
        ...metadata,
      });
    } catch (error: any) {
      // Even if fetch fails, return basic metadata
      logger.error('[Links] Error in fetchMetadata, returning basic metadata:', { userId: req.user?.id, url: req.query.url, error });
      try {
        const urlObj = new URL(url);
        res.json({
          success: true,
          url: url,
          siteName: urlObj.hostname.replace('www.', ''),
          title: urlObj.hostname,
        });
      } catch {
        res.json({
          success: true,
          url: url,
          siteName: 'Link',
          title: url,
        });
      }
    }
  } catch (error: any) {
    logger.error('[Links] Error fetching metadata:', { userId: req.user?.id, url: req.query.url, error });
    res.status(500).json({
      success: false,
      message: 'Failed to fetch link metadata',
      error: error?.message || 'Unknown error',
    });
  }
});

/**
 * OPTIONS /api/links/images/:cacheKey
 * Handle CORS preflight for image requests
 */
router.options('/images/:cacheKey', (req: AuthRequest, res: Response) => {
  const origin = req.headers.origin;
  const ALLOWED_ORIGINS = [
    process.env.FRONTEND_URL || 'https://mention.earth',
    'http://localhost:8081',
    'http://localhost:8082',
    'http://192.168.86.44:8081',
  ];
  
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
  res.status(204).end();
});

/**
 * POST /api/links/clear-cache
 * Clear all cached link metadata and images (requires authentication)
 * Rate limited: 5 requests per hour per IP
 */
router.post('/clear-cache', linkCacheClearRateLimiter, requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    // Clear all cached images from GridFS
    const clearedImages = await imageCacheService.clearAllImages();
    
    logger.info('[Links] Cache cleared:', { 
      userId: req.user?.id,
      clearedImages 
    });

    res.json({
      success: true,
      message: 'Link cache cleared successfully',
      clearedImages,
    });
  } catch (error: any) {
    logger.error('[Links] Error clearing cache:', { userId: req.user?.id, error });
    res.status(500).json({
      success: false,
      message: 'Failed to clear cache',
      error: error?.message || 'Unknown error',
    });
  }
});

/**
 * POST /api/links/refresh
 * Force refresh metadata and image for a specific URL (requires authentication)
 * Rate limited: 20 requests per hour per IP (or 50 per hour for authenticated users)
 */
router.post('/refresh', linkRefreshRateLimiter, requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'URL is required',
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

    // Security validation
    const securityCheck = validateUrlSecurity(url);
    if (!securityCheck.valid) {
      return res.status(400).json({
        success: false,
        message: securityCheck.error || 'URL security validation failed',
      });
    }

    // Clear cached image for this URL if it exists
    const cacheKey = imageCacheService.generateCacheKey(url);
    await imageCacheService.deleteImage(cacheKey);

    // Force fetch fresh metadata (this will also cache the image)
    const metadata = await linkMetadataService.fetchMetadata(url);

    logger.info('[Links] Link refreshed:', { 
      userId: req.user?.id,
      url,
      hasImage: !!metadata.image 
    });

    res.json({
      success: true,
      message: 'Link refreshed successfully',
      ...metadata,
    });
  } catch (error: any) {
    logger.error('[Links] Error refreshing link:', { userId: req.user?.id, url: req.body.url, error });
    res.status(500).json({
      success: false,
      message: 'Failed to refresh link',
      error: error?.message || 'Unknown error',
    });
  }
});

/**
 * GET /api/links/images/:cacheKey
 * Serve cached link preview images
 */
router.get('/images/:cacheKey', async (req: AuthRequest, res: Response) => {
  try {
    const { cacheKey } = req.params;

    if (!cacheKey || typeof cacheKey !== 'string' || cacheKey.length !== 64) {
      return res.status(400).json({
        success: false,
        message: 'Invalid cache key',
      });
    }

    // Validate cache key format (should be hex string)
    if (!/^[a-f0-9]{64}$/i.test(cacheKey)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid cache key format',
      });
    }

    const imageData = await imageCacheService.getImageStream(cacheKey);
    
    if (!imageData) {
      return res.status(404).json({
        success: false,
        message: 'Image not found in cache',
      });
    }

    // Set CORS headers to allow image loading from frontend (match server.ts config)
    const origin = req.headers.origin;
    const ALLOWED_ORIGINS = [
      process.env.FRONTEND_URL || 'https://mention.earth',
      'http://localhost:8081',
      'http://localhost:8082',
      'http://192.168.86.44:8081',
    ];
    
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Type, Content-Length');

    // Set appropriate headers
    res.setHeader('Content-Type', imageData.contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // Cache for 1 year
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); // Allow cross-origin access

    // Stream the image
    imageData.stream.pipe(res);
  } catch (error: any) {
    logger.error('[Links] Error serving cached image:', { cacheKey: req.params.cacheKey, error });
    res.status(500).json({
      success: false,
      message: 'Failed to serve image',
    });
  }
});

export default router;

