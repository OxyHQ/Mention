/**
 * Image URL Cache Utility
 * 
 * Caches generated image URLs to prevent redundant API calls.
 * URLs are cached with TTL matching signed URL expiration (default 1 hour).
 */

interface CachedUrl {
  url: string;
  expiresAt: number;
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
    
    // Sort by expiration time and remove oldest entries
    const entries = Array.from(this.cache.entries())
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    
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

    return cached.url;
  }

  /**
   * Set cached URL with TTL
   */
  set(fileId: string, url: string, variant?: string, ttl?: number): void {
    const key = this.getCacheKey(fileId, variant);
    const expiresAt = Date.now() + (ttl || this.defaultTTL);
    
    this.cache.set(key, { url, expiresAt });
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

