import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import {
  upsertLink as dbUpsertLink,
  getLink as dbGetLink,
  isLinkCached as dbIsLinkCached,
  invalidateLink as dbInvalidateLink,
  clearAllLinks as dbClearAllLinks,
} from '@/db';

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

interface LinksState {
  // Version counter — bumped on every data mutation to trigger re-reads from SQLite
  dataVersion: number;

  // Upsert link metadata
  upsertLink: (metadata: LinkMetadata) => void;

  // Get cached link metadata (synchronous from SQLite)
  getCached: (url: string) => LinkMetadata | undefined;

  // Check if link is cached and still valid
  isCached: (url: string) => boolean;

  // Invalidate cache for a URL
  invalidate: (url: string) => void;

  // Clear all cached links
  clearAll: () => void;
}

export const useLinksStore = create<LinksState>()(
  subscribeWithSelector((set, get) => ({
    dataVersion: 0,

    upsertLink: (metadata) => {
      if (!metadata?.url) return;
      dbUpsertLink(metadata);
      set((s) => ({ dataVersion: s.dataVersion + 1 }));
    },

    getCached: (url: string) => {
      if (!url) return undefined;
      return dbGetLink(url) ?? undefined;
    },

    isCached: (url: string) => {
      if (!url) return false;
      return dbIsLinkCached(url);
    },

    invalidate: (url: string) => {
      if (!url) return;
      dbInvalidateLink(url);
      set((s) => ({ dataVersion: s.dataVersion + 1 }));
    },

    clearAll: () => {
      dbClearAllLinks();
      set((s) => ({ dataVersion: s.dataVersion + 1 }));
    },
  }))
);
