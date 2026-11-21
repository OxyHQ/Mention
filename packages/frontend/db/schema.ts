/**
 * The post type every surface reads, and the link-preview row of `mention.db`.
 *
 * Posts are stored by the account's data store (`data/posts`) as the JSON of
 * this type; only link previews still have SQLite rows here.
 */

import type { HydratedBoostContext, HydratedPost } from '@mention/shared-types';
import type { LinkMetadata } from '@/stores/linksStore';

// ── Row types (match SQLite columns) ─────────────────────────────

export interface ClarityDocumentRow {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  site_name: string | null;
  favicon: string | null;
  error: string | null;
  fetched_at: number;
  ttl_ms: number;
}

// ── FeedItem type ──────────────────────────────────────────────

type CachedBoostContext = Omit<HydratedBoostContext, 'originalPost'> & {
  originalPost: FeedItem | null;
};

/**
 * The canonical hydrated post plus cache-only rendering metadata. Related posts
 * keep the public `originalPost` / `quotedPost` / `boost.originalPost` names at
 * every layer; the cache never manufactures a second alias for the same object.
 */
export type FeedItem = Omit<HydratedPost, 'originalPost' | 'quotedPost' | 'boost'> & {
  originalPost?: FeedItem | null;
  quotedPost?: FeedItem | null;
  boost?: CachedBoostContext | null;
  date?: string;
  media?: string[];
  mediaIds?: string[];
  originalMediaIds?: string[];
  allMediaIds?: string[];
  isLocalNew?: boolean;
};

// ── Link preview conversions ─────────────────────────────────────

export function linkMetadataToRow(metadata: LinkMetadata): ClarityDocumentRow {
  return {
    url: metadata.url,
    title: metadata.title || null,
    description: metadata.description || null,
    image: metadata.image || null,
    site_name: metadata.siteName || null,
    favicon: metadata.favicon || null,
    error: metadata.error || null,
    fetched_at: Date.now(),
    ttl_ms: 30 * 60 * 1000, // 30 min default
  };
}

export function rowToLinkMetadata(row: ClarityDocumentRow): LinkMetadata {
  return {
    url: row.url,
    title: row.title || undefined,
    description: row.description || undefined,
    image: row.image || undefined,
    siteName: row.site_name || undefined,
    favicon: row.favicon || undefined,
    error: row.error || undefined,
    fetchedAt: row.fetched_at,
  };
}
