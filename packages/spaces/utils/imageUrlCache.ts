/**
 * Image URL Cache — same implementation as @mention/frontend
 */

interface CachedUrl {
  url: string;
  expiresAt: number;
}

class ImageUrlCache {
  private cache: Map<string, CachedUrl> = new Map();
  private readonly defaultTTL = 60 * 60 * 1000;
  private readonly maxSize = 5000;

  private getCacheKey(fileId: string, variant?: string): string {
    return variant ? `${fileId}:${variant}` : fileId;
  }

  private evictIfNeeded(): void {
    if (this.cache.size <= this.maxSize) return;
    const entries = Array.from(this.cache.entries())
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    const toRemove = entries.slice(0, this.cache.size - this.maxSize);
    toRemove.forEach(([key]) => this.cache.delete(key));
  }

  get(fileId: string, variant?: string): string | null {
    const key = this.getCacheKey(fileId, variant);
    const cached = this.cache.get(key);
    if (!cached) return null;
    if (Date.now() > cached.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return cached.url;
  }

  set(fileId: string, url: string, variant?: string, ttl?: number): void {
    const key = this.getCacheKey(fileId, variant);
    const expiresAt = Date.now() + (ttl || this.defaultTTL);
    this.cache.set(key, { url, expiresAt });
    this.evictIfNeeded();
  }

  clearExpired(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];
    for (const [key, cached] of this.cache.entries()) {
      if (now > cached.expiresAt) keysToDelete.push(key);
    }
    keysToDelete.forEach(key => this.cache.delete(key));
  }

  clear(): void {
    this.cache.clear();
  }
}

export const imageUrlCache = new ImageUrlCache();

if (typeof window !== 'undefined') {
  setInterval(() => imageUrlCache.clearExpired(), 5 * 60 * 1000);
}

export async function getCachedFileDownloadUrl(
  oxyServices: any,
  fileId: string,
  variant?: string,
  expiresIn?: number
): Promise<string> {
  const cached = imageUrlCache.get(fileId, variant);
  if (cached) return cached;

  if (oxyServices?.getFileDownloadUrlAsync) {
    try {
      const url = await oxyServices.getFileDownloadUrlAsync(fileId, variant, expiresIn);
      const ttl = expiresIn ? expiresIn * 1000 : undefined;
      imageUrlCache.set(fileId, url, variant, ttl);
      return url;
    } catch {}
  }

  const url = oxyServices?.getFileDownloadUrl?.(fileId, variant, expiresIn);
  if (!url || !url.startsWith('http')) return fileId;
  const ttl = expiresIn ? expiresIn * 1000 : undefined;
  imageUrlCache.set(fileId, url, variant, ttl);
  return url;
}

export function getCachedFileDownloadUrlSync(
  oxyServices: any,
  fileId: string,
  variant?: string,
  expiresIn?: number
): string {
  const cached = imageUrlCache.get(fileId, variant);
  if (cached) return cached;

  const url = oxyServices?.getFileDownloadUrl?.(fileId, variant, expiresIn);
  if (!url || !url.startsWith('http')) return fileId;
  const ttl = expiresIn ? expiresIn * 1000 : undefined;
  imageUrlCache.set(fileId, url, variant, ttl);
  return url;
}
