/**
 * Database module — barrel export.
 *
 * Import from '@/db' for all database operations.
 */

// Core
export type { SQLiteDb } from './database';
export { getDb, resetDb, isDbAvailable } from './database';
export {
  claimViewerCache,
  readPersistedViewerOwner,
  type ViewerCacheClaim,
} from './cacheLifecycle';

// Schema types & conversions
export type { ClarityDocumentRow, FeedItem } from './schema';
export { linkMetadataToRow, rowToLinkMetadata } from './schema';

// Link queries
export {
  upsertLink,
  getLink,
  isLinkCached,
  pruneExpiredLinks,
  clearAllLinks,
  invalidateLink,
} from './linkQueries';
