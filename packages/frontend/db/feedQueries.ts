/**
 * Feed queries — CRUD for feed_items + feed_meta tables.
 * 
 * Manages the mapping between feed keys and posts, preserving ordering.
 * 
 * IMPORTANT: Posts and actors must be written BEFORE feed_items due to
 * the FOREIGN KEY constraint (feed_items.post_id -> posts.id).
 */

import { getDb } from './database';
import type { FeedItemRow, FeedMetaRow, FeedItem } from './schema';
import { rowToFeedItem, buildFeedKey } from './schema';
import { upsertPosts } from './postQueries';
import { primeActorsFromPosts } from './actorQueries';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('FeedQueries');

// ── Helpers ──────────────────────────────────────────────────────

function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try { return JSON.parse(json) as T; } catch { return fallback; }
}

// ── Types ────────────────────────────────────────────────────────

export interface FeedMetaData {
  hasMore: boolean;
  nextCursor?: string;
  totalCount: number;
  lastUpdated: number;
  filters?: Record<string, any>;
}

// ── Write operations ─────────────────────────────────────────────

/**
 * Replace an entire feed's items.
 * Writes actors and posts FIRST (FK requirement), then feed_items.
 */
export function setFeedItems(
  feedKey: string,
  posts: (FeedItem | any)[],
  meta: FeedMetaData
): void {
  if (!feedKey) return;

  const db = getDb();
  if (!db) return;

  // Step 1: Upsert actors and posts BEFORE feed_items (FK constraint)
  try {
    primeActorsFromPosts(posts);
    upsertPosts(posts);
  } catch (e) {
    logger.error('Failed to upsert posts/actors for feed', { error: e });
    // Continue — feed_items will skip posts that failed to insert
  }

  // Step 2: Write feed_items and meta in a transaction
  try {
    db.execSync('BEGIN TRANSACTION');

    // Delete existing feed items
    db.runSync('DELETE FROM feed_items WHERE feed_key = ?', feedKey);

    const now = Date.now();
    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      const postId = post?.id || post?._id?.toString();
      if (!postId) continue;

      db.runSync(
        'INSERT OR IGNORE INTO feed_items (feed_key, post_id, position, slice_json, inserted_at) VALUES (?, ?, ?, ?, ?)',
        feedKey, postId, i, null, now
      );
    }

    // Upsert feed meta
    db.runSync(
      `INSERT OR REPLACE INTO feed_meta (feed_key, has_more, next_cursor, total_count, last_updated, filters_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      feedKey,
      meta.hasMore ? 1 : 0,
      meta.nextCursor || null,
      meta.totalCount,
      meta.lastUpdated || now,
      meta.filters ? JSON.stringify(meta.filters) : null
    );

    db.execSync('COMMIT');
  } catch (error) {
    db.execSync('ROLLBACK');
    logger.error(`Failed to set feed items for ${feedKey}`, { error });
  }
}

/**
 * Append items to an existing feed (pagination).
 * Writes actors and posts FIRST (FK requirement), then feed_items.
 */
export function appendFeedItems(
  feedKey: string,
  posts: (FeedItem | any)[],
  meta: Partial<FeedMetaData>
): void {
  if (!feedKey || !posts || posts.length === 0) return;

  const db = getDb();
  if (!db) return;

  // Step 1: Upsert actors and posts BEFORE feed_items (FK constraint)
  try {
    primeActorsFromPosts(posts);
    upsertPosts(posts);
  } catch (e) {
    logger.error('Failed to upsert posts/actors for feed append', { error: e });
  }

  // Step 2: Append feed_items in a transaction
  try {
    db.execSync('BEGIN TRANSACTION');

    // Get current max position
    const maxRow = db.getFirstSync<{ max_pos: number | null }>(
      'SELECT MAX(position) as max_pos FROM feed_items WHERE feed_key = ?',
      feedKey
    );
    let position = (maxRow?.max_pos ?? -1) + 1;
    const now = Date.now();

    // Insert new items (IGNORE duplicates via PRIMARY KEY)
    for (const post of posts) {
      const postId = post?.id || post?._id?.toString();
      if (!postId) continue;

      const result = db.runSync(
        'INSERT OR IGNORE INTO feed_items (feed_key, post_id, position, slice_json, inserted_at) VALUES (?, ?, ?, ?, ?)',
        feedKey, postId, position, null, now
      );
      // Only advance position if the insert actually happened
      if (result.changes > 0) {
        position++;
      }
    }

    // Update meta
    if (meta.hasMore !== undefined || meta.nextCursor !== undefined || meta.totalCount !== undefined) {
      const currentMeta = db.getFirstSync<FeedMetaRow>(
        'SELECT * FROM feed_meta WHERE feed_key = ?',
        feedKey
      );

      db.runSync(
        `INSERT OR REPLACE INTO feed_meta (feed_key, has_more, next_cursor, total_count, last_updated, filters_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        feedKey,
        meta.hasMore !== undefined ? (meta.hasMore ? 1 : 0) : (currentMeta?.has_more ?? 1),
        meta.nextCursor !== undefined ? (meta.nextCursor || null) : (currentMeta?.next_cursor || null),
        meta.totalCount !== undefined ? meta.totalCount : (currentMeta?.total_count ?? 0),
        now,
        meta.filters ? JSON.stringify(meta.filters) : (currentMeta?.filters_json || null)
      );
    }

    db.execSync('COMMIT');
  } catch (error) {
    db.execSync('ROLLBACK');
    logger.error(`Failed to append feed items for ${feedKey}`, { error });
  }
}

