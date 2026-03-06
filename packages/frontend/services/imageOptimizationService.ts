import { API_URL } from '@/config';

export type ImageSize = 'thumb' | 'small' | 'medium' | 'large' | 'original';

interface SizePreset {
  width: number;
  height: number;
  quality: number;
}

/**
 * Size presets mapping ImageSize to max dimensions and quality.
 * Images are resized to fit within these bounds while preserving aspect ratio.
 */
const SIZE_PRESETS: Record<Exclude<ImageSize, 'original'>, SizePreset> = {
  thumb: { width: 80, height: 80, quality: 60 },
  small: { width: 200, height: 200, quality: 70 },
  medium: { width: 600, height: 600, quality: 80 },
  large: { width: 1200, height: 1200, quality: 85 },
};

/**
 * Check if a URL should bypass the optimization proxy.
 * Returns true for URLs that are already optimized or internal.
 */
function shouldBypassOptimization(uri: string): boolean {
  // Relative paths are already on our server
  if (!uri.startsWith('http://') && !uri.startsWith('https://')) {
    return true;
  }

  // Already served through our image cache
  if (uri.includes('/links/images/') || uri.includes('/images/')) {
    return true;
  }

  // Data URIs
  if (uri.startsWith('data:')) {
    return true;
  }

  return false;
}

/**
 * Generate an optimized image URL that routes through the backend optimization service.
 * For 'original' size or already-optimized URLs, returns the URI unchanged.
 */
export function getOptimizedImageUrl(uri: string, size: ImageSize): string {
  if (!uri || typeof uri !== 'string') {
    return uri;
  }

  // No optimization needed for original size
  if (size === 'original') {
    return uri;
  }

  // Skip URLs that don't need optimization
  if (shouldBypassOptimization(uri)) {
    return uri;
  }

  const preset = SIZE_PRESETS[size];
  const params = new URLSearchParams({
    url: uri,
    w: String(preset.width),
    h: String(preset.height),
    q: String(preset.quality),
  });

  return `${API_URL}/images/optimize?${params.toString()}`;
}
