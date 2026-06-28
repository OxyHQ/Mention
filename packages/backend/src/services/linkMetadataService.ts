import type { IncomingMessage } from 'http';
import { URL } from 'url';
import { logger } from '../utils/logger';
import { validateUrlLength, decodeHtmlEntities } from '../utils/urlSecurity';
import { fetchUpstreamSingleHop, SsrfRejection } from '../utils/safeUpstreamFetch';
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
 * Hard upper bound on bytes read from a remote page when extracting metadata.
 *
 * Heavy pages push their Open Graph tags far into the document — a YouTube
 * `watch` page, for example, carries correct `og:*` tags in its static `<head>`
 * but they sit ~630 KB in, with `</head>` closing near 640 KB inside a ~1.4 MB
 * document. A small cap aborts before the tags are ever seen, leaving only the
 * hostname fallback. This default is generous enough to reach those tags while
 * still bounding worst-case memory.
 *
 * The read also early-terminates at `</head>` (see
 * {@link LinkMetadataService.readLimitedResponse}), so a normal page reads only
 * a few KB and the full document is never downloaded — this cap is purely the
 * worst-case ceiling for a page whose head close never arrives. Tunable via env
 * without a redeploy.
 */
const LINK_METADATA_MAX_BYTES = Number(process.env.LINK_METADATA_MAX_BYTES ?? 1024 * 1024);

/** The HTML head-close marker the streaming read stops at (ASCII, case-insensitive). */
const HEAD_CLOSE_MARKER = '</head>';

/**
 * Service to fetch link metadata (Open Graph, Twitter Cards, etc.)
 * Fetches the page over the SSRF-safe single-hop fetcher and extracts Open
 * Graph / Twitter Card tags from the HTML head locally (no third-party lib).
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

      logger.debug('[LinkMetadataService] Fetching metadata for:', normalizedUrl);

      const { metadata, finalUrl } = await this.fetchMetadataDocument(normalizedUrl);

      logger.debug('[LinkMetadataService] Extracted metadata:', {
        hasTitle: !!metadata.title,
        hasDescription: !!metadata.description,
        hasImage: !!metadata.image,
        hasSiteName: !!metadata['og:site_name'],
      });

      const result: LinkMetadataResult = {
        url: finalUrl,
        title: metadata.title || metadata['og:title'] || metadata['twitter:title'],
        description: metadata.description || metadata['og:description'] || metadata['twitter:description'],
        image: metadata.image || metadata['og:image'] || metadata['twitter:image'],
        siteName: metadata['og:site_name'] || this.extractSiteName(finalUrl),
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
          const absoluteImageUrl = this.resolveImageUrl(result.image, finalUrl);
          
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

  private async fetchMetadataDocument(initialUrl: string): Promise<{ metadata: Record<string, string>; finalUrl: string }> {
    let currentUrl = initialUrl;
    const maxRedirects = 3;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

      try {
        const result = await fetchUpstreamSingleHop(currentUrl, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
            'Accept-Encoding': 'identity',
          },
          headersTimeoutMs: this.TIMEOUT_MS,
        });

        const { response, status, headers } = result;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.destroy();
          if (hop === maxRedirects) throw new Error('Too many redirects');
          const location = headers.location;
          if (!location || Array.isArray(location)) throw new Error('Invalid redirect location');
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }

        const contentTypeHeader = headers['content-type'] || '';
        const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader;
        if (contentType && !contentType.toLowerCase().includes('html')) {
          response.destroy();
          return { metadata: {}, finalUrl: currentUrl };
        }

        const html = await this.readLimitedResponse(response, LINK_METADATA_MAX_BYTES, true);
        return { metadata: this.extractMetadataFromHtml(html), finalUrl: currentUrl };
      } catch (error) {
        if (error instanceof SsrfRejection) {
          logger.warn('[LinkMetadataService] Security check failed:', error.message);
          throw new Error('URL security validation failed');
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new Error('Too many redirects');
  }

  /**
   * Read a bounded amount of the response body for metadata extraction.
   *
   * Two early-stop conditions, both resolving (never rejecting) so the parser
   * always receives whatever was read:
   *  - `stopAtHeadClose`: as soon as `</head>` appears, the stream is destroyed
   *    and the buffer resolved — all metadata lives in the head, so the rest of
   *    the document (often the bulk of the bytes) is never downloaded. The match
   *    is case-insensitive and boundary-safe: each chunk is searched together
   *    with a small carryover from the previous one so a `</head>` split across
   *    the chunk boundary is still detected.
   *  - byte cap (`maxBytes`): on overflow the truncated buffer is resolved (not
   *    rejected) so {@link extractMetadataFromHtml} still has data to parse.
   *
   * A single `settled` guard ensures data/end/error never double-resolve.
   */
  private async readLimitedResponse(
    response: IncomingMessage,
    maxBytes: number,
    stopAtHeadClose = false,
  ): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      let settled = false;

      // `</head>` is 7 bytes; carrying its length minus one from the previous
      // tail guarantees a marker split across the boundary is still matched.
      const carrySize = HEAD_CLOSE_MARKER.length - 1;
      let carry: Buffer = Buffer.alloc(0);

      const finish = (): void => {
        if (settled) return;
        settled = true;
        response.destroy();
        resolve(Buffer.concat(chunks).toString('utf8'));
      };

      response.on('data', (chunk: Buffer) => {
        if (settled) return;
        totalSize += chunk.length;
        chunks.push(chunk);

        if (stopAtHeadClose) {
          // Search the small carryover joined with this chunk. `</head>` is
          // pure ASCII, so a latin1 decode preserves bytes 1:1 and lowercasing
          // yields an exact case-insensitive match. Cost is linear in the body.
          const window = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
          if (window.toString('latin1').toLowerCase().includes(HEAD_CLOSE_MARKER)) {
            finish();
            return;
          }
          carry = window.length > carrySize ? window.subarray(window.length - carrySize) : window;
        }

        if (totalSize > maxBytes) {
          finish();
        }
      });

      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      response.on('error', (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
  }

  private extractMetadataFromHtml(html: string): Record<string, string> {
    const metadata: Record<string, string> = {};
    const headMatch = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
    const head = headMatch?.[1] ?? html.slice(0, 128 * 1024);
    const attrPattern = /([a-zA-Z_:.-]+)\s*=\s*(["'])(.*?)\2/g;

    for (const tagMatch of head.matchAll(/<(title|meta|link)\b[^>]*>([\s\S]*?)<\/\1>|<(meta|link)\b[^>]*\/?\s*>/gi)) {
      const fullTag = tagMatch[0];
      const tagName = (tagMatch[1] || tagMatch[3] || '').toLowerCase();
      if (tagName === 'title') {
        metadata.title = decodeHtmlEntities(tagMatch[2] || '');
        continue;
      }

      const attrs: Record<string, string> = {};
      attrPattern.lastIndex = 0;
      for (const attr of fullTag.matchAll(attrPattern)) {
        attrs[attr[1].toLowerCase()] = decodeHtmlEntities(attr[3]);
      }

      if (tagName === 'meta') {
        const key = attrs.property || attrs.name;
        if (key && attrs.content) metadata[key.toLowerCase()] = attrs.content;
      } else if (tagName === 'link' && attrs.rel?.toLowerCase().includes('icon') && attrs.href) {
        metadata.favicon = attrs.href;
      }
    }

    return metadata;
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
