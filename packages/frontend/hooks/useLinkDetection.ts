import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ClarityClient } from '@clarity.surf/sdk';
import { useAuth } from '@oxy.so/services/ui/client';
import { MAX_POST_DOCUMENTS } from '@mention/shared-types/post';
import { type LinkMetadata, useLinksStore } from '../stores/linksStore';
import { extractUrls } from '@/utils/extractUrls';
import { ownProfileLinkHandle } from '@/utils/ownProfileLinks';
import { logger } from '@oxy.so/core/logger';

/**
 * Hook to detect the links in a post's text and resolve their previews. A post
 * shows up to `MAX_POST_DOCUMENTS` cards (the same cap the backend applies),
 * so only that many URLs are resolved — metadata for links that would never get
 * a card is wasted work.
 *
 * A URL naming a profile on THIS instance gets no card, because the published
 * post will not have one: hydration withholds it server-side for exactly these
 * URLs (`PostHydrationService.ownProfileLinkUrls`), since the reader is shown a
 * mention there rather than a link. Offering the card in the composer would be
 * showing the author an attachment their post is not going to carry.
 */
export const useLinkDetection = (text: string) => {
  const [detectedLinks, setDetectedLinks] = useState<LinkMetadata[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const { oxyServices } = useAuth();
  const clarity = useMemo(() => new ClarityClient({
    getAccessToken: () => oxyServices.getClient().getAccessToken() || Promise.reject(new Error('No active Oxy session')),
  }), [oxyServices]);
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

    // Resolve through Clarity. A bounded wait may return a document immediately
    // or a pending job; pending URLs simply have no card until the next pass.
    try {
      const resolution = await clarity.indexing.resolve({ urls: [url], waitMs: 8_000 }, { signal });
      const preview = resolution.data[0]?.document;
      if (!preview) return null;
      if (signal?.aborted) return null;

      const metadata: LinkMetadata = {
        url: preview.canonicalUrl,
        title: preview.title,
        description: preview.description,
        image: preview.imageUrl,
        siteName: preview.publisher,
        favicon: preview.faviconUrl,
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
  }, [clarity, getCached, upsertLink]);

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
      // Capped BEFORE the profile-link filter, matching hydration: a body with
      // more than `MAX_POST_DOCUMENTS` links, one of them a profile link,
      // renders one card fewer rather than promoting the next link into the
      // freed slot. Filtering first would show the author a card the published
      // post does not have.
      const urls = extractUrls(text)
        .slice(0, MAX_POST_DOCUMENTS)
        .filter((url) => ownProfileLinkHandle(url) === undefined);

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
