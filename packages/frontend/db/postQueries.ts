/**
 * Post queries — CRUD operations for the posts table.
 * 
 * All reads are synchronous (JSI). Writes use transactions for batch ops.
 * On web without SharedArrayBuffer, all functions gracefully no-op.
 */

import { getDb, isDbAvailable } from './database';
import { PostRow, FeedItem, postToRow, rowToFeedItem } from './schema';
import {
  memUpsertPost,
  memUpsertPosts,
  memGetPostById,
  memGetPostsByIds,
  memUpdatePost,
  memDeletePost,
} from './memoryStore';
import { createLogger } from '@oxyhq/core/logger';

const logger = createLogger('PostQueries');

// ── Prepared statement SQL ───────────────────────────────────────

const UPSERT_POST_SQL = `
  INSERT INTO posts (
    id, user_id, type, parent_post_id, original_post_id, quoted_post_id,
    content_json, attachments_json, link_previews_json, permissions_json,
    boost_json, context_json, user_json,
    likes_count, downvotes_count, boosts_count, replies_count,
    saves_count, views_count, impressions_count,
    is_liked, is_downvoted, is_boosted, is_saved, is_owner,
    visibility, created_at, updated_at, fetched_at, raw_json
  ) VALUES (
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?
  )
  ON CONFLICT(id) DO UPDATE SET
    user_id = excluded.user_id,
    type = excluded.type,
    parent_post_id = excluded.parent_post_id,
    original_post_id = excluded.original_post_id,
    quoted_post_id = excluded.quoted_post_id,
    content_json = excluded.content_json,
    attachments_json = excluded.attachments_json,
    link_previews_json = excluded.link_previews_json,
    permissions_json = excluded.permissions_json,
    boost_json = excluded.boost_json,
    context_json = excluded.context_json,
    user_json = excluded.user_json,
    likes_count = excluded.likes_count,
    downvotes_count = excluded.downvotes_count,
    boosts_count = excluded.boosts_count,
    replies_count = excluded.replies_count,
    saves_count = excluded.saves_count,
    views_count = excluded.views_count,
    impressions_count = excluded.impressions_count,
    is_liked = excluded.is_liked,
    is_downvoted = excluded.is_downvoted,
    is_boosted = excluded.is_boosted,
    is_saved = excluded.is_saved,
    is_owner = excluded.is_owner,
    visibility = excluded.visibility,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at,
    fetched_at = excluded.fetched_at,
    raw_json = excluded.raw_json
`;

// ── Single post operations ───────────────────────────────────────

/**
 * Insert or update a single post without replacing the SQLite row. `REPLACE`
 * deletes the old row before inserting the new one, which triggers the
 * `feed_items.post_id` cascade and removes the post from every native feed.
 */
export function upsertPost(post: FeedItem): void {
  if (!post.id) return;

  if (!isDbAvailable()) {
    memUpsertPost(post);
    return;
  }

  const row = postToRow(post);
  if (!row.id) return;

  const db = getDb();
  if (!db) return;
  db.runSync(
    UPSERT_POST_SQL,
    row.id, row.user_id, row.type, row.parent_post_id, row.original_post_id, row.quoted_post_id,
    row.content_json, row.attachments_json, row.link_previews_json, row.permissions_json,
    row.boost_json, row.context_json, row.user_json,
    row.likes_count, row.downvotes_count, row.boosts_count, row.replies_count,
    row.saves_count, row.views_count, row.impressions_count,
    row.is_liked, row.is_downvoted, row.is_boosted, row.is_saved, row.is_owner,
    row.visibility, row.created_at, row.updated_at, row.fetched_at, row.raw_json
  );
}

/**
 * Batch insert/update posts in a single transaction.
 */
export function upsertPosts(posts: FeedItem[]): void {
  if (!posts || posts.length === 0) return;

  if (!isDbAvailable()) {
    memUpsertPosts(posts);
    return;
  }

  const db = getDb();
  if (!db) return;
  try {
    db.execSync('BEGIN TRANSACTION');
    for (const post of posts) {
      if (!post.id) continue;
      const row = postToRow(post);
      if (!row.id) continue;

      db.runSync(
        UPSERT_POST_SQL,
        row.id, row.user_id, row.type, row.parent_post_id, row.original_post_id, row.quoted_post_id,
        row.content_json, row.attachments_json, row.link_previews_json, row.permissions_json,
        row.boost_json, row.context_json, row.user_json,
        row.likes_count, row.downvotes_count, row.boosts_count, row.replies_count,
        row.saves_count, row.views_count, row.impressions_count,
        row.is_liked, row.is_downvoted, row.is_boosted, row.is_saved, row.is_owner,
        row.visibility, row.created_at, row.updated_at, row.fetched_at, row.raw_json
      );
    }
    db.execSync('COMMIT');
  } catch (error) {
    db.execSync('ROLLBACK');
    logger.error('Failed to batch upsert posts', error);
    throw error;
  }
}

// ── Read operations ──────────────────────────────────────────────

/**
 * Get a single post by ID. Returns null if not found.
 */
