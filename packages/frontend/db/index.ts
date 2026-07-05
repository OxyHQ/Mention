/**
 * Database module — barrel export.
 * 
 * Import from '@/db' for all database operations.
 */

// Core
export type { SQLiteDb } from './database';
export { getDb, closeDb, resetDb, isDbAvailable } from './database';
export { memClearAll as clearMemoryStore } from './memoryStore';

// Schema types & conversions
export type {
  PostRow,
  FeedItemRow,
  FeedMetaRow,
  LinkPreviewRow,
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
  updateEngagement,
  updateViewerState,
  updatePost,
  deletePost,
  pruneOldPosts,
  countPosts,
} from './postQueries';

// Feed queries
export type { FeedMetaData } from './feedQueries';
export {
  setFeedItems,
  appendFeedItems,
  getFeedItems,
  getAllFeedItems,
  getFeedItemCount,
  getFeedMeta,
  hasFeedData,
  getFeedKeys,
  updateFeedMeta,
  removeFeedItem,
  addFeedItemAtStart,
  removePostFromAllFeeds,
  clearFeed,
  clearAllFeeds,
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
