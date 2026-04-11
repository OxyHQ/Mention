/**
 * Actor (user) queries — CRUD operations for the actors table.
 * 
 * All reads are synchronous (JSI).
 */

import { getDb } from './database';
import type { ActorRow } from './schema';
import { actorToRow, rowToUserEntity } from './schema';
import type { UserEntity } from '@/stores/usersStore';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('ActorQueries');

// ── SQL ──────────────────────────────────────────────────────────

const UPSERT_ACTOR_SQL = `
  INSERT INTO actors (id, username, display_name, avatar_url, handle, is_verified, bio, badges_json, is_full, extra_json, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    username = COALESCE(excluded.username, actors.username),
    display_name = COALESCE(excluded.display_name, actors.display_name),
    avatar_url = COALESCE(excluded.avatar_url, actors.avatar_url),
    handle = COALESCE(excluded.handle, actors.handle),
    is_verified = CASE WHEN excluded.is_verified = 1 THEN 1 ELSE actors.is_verified END,
    bio = COALESCE(excluded.bio, actors.bio),
    badges_json = COALESCE(excluded.badges_json, actors.badges_json),
    is_full = CASE WHEN excluded.is_full = 1 THEN 1 ELSE actors.is_full END,
    extra_json = CASE WHEN excluded.is_full = 1 THEN excluded.extra_json ELSE COALESCE(excluded.extra_json, actors.extra_json) END,
    fetched_at = excluded.fetched_at
`;

// ── Write operations ─────────────────────────────────────────────

/**
 * Insert or update a single actor.
 * Uses COALESCE to preserve existing data — never overwrites with null.
 * The is_full flag is only upgraded (0->1), never downgraded.
 */
export function upsertActor(actor: UserEntity | any, isFull: boolean = false): void {
  const id = String(actor?.id || actor?._id || '');
  if (!id) return;

  const row = actorToRow(actor, isFull);
  if (!row.id) return;

  const db = getDb();
  if (!db) return;
  db.runSync(
    UPSERT_ACTOR_SQL,
    row.id, row.username, row.display_name, row.avatar_url, row.handle,
    row.is_verified, row.bio, row.badges_json, row.is_full, row.extra_json, row.fetched_at
  );
}

/**
 * Batch upsert actors in a single transaction.
 */
export function upsertManyActors(actors: (UserEntity | any)[], isFull: boolean = false): void {
  if (!actors || actors.length === 0) return;

  const db = getDb();
  if (!db) return;
  try {
    db.execSync('BEGIN TRANSACTION');
    for (const actor of actors) {
      const id = String(actor?.id || actor?._id || '');
      if (!id) continue;

      const row = actorToRow(actor, isFull);
      if (!row.id) continue;

      db.runSync(
        UPSERT_ACTOR_SQL,
        row.id, row.username, row.display_name, row.avatar_url, row.handle,
        row.is_verified, row.bio, row.badges_json, row.is_full, row.extra_json, row.fetched_at
      );
    }
    db.execSync('COMMIT');
  } catch (error) {
    db.execSync('ROLLBACK');
    logger.error('Failed to batch upsert actors', { error });
    throw error;
  }
}

/**
 * Prime actors from posts — extract embedded user objects.
 */
export function primeActorsFromPosts(posts: any[]): void {
  if (!Array.isArray(posts) || posts.length === 0) return;

  const users: any[] = [];
  for (const p of posts) {
    if (p?.user && (p.user.id || p.user._id)) users.push(p.user);
    if (p?.original?.user) users.push(p.original.user);
    if (p?.quoted?.user) users.push(p.quoted.user);
    if (p?.repostedBy) users.push(p.repostedBy);
    if (p?.repost?.actor) users.push(p.repost.actor);
  }

  if (users.length > 0) {
    upsertManyActors(users, false);
  }
}

// ── Read operations ──────────────────────────────────────────────

/**
 * Get actor by ID. Returns null if not found.
 */
export function getActorById(id: string): UserEntity | null {
  if (!id) return null;
  const db = getDb();
  if (!db) return null;
  const row = db.getFirstSync<ActorRow>('SELECT * FROM actors WHERE id = ?', id);
  return row ? rowToUserEntity(row) : null;
}

/**
 * Get actor by username. Case-insensitive.
 */
export function getActorByUsername(username: string): UserEntity | null {
  if (!username) return null;
  const db = getDb();
  if (!db) return null;
  const row = db.getFirstSync<ActorRow>(
    'SELECT * FROM actors WHERE LOWER(username) = LOWER(?) OR LOWER(handle) = LOWER(?)',
    username, username
  );
  return row ? rowToUserEntity(row) : null;
}

/**
 * Check if an actor's cached data is stale.
 */
export function isActorStale(id: string, ttlMs: number = 5 * 60 * 1000): boolean {
  if (!id) return true;
  const db = getDb();
  if (!db) return true;
  const row = db.getFirstSync<{ fetched_at: number; is_full: number }>(
    'SELECT fetched_at, is_full FROM actors WHERE id = ?',
    id
  );
  if (!row) return true;
  if (!row.is_full) return true; // Partial data always considered stale
  return Date.now() - row.fetched_at > ttlMs;
}

/**
 * Check if an actor exists and is a full profile.
 */
export function isActorFull(id: string): boolean {
  if (!id) return false;
  const db = getDb();
  if (!db) return false;
  const row = db.getFirstSync<{ is_full: number }>(
    'SELECT is_full FROM actors WHERE id = ?',
    id
  );
  return Boolean(row?.is_full);
}

// ── Delete operations ────────────────────────────────────────────

/**
 * Invalidate (delete) a single actor.
 */
export function invalidateActor(id: string): void {
  if (!id) return;
  const db = getDb();
  if (!db) return;
  db.runSync('DELETE FROM actors WHERE id = ?', id);
}

/**
 * Clear all actors.
 */
export function clearAllActors(): void {
  const db = getDb();
  if (!db) return;
  db.execSync('DELETE FROM actors');
}
