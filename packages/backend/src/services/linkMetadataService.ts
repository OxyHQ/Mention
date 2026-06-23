import { URL } from 'url';
import urlMetadata from 'url-metadata';
import { logger } from '../utils/logger';
import { validateUrlSecurity, validateUrlLength, decodeHtmlEntities } from '../utils/urlSecurity';
import { imageCacheService } from './imageCacheService';

export interface LinkMetadataResult {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  favicon?: string;
}

export interface FetchMetadataOptions {
  /**
   * When true, on an image cache MISS the call AWAITS the downscaled S3/CDN
   * result and returns THAT url as `result.image` (so the persisted preview
   * serves the optimized image, not the raw full-res og:image). When false
   * (default), the raw absolute og:image url is returned immediately and the
   * downscale runs fire-and-forget — correct for response-path callers that
   * must stay fast. Only callers that already run OFF the response path (e.g.
   * background preview warming, an explicit user-triggered refresh) should set
   * this to true.
   */
  awaitImageCache?: boolean;
}

/** Default for {@link FetchMetadataOptions.awaitImageCache} (response-path safe). */
const DEFAULT_AWAIT_IMAGE_CACHE = false;

/**
 * Service to fetch link metadata (Open Graph, Twitter Cards, etc.)
 * Uses url-metadata library for reliable extraction
 */
class LinkMetadataService {
  // Tight timeout for the remote page fetch. This now runs exclusively OFF the
  // feed response path (background preview warming in PostHydrationService), so
  // a slow host can never gate a feed render — but a tight bound still prevents
  // background warm tasks from piling up on cold/unreachable hosts.
  private readonly TIMEOUT_MS = Number(process.env.LINK_METADATA_TIMEOUT_MS ?? 6000);

  /**
   * Fetch metadata for a URL.
   *
   * @param url    The page URL to extract Open Graph / Twitter Card metadata from.
   * @param options See {@link FetchMetadataOptions}. By default the image is
   *   resolved on the response-path-safe fast path (raw url + fire-and-forget
   *   downscale). Off-response-path callers can set `awaitImageCache` to persist
   *   the downscaled CDN image instead.
   */
  async fetchMetadata(url: string, options?: FetchMetadataOptions): Promise<LinkMetadataResult> {
    const awaitImageCache = options?.awaitImageCache ?? DEFAULT_AWAIT_IMAGE_CACHE;
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

      // Decode HTML entities in text fields (these are rendered as text, not HTML)
      if (result.title) result.title = decodeHtmlEntities(result.title);
      if (result.description) result.description = decodeHtmlEntities(result.description);
      if (result.siteName) result.siteName = decodeHtmlEntities(result.siteName);

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
          } else if (awaitImageCache) {
            // Off-response-path caller: AWAIT the downscale so the persisted
            // preview serves the optimized CDN image, not the raw og:image.
            const downscaledUrl = await imageCacheService.cacheImage(absoluteImageUrl);
            if (downscaledUrl && downscaledUrl.length > 0) {
              result.image = downscaledUrl;
            } else {
              // Caching failed — fall back to the raw url (still renderable).
              logger.warn('[LinkMetadataService] Awaited image caching returned no url; using original:', {
                image: absoluteImageUrl,
              });
              result.image = absoluteImageUrl;
            }
          } else {
            // Response-path caller: return metadata immediately with the original
            // URL and downscale the image in the background (fire-and-forget).
            result.image = absoluteImageUrl;

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
