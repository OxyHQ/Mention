# Image Cache Setup Instructions

## Overview
The image cache service downloads, resizes, and compresses images from external URLs to improve performance and security.

## Current Status
The service is implemented but uses basic image validation. For production, you should add image processing capabilities.

## Required: Install Sharp Library

To enable image resizing and compression, install the Sharp library:

```bash
npm install sharp
npm install --save-dev @types/sharp
```

## Update imageCacheService.ts

After installing Sharp, update the `processImage` method in `packages/backend/src/services/imageCacheService.ts`:

```typescript
import sharp from 'sharp';

private async processImage(imageBuffer: Buffer, originalUrl: string): Promise<Buffer> {
  try {
    // Resize and compress image
    const processed = await sharp(imageBuffer)
      .resize(MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: JPEG_QUALITY })
      .png({ quality: PNG_QUALITY })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();

    // Ensure file size is within limit
    if (processed.length > MAX_FILE_SIZE) {
      // Further compress if needed
      return await sharp(processed)
        .jpeg({ quality: 70 })
        .toBuffer();
    }

    return processed;
  } catch (error) {
    logger.error('[ImageCacheService] Error processing image:', error);
    throw error;
  }
}
```

## Configuration

You can adjust these constants in `imageCacheService.ts`:

- `MAX_IMAGE_WIDTH`: Maximum width (default: 800px)
- `MAX_IMAGE_HEIGHT`: Maximum height (default: 600px)
- `JPEG_QUALITY`: JPEG compression quality 1-100 (default: 80)
- `PNG_QUALITY`: PNG compression quality 1-100 (default: 80)
- `WEBP_QUALITY`: WebP compression quality 1-100 (default: 80)
- `MAX_FILE_SIZE`: Maximum cached file size (default: 500KB)

## Benefits

1. **Performance**: Smaller images load faster
2. **Bandwidth**: Reduced data usage for users
3. **Security**: Images are validated and sanitized
4. **Reliability**: Cached images don't depend on external servers
5. **Cost**: Reduced bandwidth costs

## Storage

Images are stored in MongoDB GridFS under the `link_images` bucket. They are automatically cached and served through `/api/links/images/:cacheKey`.

## Cache Management

- Images are cached indefinitely (consider adding TTL if needed)
- Cache key is SHA-256 hash of the original URL
- Duplicate URLs automatically use cached version

