import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { logger } from '../utils/logger';
import { validateUrlSecurity } from '../utils/urlSecurity';
import crypto from 'crypto';
import { Transformer, ResizeFit } from '@napi-rs/image';
import { getS3Client, getBucket, getCdnUrl } from '../utils/spaces';
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

/**
 * Service to cache and optimize images from external URLs.
 * Downloads, resizes, compresses, and stores images in S3 (DigitalOcean Spaces)
 * under the link-previews/ prefix.
 */

// Image processing configuration (defaults for link previews)
const MAX_IMAGE_WIDTH = Number(process.env.LINK_PREVIEW_MAX_WIDTH ?? 200);
const MAX_IMAGE_HEIGHT = Number(process.env.LINK_PREVIEW_MAX_HEIGHT ?? 150);
const JPEG_QUALITY = Number(process.env.LINK_PREVIEW_JPEG_QUALITY ?? 80);
const PNG_QUALITY = Number(process.env.LINK_PREVIEW_PNG_QUALITY ?? 80);
const WEBP_QUALITY = Number(process.env.LINK_PREVIEW_WEBP_QUALITY ?? 80);
const MAX_FILE_SIZE = Number(process.env.LINK_PREVIEW_MAX_FILE_SIZE ?? 500 * 1024);

// S3 key prefix for all link preview images
const LINK_PREVIEW_PREFIX = 'link-previews';

export interface ImageProcessingOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
}

class ImageCacheService {
  private readonly TIMEOUT_MS = 10000; // 10 seconds for image downloads
  private readonly USER_AGENT = 'MentionBot/1.0 (+https://mention.earth)';

  /**
   * Build the S3 object key for a given cache key
   */
  private getObjectKey(cacheKey: string): string {
    return `${LINK_PREVIEW_PREFIX}/${cacheKey}`;
  }