export function getPostById(id: string): FeedItem | null {
  if (!id) return null;

  if (!isDbAvailable()) {
    return memGetPostById(id);
  }

  const db = getDb();
  if (!db) return null;
  const row = db.getFirstSync<PostRow>('SELECT * FROM posts WHERE id = ?', id);
  return row ? rowToFeedItem(row) : null;
}

/**
 * Get multiple posts by IDs. Returns a map of id -> FeedItem.
 */
export function getPostsByIds(ids: string[]): Record<string, FeedItem> {
  if (!ids || ids.length === 0) return {};

  if (!isDbAvailable()) {
    return memGetPostsByIds(ids);
  }

  const db = getDb();
  if (!db) return {};
  const result: Record<string, FeedItem> = {};

  // SQLite has a limit on the number of host parameters (default 999).
  // Batch in chunks of 500.
  const chunkSize = 500;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.getAllSync<PostRow>(
      `SELECT * FROM posts WHERE id IN (${placeholders})`,
      ...chunk
    );
    for (const row of rows) {
      const item = rowToFeedItem(row);
      if (item) result[row.id] = item;
    }
  }

  return result;
}

// ── Update operations ────────────────────────────────────────────

/**
 * Atomic read-modify-write for a single post.
 * Uses BEGIN IMMEDIATE for serialized access.
 * Returns the updated FeedItem or null if post not found.
 */
export function updatePost(
  id: string,
  updater: (prev: FeedItem) => FeedItem | null | undefined
): FeedItem | null {
  if (!id) return null;

  if (!isDbAvailable()) {
    return memUpdatePost(id, updater);
  }

  const db = getDb();
  if (!db) {
    // Fallback: non-transactional path for web
    const current = getPostById(id);
    if (!current) return null;
    const updated = updater(current);
    if (!updated) return null;
    upsertPost(updated);
    return updated;
  }

  try {
    db.execSync('BEGIN IMMEDIATE');
    const row = db.getFirstSync<PostRow>('SELECT * FROM posts WHERE id = ?', id);
    if (!row) {
      db.execSync('ROLLBACK');
      return null;
    }
    const current = rowToFeedItem(row);
    if (!current) {
      db.execSync('ROLLBACK');
      return null;
    }
    const updated = updater(current);
    if (!updated) {
      db.execSync('ROLLBACK');
      return null;
    }

    const newRow = postToRow(updated);
    db.runSync(
      UPSERT_POST_SQL,
      newRow.id, newRow.user_id, newRow.type, newRow.parent_post_id, newRow.original_post_id, newRow.quoted_post_id,
      newRow.content_json, newRow.attachments_json, newRow.link_previews_json, newRow.permissions_json,
      newRow.boost_json, newRow.context_json, newRow.user_json,
      newRow.likes_count, newRow.downvotes_count, newRow.boosts_count, newRow.replies_count,
      newRow.saves_count, newRow.views_count, newRow.impressions_count,
      newRow.is_liked, newRow.is_downvoted, newRow.is_boosted, newRow.is_saved, newRow.is_owner,
      newRow.visibility, newRow.created_at, newRow.updated_at, newRow.fetched_at, newRow.raw_json
    );
    db.execSync('COMMIT');
    return updated;
  } catch (error) {
    try {
      db.execSync('ROLLBACK');
    } catch (rollbackError) {
      // The transaction was already closed (or never opened) — nothing left to
      // undo, but a rollback that fails for any other reason is worth seeing.
      logger.debug('Rollback after a failed post update did not apply', { error: rollbackError });
    }
    logger.error(`Failed to update post ${id} in place`, error);
    return null;
  }
}

// ── Delete operations ────────────────────────────────────────────

/**
 * Delete a single post by ID.
 */
export function deletePost(id: string): void {
  if (!id) return;

  if (!isDbAvailable()) {
    memDeletePost(id);
    return;
  }

  const db = getDb();
  if (!db) return;
  db.runSync('DELETE FROM posts WHERE id = ?', id);
}

/**
 * Prune old posts not referenced by any feed.
 * Keeps posts younger than maxAgeMs regardless.
 */
export function pruneOldPosts(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
  const cutoff = Date.now() - maxAgeMs;
  const db = getDb();
  if (!db) return 0;

  const result = db.runSync(
    `DELETE FROM posts WHERE fetched_at < ? AND id NOT IN (SELECT post_id FROM feed_items)`,
    cutoff
  );

  const deleted = result.changes;
  if (deleted > 0) {
    logger.debug(`Pruned ${deleted} old posts`);
    // VACUUM after large deletions
    if (deleted > 1000) {
      try {
        db.execSync('VACUUM');
        logger.debug('VACUUM completed after large prune');
      } catch (e) {
        logger.error('VACUUM failed', e);
      }
    }
  }

  return deleted;
}

/**
 * Count total posts in cache.
 */
export function countPosts(): number {
  const db = getDb();
  if (!db) return 0;
  const row = db.getFirstSync<{ count: number }>('SELECT COUNT(*) as count FROM posts');
  return row?.count ?? 0;
}
