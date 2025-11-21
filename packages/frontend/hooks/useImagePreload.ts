import { useEffect, useRef, useMemo } from 'react';
import { Image } from 'react-native';

/**
 * Hook to preload images for better perceived performance
 * Preloads images when they're likely to be viewed soon
 */
export function useImagePreload(urls: (string | undefined)[], enabled: boolean = true) {
  const preloadedRef = useRef<Set<string>>(new Set());
  
  // Memoize valid URLs to avoid unnecessary re-runs
  const validUrls = useMemo(() => {
    return urls.filter((url): url is string => 
      Boolean(url && (url.startsWith('http://') || url.startsWith('https://')))
    );
  }, [urls]);

  useEffect(() => {
    if (!enabled || !validUrls.length) return;

    validUrls.forEach((url) => {
      if (preloadedRef.current.has(url)) return;
      
      preloadedRef.current.add(url);
      Image.prefetch(url).catch(() => {
        // Silently handle prefetch errors - remove from set on error to allow retry
        preloadedRef.current.delete(url);
      });
    });
  }, [validUrls, enabled]);
  
  // Limit cache size to prevent memory issues (keep last 1000)
  useEffect(() => {
    if (preloadedRef.current.size > 1000) {
      const entries = Array.from(preloadedRef.current);
      const toRemove = entries.slice(0, entries.length - 1000);
      toRemove.forEach(url => preloadedRef.current.delete(url));
    }
  }, [validUrls]);
}

/**
 * Preload a single image
 */
export function preloadImage(url: string | undefined): void {
  if (!url || !url.startsWith('http')) return;
  
  Image.prefetch(url).catch(() => {
    // Silently handle prefetch errors
  });
}