// ── Read operations ──────────────────────────────────────────────

/**
 * Get feed items ordered by position.
 * Returns full FeedItem objects by joining with the posts table.
 */
export function getFeedItems(
  feedKey: string,
  offset: number = 0,
  limit: number = 100
): FeedItem[] {
  if (!feedKey) return [];

  const db = getDb();
  if (!db) return [];
  const rows = db.getAllSync<any>(
    `SELECT p.* FROM feed_items fi
     JOIN posts p ON p.id = fi.post_id
     WHERE fi.feed_key = ?
     ORDER BY fi.position ASC
     LIMIT ? OFFSET ?`,
    feedKey, limit, offset
  );

  return rows.map(rowToFeedItem);
}

/**
 * Get all feed items for a feed (no limit).
 * Use sparingly — prefer paginated reads for large feeds.
 */
export function getAllFeedItems(feedKey: string): FeedItem[] {
  if (!feedKey) return [];

  const db = getDb();
  if (!db) return [];
  const rows = db.getAllSync<any>(
    `SELECT p.* FROM feed_items fi
     JOIN posts p ON p.id = fi.post_id
     WHERE fi.feed_key = ?
     ORDER BY fi.position ASC`,
    feedKey
  );

  return rows.map(rowToFeedItem);
}

/**
 * Get feed item count for a feed key.
 */
export function getFeedItemCount(feedKey: string): number {
  if (!feedKey) return 0;
  const db = getDb();
  if (!db) return 0;
  const row = db.getFirstSync<{ count: number }>(
    'SELECT COUNT(*) as count FROM feed_items WHERE feed_key = ?',
    feedKey
  );
  return row?.count ?? 0;
}

/**
 * Get feed metadata.
 */
export function getFeedMeta(feedKey: string): FeedMetaData | null {
  if (!feedKey) return null;

  const db = getDb();
  if (!db) return null;
  const row = db.getFirstSync<FeedMetaRow>(
    'SELECT * FROM feed_meta WHERE feed_key = ?',
    feedKey
  );

  if (!row) return null;

  return {
    hasMore: Boolean(row.has_more),
    nextCursor: row.next_cursor || undefined,
    totalCount: row.total_count,
    lastUpdated: row.last_updated,
    filters: safeJsonParse(row.filters_json, undefined),
  };
}

/**
 * Check if a feed has any cached data.
 */
export function hasFeedData(feedKey: string): boolean {
  if (!feedKey) return false;
  const db = getDb();
  if (!db) return false;
  const row = db.getFirstSync<{ exists: number }>(
    'SELECT EXISTS(SELECT 1 FROM feed_items WHERE feed_key = ?) as exists',
    feedKey
  );
  return Boolean(row?.exists);
}

/**
 * Get all feed keys in the database.
 */
export function getFeedKeys(): string[] {
  const db = getDb();
  if (!db) return [];
  const rows = db.getAllSync<{ feed_key: string }>(
    'SELECT DISTINCT feed_key FROM feed_meta ORDER BY last_updated DESC'
  );
  return rows.map((r) => r.feed_key);
}

