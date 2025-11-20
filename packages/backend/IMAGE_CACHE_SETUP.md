# Image Cache Setup Instructions

## Overview
The image cache service downloads, resizes, and compresses images from external URLs to improve performance and security.

## Current Status
The service now uses the `sharp` library to resize and compress preview images before caching. Static images are converted to WebP (quality defaults to 80) and limited to `MAX_IMAGE_WIDTH` x `MAX_IMAGE_HEIGHT`. Animated assets (GIF/WebP) preserve animation but still respect max dimensions. SVGs are cached as-is with size validation.

If you need to tweak processing:

- `LINK_PREVIEW_MAX_WIDTH`, `LINK_PREVIEW_MAX_HEIGHT`
- `LINK_PREVIEW_WEBP_QUALITY`, `LINK_PREVIEW_JPEG_QUALITY`, `LINK_PREVIEW_PNG_QUALITY`
- `LINK_PREVIEW_MAX_FILE_SIZE`

These environment variables override the defaults defined near the top of `imageCacheService.ts`.

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

