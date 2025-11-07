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

  return {
    normalizeUrl,
    isValidSourceUrl,
  };
};
