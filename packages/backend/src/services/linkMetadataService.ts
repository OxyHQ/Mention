import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { logger } from '../utils/logger';
import { validateUrlSecurity, sanitizeHtml, sanitizeText, validateUrlLength } from '../utils/urlSecurity';
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
 * Fetches HTML and parses meta tags
 */
class LinkMetadataService {
  private readonly TIMEOUT_MS = 10000; // 10 seconds
  private readonly MAX_REDIRECTS = 5;
  private readonly USER_AGENT = 'MentionBot/1.0 (+https://mention.earth)';

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

      const html = await this.fetchHtml(normalizedUrl);
      if (!html || html.length === 0) {
        // Return basic metadata if HTML fetch fails
        try {
          const urlObj = new URL(normalizedUrl);
          return {
            url: normalizedUrl,
            siteName: urlObj.hostname.replace('www.', ''),
            title: urlObj.hostname,
          };
        } catch {
          return {
            url: normalizedUrl,
            siteName: 'Link',
            title: normalizedUrl,
          };
        }
      }

      // Sanitize HTML before parsing (XSS protection)
      const sanitizedHtml = sanitizeHtml(html);
      return await this.parseMetadata(sanitizedHtml, normalizedUrl);
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
   * Fetch HTML content from URL
   */
  private async fetchHtml(url: string, redirectCount: number = 0): Promise<string> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === 'https:';
      const client = isHttps ? https : http;

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: {
          'User-Agent': this.USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: this.TIMEOUT_MS,
      };

      const req = client.request(options, (res) => {
        // Handle redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectCount >= this.MAX_REDIRECTS) {
            return reject(new Error('Too many redirects'));
          }
          const redirectUrl = new URL(res.headers.location, url).toString();
          return resolve(this.fetchHtml(redirectUrl, redirectCount + 1));
        }

