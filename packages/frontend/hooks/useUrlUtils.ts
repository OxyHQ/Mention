import { useCallback } from 'react';

/**
 * Hook for URL normalization and validation
 * Provides utilities for handling source URLs
 */
export const useUrlUtils = () => {
  /**
   * Normalize a URL by adding protocol if missing
   * @param raw - Raw URL string
   * @returns Normalized URL or null if invalid
   */
  const normalizeUrl = useCallback((raw: string): string | null => {
    if (!raw || typeof raw !== 'string') return null;
    let value = raw.trim();
    if (!value) return null;
    if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value)) {
      value = `https://${value}`;
    }
    try {
      const parsed = new URL(value);
      return parsed.toString();
    } catch {
      return null;
    }
  }, []);

  /**
   * Validate if a string is a valid URL
   * Returns true for empty strings (valid case in compose form)
   * @param url - URL string to validate
   * @returns true if valid or empty, false otherwise
   */
  const isValidSourceUrl = useCallback((url: string): boolean => {
    if (!url || typeof url !== 'string') return true;
    const trimmed = url.trim();
    if (!trimmed) return true;
    const normalized = normalizeUrl(trimmed);
    return normalized !== null;
  }, [normalizeUrl]);

  /**
   * Sanitize sources list for submission
   * Normalizes URLs, deduplicates, and limits to max sources
   * @param list - Raw sources list
   * @returns Sanitized sources array
   */
  const sanitizeSourcesForSubmit = useCallback((
    list: Array<{ id: string; title: string; url: string }> | undefined
  ): Array<{ url: string; title?: string }> => {
    if (!Array.isArray(list) || list.length === 0) return [];

    const MAX_SOURCES = 5;
    const normalized: Array<{ url: string; title?: string }> = [];

    list.forEach((item) => {
      const normalizedUrl = normalizeUrl(item.url);
      if (!normalizedUrl) return;
      const title = item.title?.trim();
      normalized.push(title ? { url: normalizedUrl, title } : { url: normalizedUrl });
    });

    const deduped = normalized.filter((source, index, self) => 
      self.findIndex((s) => s.url === source.url) === index
    );
    return deduped.slice(0, MAX_SOURCES);
  }, [normalizeUrl]);

  return {
    normalizeUrl,
    isValidSourceUrl,
    sanitizeSourcesForSubmit,
  };
};
