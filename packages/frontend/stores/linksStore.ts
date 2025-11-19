import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export interface LinkMetadata {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  favicon?: string;
  fetchedAt: number;
  error?: string;
}

interface CachedLink {
  data: LinkMetadata;
  fetchedAt: number;
  ttlMs: number;
}

interface LinksState {
  linksByUrl: Record<string, CachedLink>;
  ttlMs: number; // default cache time-to-live

  // Upsert link metadata
  upsertLink: (metadata: LinkMetadata) => void;

  // Get cached link metadata
  getCached: (url: string) => LinkMetadata | undefined;

  // Check if link is cached and still valid
  isCached: (url: string) => boolean;

  // Invalidate cache for a URL
  invalidate: (url: string) => void;

  // Clear all cached links
  clearAll: () => void;
}

const now = () => Date.now();

export const useLinksStore = create<LinksState>()(
  subscribeWithSelector((set, get) => ({
    linksByUrl: {},
    ttlMs: 30 * 60 * 1000, // 30 minutes default TTL

    upsertLink: (metadata) => {
      if (!metadata?.url) return;
      const normalizedUrl = normalizeUrl(metadata.url);
      if (!normalizedUrl) return;

      set((state) => {
        const existing = state.linksByUrl[normalizedUrl];
        const ttl = existing?.ttlMs ?? state.ttlMs;

        return {
          linksByUrl: {
            ...state.linksByUrl,
            [normalizedUrl]: {
              data: {
                ...metadata,
                url: normalizedUrl,
                fetchedAt: now(),
              },
              fetchedAt: now(),
              ttlMs: ttl,
            },
          },
        };
      });
    },

    getCached: (url: string) => {
      const normalizedUrl = normalizeUrl(url);
      if (!normalizedUrl) return undefined;

      const state = get();
      const cached = state.linksByUrl[normalizedUrl];
      if (!cached) return undefined;

      // Check if cache is still valid
      const age = now() - cached.fetchedAt;
      if (age > cached.ttlMs) {
        // Cache expired, remove it
        set((state) => {
          const { [normalizedUrl]: _, ...rest } = state.linksByUrl;
          return { linksByUrl: rest };
        });
        return undefined;
      }

      return cached.data;
    },

    isCached: (url: string) => {
      const normalizedUrl = normalizeUrl(url);
      if (!normalizedUrl) return false;

      const state = get();
      const cached = state.linksByUrl[normalizedUrl];
      if (!cached) return false;

      // Check if cache is still valid
      const age = now() - cached.fetchedAt;
      return age <= cached.ttlMs;
    },

    invalidate: (url: string) => {
      const normalizedUrl = normalizeUrl(url);
      if (!normalizedUrl) return;

      set((state) => {
        const { [normalizedUrl]: _, ...rest } = state.linksByUrl;
        return { linksByUrl: rest };
      });
    },

    clearAll: () => {
      set({ linksByUrl: {} });
    },
  }))
);

/**
 * Normalize URL for consistent caching
 */
function normalizeUrl(url: string): string | null {
  if (!url || typeof url !== 'string') return null;
  let normalized = url.trim();
  if (!normalized) return null;

  // Add protocol if missing
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`;
  }

  try {
    const parsed = new URL(normalized);
    // Remove trailing slash for consistency
    const path = parsed.pathname.endsWith('/') && parsed.pathname !== '/'
      ? parsed.pathname.slice(0, -1)
      : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${path}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

