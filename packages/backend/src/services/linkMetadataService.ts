import { URL } from 'url';
import urlMetadata from 'url-metadata';
import { logger } from '../utils/logger';
import { validateUrlSecurity, sanitizeText, validateUrlLength } from '../utils/urlSecurity';
import { imageCacheService } from './imageCacheService';

export interface LinkMetadataResult {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  favicon?: string;
}

/**
 * Service to fetch link metadata (Open Graph, Twitter Cards, etc.)
 * Uses url-metadata library for reliable extraction
 */
class LinkMetadataService {
  private readonly TIMEOUT_MS = 10000; // 10 seconds

  /**
   * Fetch metadata for a URL
   */
  async fetchMetadata(url: string): Promise<LinkMetadataResult> {
    try {
      // Validate URL length (prevent DoS)
      if (!validateUrlLength(url)) {
        throw new Error('URL too long');
      }

      const normalizedUrl = this.normalizeUrl(url);
      if (!normalizedUrl) {
        throw new Error('Invalid URL');
      }

      // Security validation (prevent SSRF)
      const securityCheck = validateUrlSecurity(normalizedUrl);
      if (!securityCheck.valid) {
        logger.warn('[LinkMetadataService] Security check failed:', securityCheck.error);
        throw new Error(securityCheck.error || 'URL security validation failed');
      }

      logger.debug('[LinkMetadataService] Fetching metadata for:', normalizedUrl);

      // Use url-metadata library
      const metadata = await urlMetadata(normalizedUrl, {
        timeout: this.TIMEOUT_MS,
        requestHeaders: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });

      logger.debug('[LinkMetadataService] Extracted metadata:', {
        hasTitle: !!metadata.title,
        hasDescription: !!metadata.description,
        hasImage: !!metadata.image,
        hasSiteName: !!metadata['og:site_name'],
      });

      const result: LinkMetadataResult = {
        url: normalizedUrl,
        title: metadata.title || metadata['og:title'] || metadata['twitter:title'],
        description: metadata.description || metadata['og:description'] || metadata['twitter:description'],
        image: metadata.image || metadata['og:image'] || metadata['twitter:image'],
        siteName: metadata['og:site_name'] || this.extractSiteName(normalizedUrl),
        favicon: metadata.favicon,
      };

      // Sanitize text fields
      if (result.title) result.title = sanitizeText(result.title);
      if (result.description) result.description = sanitizeText(result.description);
      if (result.siteName) result.siteName = sanitizeText(result.siteName);

      // Resolve and cache image if URL is valid
      if (result.image && result.image.trim().length > 0) {
        try {
          // Resolve relative image URLs to absolute URLs
          const absoluteImageUrl = this.resolveImageUrl(result.image, normalizedUrl);
          
          // Check if already cached (non-blocking check)
          const cachedUrl = await imageCacheService.getCachedImage(absoluteImageUrl);
          if (cachedUrl) {
            logger.debug('[LinkMetadataService] Using cached image:', cachedUrl);
            result.image = cachedUrl;
          } else {
            // Return metadata immediately with original URL, cache image in background
            result.image = absoluteImageUrl;
            
            // Cache image asynchronously (non-blocking)
            imageCacheService.cacheImage(absoluteImageUrl).catch((error) => {
              logger.warn('[LinkMetadataService] Background image caching failed:', error);
            });
          }
        } catch (error) {
          logger.warn('[LinkMetadataService] Image URL processing failed, using original URL:', error);
          // Keep original image URL on error
        }
      }

      logger.debug('[LinkMetadataService] Final metadata:', {
        url: result.url,
        hasImage: !!result.image,
        hasTitle: !!result.title,
        hasDescription: !!result.description,
      });

      return result;
    } catch (error: any) {
      logger.error('[LinkMetadataService] Error fetching metadata:', error);
      // Return basic metadata on error instead of throwing
      try {
        const normalizedUrl = this.normalizeUrl(url) || url;
        const urlObj = new URL(normalizedUrl);
        return {
          url: normalizedUrl,
          siteName: urlObj.hostname.replace('www.', ''),
          title: urlObj.hostname,
        };
      } catch {
        return {
          url: url,
          siteName: 'Link',
          title: url,
        };
      }
    }
  }

  /**
   * Extract site name from URL
   */
  private extractSiteName(url: string): string {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.replace('www.', '');
    } catch {
      return 'Link';
    }
  }

  /**
   * Normalize URL
   */
  private normalizeUrl(url: string): string | null {
    if (!url || typeof url !== 'string') return null;
    let normalized = url.trim();
    if (!normalized) return null;

    if (!/^https?:\/\//i.test(normalized)) {
      normalized = `https://${normalized}`;
    }

    try {
      const parsed = new URL(normalized);
      return parsed.toString();
    } catch {
      return null;
    }
  }

  /**
   * Resolve relative image URLs to absolute URLs
   */
  private resolveImageUrl(imageUrl: string, baseUrl: string): string {
    if (!imageUrl || typeof imageUrl !== 'string') return imageUrl;
    
    const trimmed = imageUrl.trim();
    if (!trimmed) return imageUrl;

    // Already absolute URL
    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }

    try {
      // Resolve relative URL against base URL
      const base = new URL(baseUrl);
      
      // Protocol-relative URL (//example.com/image.jpg)
      if (trimmed.startsWith('//')) {
        return `${base.protocol}${trimmed}`;
      }
      
      // Absolute path (/image.jpg)
      if (trimmed.startsWith('/')) {
        return `${base.protocol}//${base.host}${trimmed}`;
      }
      
      // Relative path (image.jpg or ../image.jpg)
      return new URL(trimmed, baseUrl).toString();
    } catch (error) {
      logger.warn('[LinkMetadataService] Failed to resolve image URL, using original:', { imageUrl, baseUrl, error });
      return imageUrl;
    }
  }
}

export const linkMetadataService = new LinkMetadataService();
