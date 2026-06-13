/**
 * Image URL Cache Utility
 *
 * Caches generated image URLs to prevent redundant API calls.
 * URLs are cached with TTL matching signed URL expiration (default 1 hour).
 */

import { API_URL, OXY_BASE_URL } from '@/config';

// Backend media proxy: streams remote media with CORS + cache + HTTP Range, and
// survives expiring upstream links. See backend `GET /media/proxy?url=<encoded>`.
const MEDIA_PROXY_PATH = '/media/proxy';

/**
 * Origins we own — absolute URLs on these hosts must NOT be routed through the
 * proxy (they already resolve to our own backend/CDN and proxying them would be
 * a wasteful double-hop). Derived from configured bases, never hardcoded hosts.
 */
const ownOrigins = (() => {
  const origins = new Set<string>();
  for (const base of [API_URL, OXY_BASE_URL]) {
    if (!base) continue;
    try {
      origins.add(new URL(base).origin);
    } catch {
      // A malformed base in config is non-fatal here: we simply can't treat it
      // as an "own" origin, so URLs on that host would be proxied. Skip it.
    }
  }
  return origins;
})();

/**
 * Route an absolute http(s) URL through the backend media proxy so external /
 * federated media loads reliably on web (CORS), survives expiring upstream
 * links, and gets cached. URLs that are already ours — our backend/CDN origins
 * or an existing `/media/proxy` URL — are returned unchanged to avoid a wasteful
 * double-proxy. Never throws: on any parse failure it returns the input URL so
 * it is safe to call directly in a render path.
 */
export function proxyExternalUrl(url: string): string {
  try {
    const parsed = new URL(url);

    // Only http(s) is proxyable. Anything else (data:, blob:, relative, …)
    // passes through untouched.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return url;
    }

    // Already ours → no proxy.
    if (ownOrigins.has(parsed.origin)) {
      return url;
    }

    // Already a proxy URL (defensive against double-proxying if a proxied URL
    // is fed back in from a host we don't recognise as ours).
    if (parsed.pathname === MEDIA_PROXY_PATH) {
      return url;
    }

    return `${API_URL}${MEDIA_PROXY_PATH}?url=${encodeURIComponent(url)}`;
  } catch {
    // Not a parseable absolute URL — return it as-is rather than throwing in a
    // render path. The non-http callers never reach here.
    return url;
  }
}

interface CachedUrl {
  url: string;
  expiresAt: number;
  lastAccessedAt: number;
}

class ImageUrlCache {
  private cache: Map<string, CachedUrl> = new Map();
  private readonly defaultTTL = 60 * 60 * 1000; // 1 hour in milliseconds
  private readonly maxSize = 5000; // Maximum cache entries to prevent memory issues

  /**
   * Generate cache key from file ID and variant
   */
  private getCacheKey(fileId: string, variant?: string): string {
    return variant ? `${fileId}:${variant}` : fileId;
  }
  
  /**
   * Evict oldest entries if cache exceeds max size
   */
  private evictIfNeeded(): void {
    if (this.cache.size <= this.maxSize) return;

    const entries = Array.from(this.cache.entries())
      .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);

    const toRemove = entries.slice(0, this.cache.size - this.maxSize);
    toRemove.forEach(([key]) => this.cache.delete(key));
  }

  /**
   * Get cached URL if available and not expired
   */
  get(fileId: string, variant?: string): string | null {
    const key = this.getCacheKey(fileId, variant);
    const cached = this.cache.get(key);
    
    if (!cached) {
      return null;
    }

    // Check if expired
    if (Date.now() > cached.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    // Update access time for LRU tracking
    cached.lastAccessedAt = Date.now();
    return cached.url;
  }

  /**
   * Set cached URL with TTL
   */
  set(fileId: string, url: string, variant?: string, ttl?: number): void {
    const key = this.getCacheKey(fileId, variant);
    const expiresAt = Date.now() + (ttl || this.defaultTTL);
    
    this.cache.set(key, { url, expiresAt, lastAccessedAt: Date.now() });
    this.evictIfNeeded();
  }

  /**
   * Clear expired entries (call periodically to prevent memory leaks)
   * More efficient: uses iterator to avoid creating intermediate arrays
   */
  clearExpired(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];
    
    for (const [key, cached] of this.cache.entries()) {
      if (now > cached.expiresAt) {
        keysToDelete.push(key);
      }
    }
    
    // Batch delete for better performance
    keysToDelete.forEach(key => this.cache.delete(key));
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache size (for debugging)
   */
  size(): number {
    return this.cache.size;
  }
}

