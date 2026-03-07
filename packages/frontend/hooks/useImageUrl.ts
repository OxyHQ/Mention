import { useState, useEffect, useMemo } from 'react';
import { imageUrlCache, getCachedFileDownloadUrl } from '@/utils/imageUrlCache';
import { oxyServices } from '@/lib/oxyServices';

/**
 * Hook to resolve file IDs to download URLs asynchronously.
 * Returns cached URL instantly on cache hit (no state update/re-render).
 * On cache miss, triggers async resolution and re-renders when ready.
 */
export function useImageUrl(
  fileId: string | undefined | null,
  variant?: string,
  oxyServicesOverride?: any,
): string | undefined {
  const services = oxyServicesOverride ?? oxyServices;

  // Synchronous cache check — no blocking API call, no state update needed
  const cachedUrl = useMemo(() => {
    if (!fileId) return undefined;
    if (fileId.startsWith('http://') || fileId.startsWith('https://')) return fileId;
    return imageUrlCache.get(fileId, variant) ?? undefined;
  }, [fileId, variant]);

  const [resolvedUrl, setResolvedUrl] = useState<string | undefined>(cachedUrl);

  // Reset resolved URL when fileId changes and we have a cache hit
  useEffect(() => {
    if (cachedUrl) {
      setResolvedUrl(cachedUrl);
    }
  }, [cachedUrl]);

  useEffect(() => {
    if (!fileId || cachedUrl) return;
    if (fileId.startsWith('http://') || fileId.startsWith('https://')) return;

    let cancelled = false;
    getCachedFileDownloadUrl(services, fileId, variant).then((url) => {
      if (!cancelled) setResolvedUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [fileId, variant, cachedUrl, services]);

  return cachedUrl ?? resolvedUrl;
}