        if (res.statusCode && res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        let html = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          html += chunk;
          // Limit HTML size to prevent memory issues (DoS protection)
          if (html.length > 500000) { // 500KB limit
            res.destroy();
            resolve(html.substring(0, 500000)); // Truncate to limit
          }
        });

        res.on('end', () => {
          resolve(html);
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.end();
    });
  }

  /**
   * Parse metadata from HTML
   */
  private async parseMetadata(html: string, url: string): Promise<LinkMetadataResult> {
    const result: LinkMetadataResult = { url };
    
    try {
      const urlObj = new URL(url);

      // Extract Open Graph tags
      const ogTitle = this.extractMetaTag(html, 'property', 'og:title') || this.extractMetaTag(html, 'name', 'twitter:title');
      const ogDescription = this.extractMetaTag(html, 'property', 'og:description') || this.extractMetaTag(html, 'name', 'twitter:description');
      const ogSiteName = this.extractMetaTag(html, 'property', 'og:site_name');

      // Extract images - try multiple sources
      const ogImage = this.extractMetaTag(html, 'property', 'og:image');
      const twitterImage = this.extractMetaTag(html, 'name', 'twitter:image');
      const twitterImageSrc = this.extractMetaTag(html, 'name', 'twitter:image:src');
      const firstImageTag = this.extractFirstImageTag(html);
      
      // Prioritize: og:image > twitter:image > twitter:image:src > first img tag
      const imageUrl = ogImage || twitterImage || twitterImageSrc || firstImageTag;
      let image: string | undefined = undefined;
      
      if (imageUrl) {
        const resolved = this.resolveUrl(imageUrl, urlObj, true); // true = isImage
        if (resolved) {
          image = resolved;
        } else {
          // If resolution fails, try to use the original URL if it's already absolute
          if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
            image = imageUrl;
          } else {
            // Try to construct absolute URL
            try {
              image = new URL(imageUrl, urlObj.toString()).toString();
            } catch {
              logger.debug('[LinkMetadataService] Could not resolve image URL:', imageUrl);
            }
          }
        }
      }
      
      logger.debug('[LinkMetadataService] Extracted image URL:', { 
        ogImage, 
        twitterImage, 
        twitterImageSrc, 
        firstImageTag,
        original: imageUrl,
        resolved: image 
      });
      
      // Cache and optimize image if URL is valid
      // Check cache first, then cache if needed
      if (image && image.trim().length > 0) {
        try {
          // Check if already cached
          const cachedUrl = await imageCacheService.getCachedImage(image);
          if (cachedUrl) {
            // Use cached version (already optimized)
            logger.debug('[LinkMetadataService] Using cached image:', cachedUrl);
            image = cachedUrl;
          } else {
            // Cache it now (this may take a few seconds but ensures optimized images)
            logger.debug('[LinkMetadataService] Caching image:', image);
            const cachedImageUrl = await imageCacheService.cacheImage(image);
            if (cachedImageUrl) {
              logger.debug('[LinkMetadataService] Image cached successfully:', cachedImageUrl);
              image = cachedImageUrl;
            } else {
              logger.warn('[LinkMetadataService] Image caching returned null, using original URL');
              // Keep original URL if caching fails
            }
          }
        } catch (error) {
          logger.warn('[LinkMetadataService] Image caching failed, using original URL:', error);
          // Continue with original URL if caching fails
        }
      } else {
        logger.debug('[LinkMetadataService] No image found in metadata');
      }

      // Extract standard meta tags
      const title = ogTitle || this.extractTag(html, 'title');
      const description = ogDescription || this.extractMetaTag(html, 'name', 'description');
      const siteName = ogSiteName || urlObj.hostname.replace('www.', '');

      // Extract favicon
      const favicon = this.extractFavicon(html, urlObj);
      
      // Log image value before assignment
      logger.debug('[LinkMetadataService] Image value before assignment:', {
        image,
        imageType: typeof image,
        imageLength: image?.length,
        isTruthy: !!image,
        isNonEmpty: image && image.trim().length > 0,
      });
      
      // Sanitize all text fields (XSS protection)
      result.title = title ? sanitizeText(title) : undefined;
      result.description = description ? sanitizeText(description) : undefined;
      // URLs should not be HTML-escaped, just validated
      // Use explicit check to handle empty strings correctly
      result.image = (image && image.trim().length > 0) ? image : undefined;
      result.siteName = siteName ? sanitizeText(siteName) : undefined;
      // Favicon is a URL, don't HTML-escape it
      result.favicon = favicon || undefined;
      
      // Log final result for debugging (after assignment)
      logger.debug('[LinkMetadataService] Final metadata:', {
        url: result.url,
        hasImage: !!result.image,
        image: result.image,
        hasTitle: !!result.title,
        hasDescription: !!result.description,
      });
    } catch (error) {
      logger.error('[LinkMetadataService] Error parsing metadata:', error);
      // Return basic metadata on parse error
      try {
        const urlObj = new URL(url);
        result.siteName = urlObj.hostname.replace('www.', '');
        result.title = urlObj.hostname;
      } catch {
        result.siteName = 'Link';
        result.title = url;
      }
    }

    return result;
  }

  /**
   * Extract meta tag content
   */
  private extractMetaTag(html: string, attribute: string, value: string): string | null {
    const regex = new RegExp(`<meta[^>]*${attribute}=["']${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*content=["']([^"']+)["']`, 'i');
    const match = html.match(regex);
    return match ? match[1] : null;
  }

  /**
   * Extract title tag
   */
  private extractTag(html: string, tagName: string): string | null {
    const regex = new RegExp(`<${tagName}[^>]*>([^<]+)</${tagName}>`, 'i');
    const match = html.match(regex);
    return match ? match[1].trim() : null;
  }

  /**
   * Extract first image tag from HTML
   * Looks for <img> tags and returns the src attribute
   */
  private extractFirstImageTag(html: string): string | null {
    // Try to find img tags, prioritizing those with common class names for featured/hero images
    const imgPatterns = [
      /<img[^>]*class=["'][^"']*(?:featured|hero|main|cover|header|og-image|social)[^"']*["'][^>]*src=["']([^"']+)["']/i,
      /<img[^>]*src=["']([^"']+)["'][^>]*class=["'][^"']*(?:featured|hero|main|cover|header|og-image|social)[^"']*["']/i,
      /<img[^>]*src=["']([^"']+)["']/i,
    ];

    for (const pattern of imgPatterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        const src = match[1].trim();
        // Skip data URIs and very small images (likely icons)
        if (!src.startsWith('data:') && !src.includes('icon') && !src.includes('logo')) {
          return src;
        }
      }
    }

    return null;
  }

  /**
   * Extract favicon
   */
  private extractFavicon(html: string, baseUrl: URL): string | null {
    // Try link rel="icon" or rel="shortcut icon"
    const linkRegex = /<link[^>]*rel=["'](?:icon|shortcut icon)["'][^>]*href=["']([^"']+)["']/i;
    const match = html.match(linkRegex);
    if (match) {
      return this.resolveUrl(match[1], baseUrl);
    }

    // Fallback to default favicon location
    return `${baseUrl.protocol}//${baseUrl.host}/favicon.ico`;
  }

  /**
   * Resolve relative URL to absolute
   * For images, we're more lenient - we validate but don't block if it's for display only
   */
  private resolveUrl(url: string, baseUrl: URL, isImage: boolean = false): string {
    try {
      // If URL is already absolute, use it directly
      if (url.startsWith('http://') || url.startsWith('https://')) {
        // For absolute URLs, validate security
        const securityCheck = validateUrlSecurity(url);
        if (!securityCheck.valid && !isImage) {
          logger.warn('[LinkMetadataService] URL failed security check:', url);
          return '';
        }
        // For images, we'll allow them even if security check fails (they're just displayed)
        // The actual fetching will be validated separately
        return url;
      }
      
      // Resolve relative URL
      const resolved = new URL(url, baseUrl.toString()).toString();
      
      // For images, be more lenient - just return the resolved URL
      // The image cache service will validate when actually fetching
      if (isImage) {
        return resolved;
      }
      
      // For non-images, validate security
      const securityCheck = validateUrlSecurity(resolved);
      if (!securityCheck.valid) {
        logger.warn('[LinkMetadataService] Resolved URL failed security check:', resolved);
        return '';
      }
      
      return resolved;
    } catch (error) {
      logger.debug('[LinkMetadataService] Error resolving URL:', error);
      return '';
    }
  }
}

export const linkMetadataService = new LinkMetadataService();

