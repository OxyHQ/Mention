import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { logger } from '../utils/logger';
import { validateUrlSecurity } from '../utils/urlSecurity';
import mongoose from 'mongoose';
import { GridFSBucket } from 'mongodb';
import crypto from 'crypto';
import sharp from 'sharp';

/**
 * Service to cache and optimize images from external URLs
 * Downloads, resizes, compresses, and stores images
 */

// Image processing configuration
const MAX_IMAGE_WIDTH = Number(process.env.LINK_PREVIEW_MAX_WIDTH ?? 800);
const MAX_IMAGE_HEIGHT = Number(process.env.LINK_PREVIEW_MAX_HEIGHT ?? 600);
const JPEG_QUALITY = Number(process.env.LINK_PREVIEW_JPEG_QUALITY ?? 80);
const PNG_QUALITY = Number(process.env.LINK_PREVIEW_PNG_QUALITY ?? 80);
const WEBP_QUALITY = Number(process.env.LINK_PREVIEW_WEBP_QUALITY ?? 80);
const MAX_FILE_SIZE = Number(process.env.LINK_PREVIEW_MAX_FILE_SIZE ?? 500 * 1024);

let bucket: GridFSBucket | null = null;

const initGridFS = () => {
  if (!bucket && mongoose.connection.db) {
    bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: 'link_images'
    });
  }
  return bucket;
};

class ImageCacheService {
  private readonly TIMEOUT_MS = 15000; // 15 seconds for image downloads
  private readonly USER_AGENT = 'MentionBot/1.0 (+https://mention.earth)';

  /**
   * Generate cache key from URL
   */
  generateCacheKey(url: string): string {
    return crypto.createHash('sha256').update(url).digest('hex');
  }

