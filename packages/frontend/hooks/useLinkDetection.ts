import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@oxyhq/services';
import { MAX_POST_LINK_PREVIEWS } from '@mention/shared-types';
import { LinkMetadata } from '../stores/linksStore';
import { useLinksStore } from '../stores/linksStore';
import { extractUrls } from '@/utils/extractUrls';
import { logger } from '@/lib/logger';

/**
 * Hook to detect the links in a post's text and resolve their previews. A post
 * shows up to `MAX_POST_LINK_PREVIEWS` cards (the same cap the backend applies),
 * so only that many URLs are resolved — metadata for links that would never get
 * a card is wasted work.
 */
export const useLinkDetection = (text: string) => {
  const [detectedLinks, setDetectedLinks] = useState<LinkMetadata[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const { oxyServices } = useAuth();
  const { getCached, upsertLink } = useLinksStore();
  const fetchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  /**
   * Fetch metadata for a URL
   */
  const fetchLinkMetadata = useCallback(async (url: string, signal?: AbortSignal): Promise<LinkMetadata | null> => {
    // Check cache first
    const cached = getCached(url);
    if (cached) {
      return cached;
    }

    // Resolve the preview through the Oxy SDK. Oxy owns resolution and re-hosts
    // the preview image on `cloud.oxy.so`, so the returned `image` is a trusted
    // absolute URL that is rendered directly (no app-side proxy). `wait: true`
    // asks the server to resolve synchronously instead of returning a `pending`
    // placeholder, so the composer gets metadata in one round-trip.
    try {
      const preview = await oxyServices.getLinkPreview(url, { wait: true });
      if (signal?.aborted) return null;

      const metadata: LinkMetadata = {
        url,
        title: preview.title,
        description: preview.description,
        image: preview.image,
        siteName: preview.siteName,
        favicon: preview.favicon,
        fetchedAt: Date.now(),
      };
      upsertLink(metadata);
      return metadata;
    } catch (err) {
      if (signal?.aborted) return null;
      // A failed unfurl is non-actionable for the composer — show no preview.
      logger.debug('Link preview resolution failed', { url, error: err });
      return null;
    }
  }, [getCached, upsertLink, oxyServices]);

  /**
   * Process text and fetch metadata for all detected links
   */
  useEffect(() => {
    // Clear previous timeout
    if (fetchTimeoutRef.current) {
      clearTimeout(fetchTimeoutRef.current);
    }

    // Abort previous requests
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Debounce link detection (wait 500ms after user stops typing)
    fetchTimeoutRef.current = setTimeout(async () => {
      const urls = extractUrls(text).slice(0, MAX_POST_LINK_PREVIEWS);

      if (urls.length === 0) {
        setDetectedLinks([]);
        setIsLoading(false);
        setError(null);
        return;
      }

      setIsLoading(true);
      setError(null);
      abortControllerRef.current = new AbortController();

      try {
        // Fetch metadata for all URLs in parallel
        const metadataPromises = urls.map(url => fetchLinkMetadata(url, abortControllerRef.current?.signal));
        const results = await Promise.all(metadataPromises);
        
        // Check if request was aborted
        if (abortControllerRef.current?.signal.aborted) {
          return;
        }
        
        // Filter out null results and errors
        const validLinks = results.filter(
          (meta): meta is LinkMetadata => 
            meta !== null && !meta.error
        );

        setDetectedLinks(validLinks);
      } catch (err) {
        if (abortControllerRef.current?.signal.aborted) {
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to fetch link metadata');
      } finally {
        if (!abortControllerRef.current?.signal.aborted) {
          setIsLoading(false);
        }
      }
    }, 500);

    return () => {
      if (fetchTimeoutRef.current) {
        clearTimeout(fetchTimeoutRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [text, fetchLinkMetadata]);

  return {
    detectedLinks,
    isLoading,
    error,
  };
};

