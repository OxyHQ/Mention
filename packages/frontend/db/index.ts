/**
 * Database module — barrel export.
 * 
 * Import from '@/db' for all database operations.
 */

// Core
export { getDb, closeDb, resetDb } from './database';

// Schema types & conversions
export type {
  PostRow,
  ActorRow,
  FeedItemRow,
  FeedMetaRow,
  LinkPreviewRow,
  FeedItem,
} from './schema';
export {
  TABLE,
  postToRow,
  rowToFeedItem,
  actorToRow,
  rowToUserEntity,
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

// Actor queries
export {
  upsertActor,
  upsertManyActors,
  primeActorsFromPosts,
  getActorById,
  getActorByUsername,
  isActorStale,
  isActorFull,
  invalidateActor,
  clearAllActors,
} from './actorQueries';

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
