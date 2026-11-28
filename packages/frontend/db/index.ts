// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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

// Post queries
export {
  upsertPost,
  upsertPosts,
  getPostById,
  getPostsByIds,
  getPostIdsReferencing,
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
