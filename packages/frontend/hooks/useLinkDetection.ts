import { useState, useEffect, useCallback, useRef } from 'react';
import { LinkMetadata } from '../stores/linksStore';
import { useLinksStore } from '../stores/linksStore';
import { linkMetadataService } from '../services/linkMetadataService';

/**
 * Hook to detect links in text and fetch their metadata
 * Similar to Twitter's link preview feature
 */
export const useLinkDetection = (text: string) => {
  const [detectedLinks, setDetectedLinks] = useState<LinkMetadata[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const { getCached, upsertLink } = useLinksStore();
  const fetchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  /**
   * Extract URLs from text using the same pattern as LinkifiedText
   */
  const extractUrls = useCallback((inputText: string): string[] => {
    if (!inputText || typeof inputText !== 'string') return [];

    const urls: string[] = [];
    // Match URLs: http(s)://... or www....
    const urlPattern = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
    let match: RegExpExecArray | null;

    while ((match = urlPattern.exec(inputText)) !== null) {
      const urlCandidate = match[0];
      if (urlCandidate) {
        // Trim trailing punctuation
        let url = urlCandidate;
        while (/[.,!?):;\]]$/.test(url)) {
          url = url.slice(0, -1);
        }
        
        // Normalize URL
        const normalized = url.startsWith('http') ? url : `https://${url}`;
        try {
          new URL(normalized); // Validate URL
          urls.push(normalized);
        } catch {
          // Invalid URL, skip
        }
      }
    }

    // Deduplicate
    return Array.from(new Set(urls));
  }, []);

  /**
   * Fetch metadata for a URL
   */
  const fetchLinkMetadata = useCallback(async (url: string, signal?: AbortSignal): Promise<LinkMetadata | null> => {
    // Check cache first
    const cached = getCached(url);
    if (cached) {
      return cached;
    }

    // Fetch metadata
    try {
      const metadata = await linkMetadataService.fetchMetadata(url);
      if (signal?.aborted) return null;
      
      if (metadata) {
        upsertLink(metadata);
        return metadata;
      }
    } catch (err) {
      if (signal?.aborted) return null;
      // Silently handle errors - will show basic link preview
    }

    return null;
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
      const urls = extractUrls(text);
      
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
  }, [text, extractUrls, fetchLinkMetadata]);

  return {
    detectedLinks,
    isLoading,
    error,
  };
};

