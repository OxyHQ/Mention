/**
 * Database module — barrel export.
 *
 * Import from '@/db' for all database operations.
 */

// Core
export type { SQLiteDb } from './database';
export { getDb, closeDb, resetDb, isDbAvailable } from './database';
export {
  claimViewerCache,
  clearAllCachedData,
  readPersistedViewerOwner,
  type ViewerCacheClaim,
} from './cacheLifecycle';

// Schema types & conversions
export type {
  PostRow,
  FeedItemRow,
  FeedMetaRow,
  ClarityDocumentRow,
  FeedItem,
} from './schema';
export {
  TABLE,
  postToRow,
  rowToFeedItem,
  linkMetadataToRow,
  rowToLinkMetadata,
  buildFeedKey,
} from './schema';

// Link queries
export {
  upsertLink,
  getLink,
  isLinkCached,
  pruneExpiredLinks,
  clearAllLinks,
  invalidateLink,
} from './linkQueries';
