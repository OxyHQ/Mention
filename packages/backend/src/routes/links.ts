import express, { Response } from 'express';
import { AuthRequest } from '../types/auth';
import { linkMetadataService } from '../services/linkMetadataService';
import { logger } from '../utils/logger';
import { validateUrlSecurity } from '../utils/urlSecurity';

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
      logger.error('[Links] Error in fetchMetadata, returning basic metadata:', error);
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
    logger.error('[Links] Error fetching metadata:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch link metadata',
      error: error?.message || 'Unknown error',
    });
  }
});

export default router;