  /**
   * Check if image is already cached
   */
  async getCachedImage(url: string): Promise<string | null> {
    try {
      const bucket = initGridFS();
      if (!bucket) return null;

      const cacheKey = this.generateCacheKey(url);
      
      // Check if file exists in GridFS
      const files = await bucket.find({ filename: cacheKey }).toArray();
      if (files.length > 0) {
        // Return URL to serve the cached image
        return `/api/links/images/${cacheKey}`;
      }
      
      return null;
    } catch (error) {
      logger.error('[ImageCacheService] Error checking cache:', error);
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
   * Process and optimize image using sharp
   */
  private async processImage(imageBuffer: Buffer): Promise<{ buffer: Buffer; contentType: string }> {
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

    const base = sharp(imageBuffer, { failOnError: false });
    const metadata = await base.metadata();
    const isAnimated = (metadata.pages ?? 1) > 1;

    const resizeOptions = {
      width: metadata.width && metadata.width > MAX_IMAGE_WIDTH ? MAX_IMAGE_WIDTH : undefined,
      height: metadata.height && metadata.height > MAX_IMAGE_HEIGHT ? MAX_IMAGE_HEIGHT : undefined,
      fit: 'inside' as const,
      withoutEnlargement: true,
      fastShrinkOnLoad: true,
    };

    let pipeline = sharp(imageBuffer, { failOnError: false })
      .resize(resizeOptions)
      .withMetadata({ orientation: metadata.orientation });

    if (!isAnimated) {
      pipeline = pipeline.webp({
        quality: WEBP_QUALITY,
        effort: 4,
        smartSubsample: true,
      });
      const buffer = await pipeline.toBuffer();
      return { buffer, contentType: 'image/webp' };
    }

    const format = metadata.format ?? 'jpeg';
    switch (format) {
      case 'png':
        pipeline = pipeline.png({ compressionLevel: 9, quality: PNG_QUALITY });
        break;
      case 'gif':
        return { buffer: imageBuffer, contentType: 'image/gif' };
      case 'webp':
        pipeline = pipeline.webp({
          quality: WEBP_QUALITY,
          effort: 4,
        });
        break;
      default:
        pipeline = pipeline.jpeg({
          quality: JPEG_QUALITY,
          mozjpeg: true,
        });
    }

    const processedBuffer = await pipeline.toBuffer();
    return { buffer: processedBuffer, contentType: this.mapFormatToContentType(format) };
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
   * Store image in GridFS
   */
  private async storeImage(buffer: Buffer, cacheKey: string, contentType: string): Promise<void> {
    const bucket = initGridFS();
    if (!bucket) {
      throw new Error('GridFS not initialized');
    }

    return new Promise((resolve, reject) => {
      const uploadStream = bucket.openUploadStream(cacheKey, {
        contentType: contentType || 'image/jpeg',
        metadata: {
          cachedAt: new Date(),
        }
      });

      const { Readable } = require('stream');
      const readableStream = Readable.from(buffer);
      
      readableStream
        .pipe(uploadStream)
        .on('error', reject)
        .on('finish', resolve);
    });
  }

  /**
   * Cache image from URL
   * Returns the cached image URL or null if caching failed
   */
  async cacheImage(imageUrl: string): Promise<string | null> {
    try {
      // Check if already cached
      const cached = await this.getCachedImage(imageUrl);
      if (cached) {
        return cached;
      }

      // Download image
      const imageBuffer = await this.downloadImage(imageUrl);

      // Process image (resize/compress)
      let processedResult: { buffer: Buffer; contentType: string } | null = null;
      try {
        processedResult = await this.processImage(imageBuffer);
      } catch (error) {
        logger.warn('[ImageCacheService] Image processing failed, using original:', error);
      }

      const finalBuffer = processedResult?.buffer ?? imageBuffer;
      const contentType = processedResult?.contentType ?? this.detectContentType(imageBuffer);

      // Store in GridFS
      const cacheKey = this.generateCacheKey(imageUrl);
      await this.storeImage(finalBuffer, cacheKey, contentType);

      // Return URL to serve cached image
      return `/api/links/images/${cacheKey}`;
    } catch (error) {
      logger.error('[ImageCacheService] Error caching image:', error);
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
   * Get image stream from cache
   */
  async getImageStream(cacheKey: string): Promise<{ stream: NodeJS.ReadableStream; contentType: string } | null> {
    try {
      const bucket = initGridFS();
      if (!bucket) return null;

      const files = await bucket.find({ filename: cacheKey }).toArray();
      if (files.length === 0) return null;

      const file = files[0];
      const downloadStream = bucket.openDownloadStreamByName(cacheKey);

      return {
        stream: downloadStream,
        contentType: file.contentType || 'image/jpeg',
      };
    } catch (error) {
      logger.error('[ImageCacheService] Error getting image stream:', error);
      return null;
    }
  }

  /**
   * Delete a specific image from cache
   */
  async deleteImage(cacheKey: string): Promise<boolean> {
    try {
      const bucket = initGridFS();
      if (!bucket) return false;

      const files = await bucket.find({ filename: cacheKey }).toArray();
      if (files.length === 0) return false;

      // Delete all files with this cache key (should be just one)
      for (const file of files) {
        await bucket.delete(file._id);
      }

      return true;
    } catch (error) {
      logger.error('[ImageCacheService] Error deleting image:', error);
      return false;
    }
  }

  /**
   * Clear all cached images
   */
  async clearAllImages(): Promise<number> {
    try {
      const bucket = initGridFS();
      if (!bucket) return 0;

      // Get all files in the bucket
      const files = await bucket.find({}).toArray();
      const count = files.length;

      // Delete all files
      for (const file of files) {
        await bucket.delete(file._id);
      }

      logger.info('[ImageCacheService] Cleared all images:', { count });
      return count;
    } catch (error) {
      logger.error('[ImageCacheService] Error clearing all images:', error);
      return 0;
    }
  }
}

export const imageCacheService = new ImageCacheService();

