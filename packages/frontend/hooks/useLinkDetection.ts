import { useState, useEffect, useCallback, useRef } from 'react';
import { MAX_POST_DOCUMENTS } from '@mention/shared-types/post';
import { feedService } from '@/services/feedService';
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
 * Previews come from Mention's backend (`POST /posts/link-previews`), which
 * resolves them through Clarity with its own service credentials. The app never
 * talks to Clarity directly.
 *
 * A URL naming a profile on THIS instance gets no card, because the published
 * post will not have one: hydration withholds it server-side for exactly these
 * URLs (`previewableUrls` in the backend's `utils/clarityDocuments`), since the reader is shown a
 * mention there rather than a link. Offering the card in the composer would be
 * showing the author an attachment their post is not going to carry.
 */
export const useLinkDetection = (text: string) => {
  const [detectedLinks, setDetectedLinks] = useState<LinkMetadata[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const { getCached, upsertLink } = useLinksStore();
  const fetchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  /**
   * Resolve every URL not already cached in ONE backend call, and return the
   * cards in the order the URLs were given. A link the backend has no card for
   * yet (still being indexed, or unresolvable) simply has none; the next pass
   * asks again.
   */
  const fetchLinkMetadata = useCallback(async (urls: string[], signal?: AbortSignal): Promise<LinkMetadata[]> => {
    const byUrl = new Map<string, LinkMetadata>();
    const missing: string[] = [];
    for (const url of urls) {
      const cached = getCached(url);
      if (cached) byUrl.set(url, cached);
      else missing.push(url);
    }

    if (missing.length > 0) {
      try {
        const { previews } = await feedService.resolveLinkPreviews(missing, signal);
        if (signal?.aborted) return [];
        for (const { url, document } of previews) {
          const metadata: LinkMetadata = {
            url: document.canonicalUrl,
            title: document.title,
            description: document.description,
            image: document.imageUrl,
            siteName: document.publisher,
            favicon: document.faviconUrl,
            fetchedAt: Date.now(),
          };
          upsertLink(metadata);
          byUrl.set(url, metadata);
        }
      } catch (err) {
        if (signal?.aborted) return [];
        // A failed unfurl is non-actionable for the composer — show no preview.
        logger.debug('Link preview resolution failed', { count: missing.length, error: err });
      }
    }

    return urls.flatMap((url) => {
      const metadata = byUrl.get(url);
      return metadata ? [metadata] : [];
    });
  }, [getCached, upsertLink]);

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
        const results = await fetchLinkMetadata(urls, abortControllerRef.current?.signal);
        
        // Check if request was aborted
        if (abortControllerRef.current?.signal.aborted) {
          return;
        }
        
        // Filter out null results and errors
        const validLinks = results.filter((meta) => !meta.error);

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