// ── Mutation operations ──────────────────────────────────────────

/**
 * Update feed metadata without touching items.
 */
export function updateFeedMeta(feedKey: string, updates: Partial<FeedMetaData>): void {
  if (!feedKey) return;

  const db = getDb();
  if (!db) return;
  const current = db.getFirstSync<FeedMetaRow>(
    'SELECT * FROM feed_meta WHERE feed_key = ?',
    feedKey
  );

  db.runSync(
    `INSERT OR REPLACE INTO feed_meta (feed_key, has_more, next_cursor, total_count, last_updated, filters_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    feedKey,
    updates.hasMore !== undefined ? (updates.hasMore ? 1 : 0) : (current?.has_more ?? 1),
    updates.nextCursor !== undefined ? (updates.nextCursor || null) : (current?.next_cursor || null),
    updates.totalCount ?? current?.total_count ?? 0,
    updates.lastUpdated ?? Date.now(),
    updates.filters ? JSON.stringify(updates.filters) : (current?.filters_json || null)
  );
}

/**
 * Remove a single post from a feed.
 */
export function removeFeedItem(feedKey: string, postId: string): void {
  if (!feedKey || !postId) return;
  const db = getDb();
  if (!db) return;
  db.runSync('DELETE FROM feed_items WHERE feed_key = ? AND post_id = ?', feedKey, postId);
}

/**
 * Add a post at the start of a feed (for new posts).
 * Only shifts positions and increments count if the insert succeeds (not a duplicate).
 */
export function addFeedItemAtStart(feedKey: string, postId: string): void {
  if (!feedKey || !postId) return;

  const db = getDb();
  if (!db) return;

  try {
    db.execSync('BEGIN TRANSACTION');

    // Check if post already exists in this feed
    const existing = db.getFirstSync<{ post_id: string }>(
      'SELECT post_id FROM feed_items WHERE feed_key = ? AND post_id = ?',
      feedKey, postId
    );

    if (!existing) {
      // Shift all existing positions up by 1
      db.runSync(
        'UPDATE feed_items SET position = position + 1 WHERE feed_key = ?',
        feedKey
      );

      // Insert at position 0
      db.runSync(
        'INSERT INTO feed_items (feed_key, post_id, position, slice_json, inserted_at) VALUES (?, ?, 0, NULL, ?)',
        feedKey, postId, Date.now()
      );

      // Update total count in meta
      db.runSync(
        'UPDATE feed_meta SET total_count = total_count + 1 WHERE feed_key = ?',
        feedKey
      );
    }

    db.execSync('COMMIT');
  } catch (error) {
    db.execSync('ROLLBACK');
    logger.error(`Failed to add feed item at start for ${feedKey}`, { error });
  }
}

/**
 * Remove a post from ALL feeds.
 */
export function removePostFromAllFeeds(postId: string): void {
  if (!postId) return;
  const db = getDb();
  if (!db) return;
  db.runSync('DELETE FROM feed_items WHERE post_id = ?', postId);
}

// ── Clear operations ─────────────────────────────────────────────

/**
 * Clear a single feed (items + meta).
 */
export function clearFeed(feedKey: string): void {
  if (!feedKey) return;
  const db = getDb();
  if (!db) return;
  try {
    db.execSync('BEGIN TRANSACTION');
    db.runSync('DELETE FROM feed_items WHERE feed_key = ?', feedKey);
    db.runSync('DELETE FROM feed_meta WHERE feed_key = ?', feedKey);
    db.execSync('COMMIT');
  } catch (error) {
    db.execSync('ROLLBACK');
    logger.error(`Failed to clear feed ${feedKey}`, { error });
  }
}

/**
 * Clear all feeds.
 */
export function clearAllFeeds(): void {
  const db = getDb();
  if (!db) return;
  try {
    db.execSync('BEGIN TRANSACTION');
    db.execSync('DELETE FROM feed_items');
    db.execSync('DELETE FROM feed_meta');
    db.execSync('COMMIT');
  } catch (error) {
    db.execSync('ROLLBACK');
    logger.error('Failed to clear all feeds', { error });
  }
}

// Re-export the key builder
export { buildFeedKey };