  /**
   * Normalize and resolve image URL to absolute URL
   */
  private normalizeImageUrl(url: string): string {
    if (!url || typeof url !== 'string') return url;
    const trimmed = url.trim();
    if (!trimmed) return url;

    // Already absolute
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        const parsed = new URL(trimmed);
        // Remove common query params that don't affect image content
        parsed.searchParams.delete('w');
        parsed.searchParams.delete('h');
        parsed.searchParams.delete('width');
        parsed.searchParams.delete('height');
        parsed.searchParams.delete('q');
        parsed.searchParams.delete('quality');
        return parsed.toString();
      } catch {
        return trimmed;
      }
    }

    return trimmed;
  }

  /**
   * Generate cache key from normalized URL
   */
  generateCacheKey(url: string): string {
    const normalized = this.normalizeImageUrl(url);
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  /**
   * Check if image is already cached in S3
   * Returns the CDN URL if cached, null otherwise
   */
  async getCachedImage(url: string): Promise<string | null> {
    try {
      const cacheKey = this.generateCacheKey(url);
      const objectKey = this.getObjectKey(cacheKey);

      await getS3Client().send(new HeadObjectCommand({
        Bucket: getBucket(),
        Key: objectKey,
      }));

      // Object exists — return CDN URL
      return getCdnUrl(objectKey);
    } catch (error: any) {
      // 404 / NoSuchKey means not cached yet
      if (error?.name === 'NotFound' || error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) {
        return null;
      }
      logger.error('[ImageCacheService] Error checking S3 cache:', {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Download image from URL
   */
  private async downloadImage(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      // Security check
      const securityCheck = validateUrlSecurity(url);
      if (!securityCheck.valid) {
        return reject(new Error(securityCheck.error || 'URL security validation failed'));
      }

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
          'Accept': 'image/*',
        },
        timeout: this.TIMEOUT_MS,
      };

      const req = client.request(options, (res) => {
        // Check content type
        const contentType = res.headers['content-type'] || '';
        if (!contentType.startsWith('image/')) {
          return reject(new Error('URL does not point to an image'));
        }

        // Check content length
        const contentLength = parseInt(res.headers['content-length'] || '0', 10);
        if (contentLength > 10 * 1024 * 1024) { // 10MB limit
          return reject(new Error('Image too large'));
        }

        const chunks: Buffer[] = [];
        let totalSize = 0;

        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          totalSize += chunk.length;

          // Prevent memory issues
          if (totalSize > 10 * 1024 * 1024) { // 10MB limit
            res.destroy();
            return reject(new Error('Image too large'));
          }
        });

        res.on('end', () => {
          resolve(Buffer.concat(chunks));
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
   * Process and optimize image using @napi-rs/image
   */
  private async processImage(imageBuffer: Buffer, options?: ImageProcessingOptions): Promise<{ buffer: Buffer; contentType: string }> {
    const maxWidth = options?.maxWidth ?? MAX_IMAGE_WIDTH;
    const maxHeight = options?.maxHeight ?? MAX_IMAGE_HEIGHT;
    const quality = options?.quality ?? WEBP_QUALITY;

    const bufferStart = imageBuffer.toString('utf8', 0, Math.min(100, imageBuffer.length));
    const isSvg =
      bufferStart.trim().startsWith('<?xml') ||
      bufferStart.trim().startsWith('<svg') ||
      bufferStart.trim().startsWith('<!DOCTYPE svg');

    if (isSvg) {
      if (imageBuffer.length > 10 * 1024 * 1024) {
        throw new Error('SVG file too large');
      }
      return { buffer: imageBuffer, contentType: 'image/svg+xml' };
    }

    const transformer = new Transformer(imageBuffer);
    const metadata = await transformer.metadata();

    // GIF images: return as-is to preserve animation
    if (metadata.format === 'gif') {
      return { buffer: imageBuffer, contentType: 'image/gif' };
    }

    // Determine resize dimensions (only downscale, never enlarge)
    const resizeWidth = metadata.width > maxWidth ? maxWidth : undefined;
    const resizeHeight = metadata.height > maxHeight ? maxHeight : undefined;

    // Build a fresh transformer for the processing pipeline
    const pipeline = new Transformer(imageBuffer);

    // Apply orientation correction
    if (metadata.orientation) {
      pipeline.rotate(metadata.orientation);
    }

    // Apply resize if needed (Contain = fit inside bounds without cropping)
    if (resizeWidth || resizeHeight) {
      pipeline.resize({
        width: resizeWidth ?? maxWidth,
        height: resizeHeight ?? maxHeight,
        fit: ResizeFit.Inside,
      });
    }

    // Convert to webp for best compression
    const buffer = await pipeline.webp(quality);
    return { buffer, contentType: 'image/webp' };
  }

  private mapFormatToContentType(format?: string): string {
    switch (format) {
      case 'png':
        return 'image/png';
      case 'gif':
        return 'image/gif';
      case 'webp':
        return 'image/webp';
      case 'avif':
        return 'image/avif';
      default:
        return 'image/jpeg';
    }
  }

  /**
   * Store image in S3 under link-previews/ prefix.
   * Object is public-read so it can be served via the CDN.
   */
  private async storeImage(buffer: Buffer, cacheKey: string, contentType: string): Promise<string> {
    const objectKey = this.getObjectKey(cacheKey);

    await getS3Client().send(new PutObjectCommand({
      Bucket: getBucket(),
      Key: objectKey,
      Body: buffer,
      ContentType: contentType || 'image/jpeg',
      ACL: 'public-read',
      Metadata: {
        cachedAt: new Date().toISOString(),
      },
    }));

    logger.debug('[ImageCacheService] Stored image in S3:', { objectKey });
    return getCdnUrl(objectKey);
  }

  /**
   * Cache image from URL.
   * Returns the CDN URL of the cached image, or null if caching failed.
   */
  async cacheImage(imageUrl: string): Promise<string | null> {
    try {
      const normalizedUrl = this.normalizeImageUrl(imageUrl);

      // Check if already cached
      const cached = await this.getCachedImage(normalizedUrl);
      if (cached) {
        return cached;
      }

      // Download image
      const imageBuffer = await this.downloadImage(normalizedUrl);

      // Process image (resize/compress)
      let processedResult: { buffer: Buffer; contentType: string } | null = null;
      try {
        processedResult = await this.processImage(imageBuffer);
      } catch (error) {
        logger.warn('[ImageCacheService] Image processing failed, using original:', {
          url: normalizedUrl,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      const finalBuffer = processedResult?.buffer ?? imageBuffer;
      const contentType = processedResult?.contentType ?? this.detectContentType(imageBuffer);

      const cacheKey = this.generateCacheKey(normalizedUrl);
      const cdnUrl = await this.storeImage(finalBuffer, cacheKey, contentType);

      logger.debug('[ImageCacheService] Image cached successfully:', { url: normalizedUrl, cacheKey });
      return cdnUrl;
    } catch (error) {
      logger.error('[ImageCacheService] Error caching image:', {
        url: imageUrl,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      return null;
    }
  }

  /**
   * Detect image content type from buffer
   */
  private detectContentType(buffer: Buffer): string {
    // Check for SVG (text-based)
    const bufferStart = buffer.toString('utf8', 0, Math.min(100, buffer.length));
    if (bufferStart.trim().startsWith('<?xml') ||
        bufferStart.trim().startsWith('<svg') ||
        bufferStart.trim().startsWith('<!DOCTYPE svg')) {
      return 'image/svg+xml';
    }

    // Check raster image formats
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
    if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif';
    if (buffer.length > 11 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp';
    return 'image/jpeg'; // Default
  }

  /**
   * Get image stream from cache.
   * With S3 storage, images are served directly via CDN — this method is kept
   * for backward compatibility but returns null (callers should use the CDN URL).
   */
  async getImageStream(cacheKey: string): Promise<{ stream: NodeJS.ReadableStream; contentType: string } | null> {
    try {
      const objectKey = this.getObjectKey(cacheKey);
      const response = await getS3Client().send(new GetObjectCommand({
        Bucket: getBucket(),
        Key: objectKey,
      }));

      if (!response.Body) {
        return null;
      }

      const contentType = response.ContentType || 'image/jpeg';
      // AWS SDK v3 Body is a readable stream
      const stream = response.Body as NodeJS.ReadableStream;
      return { stream, contentType };
    } catch (error: any) {
      if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) {
        return null;
      }
      logger.error('[ImageCacheService] Error getting image stream from S3:', {
        cacheKey,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Delete a specific image from cache
   */
  async deleteImage(cacheKey: string): Promise<boolean> {
    try {
      const objectKey = this.getObjectKey(cacheKey);
      await getS3Client().send(new DeleteObjectCommand({
        Bucket: getBucket(),
        Key: objectKey,
      }));
      logger.debug('[ImageCacheService] Deleted image from S3:', { objectKey });
      return true;
    } catch (error) {
      logger.error('[ImageCacheService] Error deleting image from S3:', error);
      return false;
    }
  }

  /**
   * Cache an optimized variant of an image with custom dimensions.
   * Returns the cache key and content type, or null on failure.
   */
  async cacheOptimizedImage(imageUrl: string, options: ImageProcessingOptions): Promise<{ cacheKey: string; contentType: string } | null> {
    try {
      const normalizedUrl = this.normalizeImageUrl(imageUrl);
      const { maxWidth, maxHeight, quality } = options;
      const sizeKey = `${maxWidth ?? 0}x${maxHeight ?? 0}q${quality ?? 80}`;
      const cacheKey = crypto.createHash('sha256').update(`${normalizedUrl}:${sizeKey}`).digest('hex');
      const objectKey = this.getObjectKey(cacheKey);

      // Check if already cached in S3
      try {
        const head = await getS3Client().send(new HeadObjectCommand({
          Bucket: getBucket(),
          Key: objectKey,
        }));
        const contentType = head.ContentType || 'image/webp';
        return { cacheKey, contentType };
      } catch (headError: any) {
        // Not cached yet — continue to download and store
        if (!(headError?.name === 'NotFound' || headError?.name === 'NoSuchKey' || headError?.$metadata?.httpStatusCode === 404)) {
          throw headError;
        }
      }

      // Download image
      const imageBuffer = await this.downloadImage(normalizedUrl);

      // Process with custom options
      let processedResult: { buffer: Buffer; contentType: string } | null = null;
      try {
        processedResult = await this.processImage(imageBuffer, options);
      } catch (error) {
        logger.warn('[ImageCacheService] Image processing failed for optimized variant, using original:', {
          url: normalizedUrl,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      const finalBuffer = processedResult?.buffer ?? imageBuffer;
      const contentType = processedResult?.contentType ?? this.detectContentType(imageBuffer);

      await this.storeImage(finalBuffer, cacheKey, contentType);

      logger.debug('[ImageCacheService] Optimized image cached in S3:', { url: normalizedUrl, cacheKey, sizeKey });
      return { cacheKey, contentType };
    } catch (error) {
      logger.error('[ImageCacheService] Error caching optimized image:', {
        url: imageUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Clear all cached images (not supported in bulk for S3 — returns 0)
   * In production, use S3 lifecycle rules or the AWS console for bulk deletion.
   */
  async clearAllImages(): Promise<number> {
    logger.warn('[ImageCacheService] clearAllImages() is not supported for S3 storage. Use S3 lifecycle rules instead.');
    return 0;
  }
}

export const imageCacheService = new ImageCacheService();
