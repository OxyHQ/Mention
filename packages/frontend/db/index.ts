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

// Post queries
export {
  upsertPost,
  upsertPosts,
  getPostById,
  getPostsByIds,
  updatePost,
  deletePost,
  pruneOldPosts,
} from './postQueries';

// Feed queries
export type { FeedMetaData } from './feedQueries';
export {
  setFeedItems,
  appendFeedItems,
  getAllFeedItems,
  getFeedMeta,
  hasFeedData,
  removeFeedItem,
  addFeedItemAtStart,
  getFeedKeysForPost,
  removePostFromAllFeeds,
  clearFeed,
} from './feedQueries';

// Link queries
export {
  upsertLink,
  getLink,
  isLinkCached,
  pruneExpiredLinks,
  clearAllLinks,
  invalidateLink,
} from './linkQueries';
