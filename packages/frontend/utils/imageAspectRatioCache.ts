/**
 * Shared module-scoped cache of image aspect ratios (width / height), keyed by
 * the image source URI.
 *
 * Both the post media thumbnail (`PostAttachmentMedia`) and the fullscreen
 * zoom gallery (`ZoomableImageGallery`) read from and write to this SAME map so
 * an image tapped in the feed already has its ratio when it opens "big" — no
 * second cache, no duplicate `Image.getSize` round-trip on the hot path.
 */
import { Image } from 'react-native';

/** Fallback ratio used when a remote image's intrinsic size cannot be read. */
export const DEFAULT_ASPECT_RATIO = 4 / 3;

const aspectRatioCache = new Map<string, number>();

export const getAspectRatio = (uri: string): number | undefined => aspectRatioCache.get(uri);

export const hasAspectRatio = (uri: string): boolean => aspectRatioCache.has(uri);

export const setAspectRatio = (uri: string, ratio: number): void => {
  if (uri && ratio > 0 && Number.isFinite(ratio)) {
    aspectRatioCache.set(uri, ratio);
  }
};

/**
 * Resolve the aspect ratio for `uri`, returning the cached value immediately on
 * a hit and otherwise fetching the intrinsic size via `Image.getSize`, writing
 * the result back into the shared cache. On failure the shared
 * `DEFAULT_ASPECT_RATIO` is cached and returned so callers never deadlock on a
 * broken image.
 */
export const fetchAspectRatio = (uri: string): Promise<number> => {
  const cached = aspectRatioCache.get(uri);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }
  return new Promise<number>((resolve) => {
    Image.getSize(
      uri,
      (width, height) => {
        if (width > 0 && height > 0) {
          const ratio = width / height;
          aspectRatioCache.set(uri, ratio);
          resolve(ratio);
          return;
        }
        aspectRatioCache.set(uri, DEFAULT_ASPECT_RATIO);
        resolve(DEFAULT_ASPECT_RATIO);
      },
      () => {
        aspectRatioCache.set(uri, DEFAULT_ASPECT_RATIO);
        resolve(DEFAULT_ASPECT_RATIO);
      }
    );
  });
};