// Singleton instance
export const imageUrlCache = new ImageUrlCache();

// Auto-cleanup expired entries every 5 minutes
if (typeof window !== 'undefined') {
  setInterval(() => {
    imageUrlCache.clearExpired();
  }, 5 * 60 * 1000);
}

/**
 * Get file download URL with caching
 * Uses async method when available, falls back to sync method
 */
export async function getCachedFileDownloadUrl(
  oxyServices: any,
  fileId: string,
  variant?: string,
  expiresIn?: number
): Promise<string> {
  // External/federated media: the id is already an absolute HTTP URL. Route it
  // through the backend media proxy (CORS + cache + Range, survives expiring
  // upstream links). Cache the result keyed by fileId+variant so the proxied URL
  // identity is stable across renders (prevents image flicker).
  if (fileId.startsWith('http://') || fileId.startsWith('https://')) {
    const cachedProxy = imageUrlCache.get(fileId, variant);
    if (cachedProxy) {
      return cachedProxy;
    }
    const proxied = proxyExternalUrl(fileId);
    imageUrlCache.set(fileId, proxied, variant);
    return proxied;
  }

  // Check cache first
  const cached = imageUrlCache.get(fileId, variant);
  if (cached) {
    return cached;
  }

  // Try async method if available
  if (oxyServices?.getFileDownloadUrlAsync) {
    try {
      const url = await oxyServices.getFileDownloadUrlAsync(fileId, variant, expiresIn);
      const ttl = expiresIn ? expiresIn * 1000 : undefined;
      imageUrlCache.set(fileId, url, variant, ttl);
      return url;
    } catch (error) {
      // Fall through to sync method
    }
  }

  // Fallback to sync method
  const url = oxyServices?.getFileDownloadUrl?.(fileId, variant, expiresIn);
  if (!url || !url.startsWith('http')) {
    // Don't cache invalid URLs — return raw fileId so next render retries
    return fileId;
  }
  const ttl = expiresIn ? expiresIn * 1000 : undefined;
  imageUrlCache.set(fileId, url, variant, ttl);
  return url;
}

/**
 * Get file download URL synchronously with caching
 * Use this when you need immediate return (e.g., in render)
 */
export function getCachedFileDownloadUrlSync(
  oxyServices: any,
  fileId: string,
  variant?: string,
  expiresIn?: number
): string {
  // External/federated media: the id is already an absolute HTTP URL. Route it
  // through the backend media proxy (CORS + cache + Range, survives expiring
  // upstream links). Cache the result keyed by fileId+variant so the proxied URL
  // identity is stable across renders (prevents image flicker).
  if (fileId.startsWith('http://') || fileId.startsWith('https://')) {
    const cachedProxy = imageUrlCache.get(fileId, variant);
    if (cachedProxy) {
      return cachedProxy;
    }
    const proxied = proxyExternalUrl(fileId);
    imageUrlCache.set(fileId, proxied, variant);
    return proxied;
  }

  // Check cache first
  const cached = imageUrlCache.get(fileId, variant);
  if (cached) {
    return cached;
  }

  // Generate URL using sync method
  const url = oxyServices?.getFileDownloadUrl?.(fileId, variant, expiresIn);
  if (!url || !url.startsWith('http')) {
    // Don't cache invalid URLs — return raw fileId so next render retries
    return fileId;
  }
  const ttl = expiresIn ? expiresIn * 1000 : undefined;
  imageUrlCache.set(fileId, url, variant, ttl);
  return url;
}

