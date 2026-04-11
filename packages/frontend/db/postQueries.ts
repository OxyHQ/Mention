/**
 * Post queries — CRUD operations for the posts table.
 * 
 * All reads are synchronous (JSI). Writes use transactions for batch ops.
 * On web without SharedArrayBuffer, all functions gracefully no-op.
 */

import { getDb } from './database';
import { PostRow, FeedItem, postToRow, rowToFeedItem } from './schema';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('PostQueries');

// ── Prepared statement SQL ───────────────────────────────────────

const UPSERT_POST_SQL = `
  INSERT OR REPLACE INTO posts (
    id, user_id, type, parent_post_id, original_post_id, quoted_post_id,
    content_json, attachments_json, link_preview_json, permissions_json,
    repost_json, context_json, user_json,
    likes_count, downvotes_count, reposts_count, replies_count,
    saves_count, views_count, impressions_count,
    is_liked, is_downvoted, is_reposted, is_saved, is_owner,
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
`;

// ── Single post operations ───────────────────────────────────────

/**
 * Insert or replace a single post.
 */
export function upsertPost(post: FeedItem | any): void {
  if (!post?.id && !post?._id) return;
  const row = postToRow(post);
  if (!row.id) return;

  const db = getDb();
  if (!db) return;
  db.runSync(
    UPSERT_POST_SQL,
    row.id, row.user_id, row.type, row.parent_post_id, row.original_post_id, row.quoted_post_id,
    row.content_json, row.attachments_json, row.link_preview_json, row.permissions_json,
    row.repost_json, row.context_json, row.user_json,
    row.likes_count, row.downvotes_count, row.reposts_count, row.replies_count,
    row.saves_count, row.views_count, row.impressions_count,
    row.is_liked, row.is_downvoted, row.is_reposted, row.is_saved, row.is_owner,
    row.visibility, row.created_at, row.updated_at, row.fetched_at, row.raw_json
  );
}

/**
 * Batch insert/replace posts in a single transaction.
 */
export function upsertPosts(posts: (FeedItem | any)[]): void {
  if (!posts || posts.length === 0) return;

  const db = getDb();
  if (!db) return;
  try {
    db.execSync('BEGIN TRANSACTION');
    for (const post of posts) {
      if (!post?.id && !post?._id) continue;
      const row = postToRow(post);
      if (!row.id) continue;

      db.runSync(
        UPSERT_POST_SQL,
        row.id, row.user_id, row.type, row.parent_post_id, row.original_post_id, row.quoted_post_id,
        row.content_json, row.attachments_json, row.link_preview_json, row.permissions_json,
        row.repost_json, row.context_json, row.user_json,
        row.likes_count, row.downvotes_count, row.reposts_count, row.replies_count,
        row.saves_count, row.views_count, row.impressions_count,
        row.is_liked, row.is_downvoted, row.is_reposted, row.is_saved, row.is_owner,
        row.visibility, row.created_at, row.updated_at, row.fetched_at, row.raw_json
      );
    }
    db.execSync('COMMIT');
  } catch (error) {
    db.execSync('ROLLBACK');
    logger.error('Failed to batch upsert posts', { error });
    throw error;
  }
}

// ── Read operations ──────────────────────────────────────────────

/**
 * Get a single post by ID. Returns null if not found.
 */
export function getPostById(id: string): FeedItem | null {
  if (!id) return null;
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
      result[row.id] = rowToFeedItem(row);
    }
  }

  return result;
}

// ── Update operations ────────────────────────────────────────────

/**
 * Update engagement counts for a post.
 */
export function updateEngagement(
  id: string,
  engagement: {
    likes?: number;
    downvotes?: number;
    reposts?: number;
    replies?: number;
    saves?: number;
    views?: number;
    impressions?: number;
  }
): void {
  if (!id) return;

  const sets: string[] = [];
  const params: (string | number)[] = [];

  if (engagement.likes !== undefined) { sets.push('likes_count = ?'); params.push(engagement.likes); }
  if (engagement.downvotes !== undefined) { sets.push('downvotes_count = ?'); params.push(engagement.downvotes); }
  if (engagement.reposts !== undefined) { sets.push('reposts_count = ?'); params.push(engagement.reposts); }
  if (engagement.replies !== undefined) { sets.push('replies_count = ?'); params.push(engagement.replies); }
  if (engagement.saves !== undefined) { sets.push('saves_count = ?'); params.push(engagement.saves); }
  if (engagement.views !== undefined) { sets.push('views_count = ?'); params.push(engagement.views); }
  if (engagement.impressions !== undefined) { sets.push('impressions_count = ?'); params.push(engagement.impressions); }

  if (sets.length === 0) return;

  sets.push('fetched_at = ?');
  params.push(Date.now());
  params.push(id);

  const db = getDb();
  if (!db) return;
  db.runSync(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`, ...params);
}

/**
 * Update viewer state for a post.
 */
export function updateViewerState(
  id: string,
  state: {
    isLiked?: boolean;
    isDownvoted?: boolean;
    isReposted?: boolean;
    isSaved?: boolean;
    isOwner?: boolean;
  }
): void {
  if (!id) return;

  const sets: string[] = [];
  const params: (string | number)[] = [];

  if (state.isLiked !== undefined) { sets.push('is_liked = ?'); params.push(state.isLiked ? 1 : 0); }
  if (state.isDownvoted !== undefined) { sets.push('is_downvoted = ?'); params.push(state.isDownvoted ? 1 : 0); }
  if (state.isReposted !== undefined) { sets.push('is_reposted = ?'); params.push(state.isReposted ? 1 : 0); }
  if (state.isSaved !== undefined) { sets.push('is_saved = ?'); params.push(state.isSaved ? 1 : 0); }
  if (state.isOwner !== undefined) { sets.push('is_owner = ?'); params.push(state.isOwner ? 1 : 0); }

  if (sets.length === 0) return;

  params.push(id);

  const db = getDb();
  if (!db) return;
  db.runSync(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`, ...params);
}

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
    const updated = updater(current);
    if (!updated) {
      db.execSync('ROLLBACK');
      return null;
    }

    const newRow = postToRow(updated);
    db.runSync(
      UPSERT_POST_SQL,
      newRow.id, newRow.user_id, newRow.type, newRow.parent_post_id, newRow.original_post_id, newRow.quoted_post_id,
      newRow.content_json, newRow.attachments_json, newRow.link_preview_json, newRow.permissions_json,
      newRow.repost_json, newRow.context_json, newRow.user_json,
      newRow.likes_count, newRow.downvotes_count, newRow.reposts_count, newRow.replies_count,
      newRow.saves_count, newRow.views_count, newRow.impressions_count,
      newRow.is_liked, newRow.is_downvoted, newRow.is_reposted, newRow.is_saved, newRow.is_owner,
      newRow.visibility, newRow.created_at, newRow.updated_at, newRow.fetched_at, newRow.raw_json
    );
    db.execSync('COMMIT');
    return updated;
  } catch (e) {
    try { db.execSync('ROLLBACK'); } catch {}
    return null;
  }
}

// ── Delete operations ────────────────────────────────────────────

/**
 * Delete a single post by ID.
 */
export function deletePost(id: string): void {
  if (!id) return;
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
        logger.error('VACUUM failed', { error: e });
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
