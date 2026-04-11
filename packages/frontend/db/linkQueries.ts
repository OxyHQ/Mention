/**
 * Link preview queries — CRUD for the link_previews table.
 */

import { getDb } from './database';
import type { LinkPreviewRow } from './schema';
import { linkMetadataToRow, rowToLinkMetadata } from './schema';
import type { LinkMetadata } from '@/stores/linksStore';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('LinkQueries');

// ── URL normalization ────────────────────────────────────────────

function normalizeUrl(url: string): string | null {
  if (!url || typeof url !== 'string') return null;
  let normalized = url.trim();
  if (!normalized) return null;

  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`;
  }

  try {
    const parsed = new URL(normalized);
    const path = parsed.pathname.endsWith('/') && parsed.pathname !== '/'
      ? parsed.pathname.slice(0, -1)
      : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${path}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

// ── Write operations ─────────────────────────────────────────────

/**
 * Insert or replace a link preview.
 */
export function upsertLink(metadata: LinkMetadata): void {
  if (!metadata?.url) return;
  const url = normalizeUrl(metadata.url);
  if (!url) return;

  const row = linkMetadataToRow({ ...metadata, url });
  const db = getDb();

  db.runSync(
    `INSERT OR REPLACE INTO link_previews (url, title, description, image, site_name, favicon, error, fetched_at, ttl_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.url, row.title, row.description, row.image, row.site_name, row.favicon, row.error, row.fetched_at, row.ttl_ms
  );
}

// ── Read operations ──────────────────────────────────────────────

/**
 * Get a cached link preview. Returns null if not found or expired.
 */
export function getLink(url: string): LinkMetadata | null {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;

  const db = getDb();
  const row = db.getFirstSync<LinkPreviewRow>(
    'SELECT * FROM link_previews WHERE url = ?',
    normalized
  );

  if (!row) return null;

  // Check expiration
  if (Date.now() - row.fetched_at > row.ttl_ms) {
    // Expired — lazily delete
    db.runSync('DELETE FROM link_previews WHERE url = ?', normalized);
    return null;
  }

  return rowToLinkMetadata(row);
}

/**
 * Check if a link is cached and still valid.
 */
export function isLinkCached(url: string): boolean {
  const normalized = normalizeUrl(url);
  if (!normalized) return false;

  const db = getDb();
  const row = db.getFirstSync<{ fetched_at: number; ttl_ms: number }>(
    'SELECT fetched_at, ttl_ms FROM link_previews WHERE url = ?',
    normalized
  );

  if (!row) return false;
  return Date.now() - row.fetched_at <= row.ttl_ms;
}

// ── Cleanup operations ───────────────────────────────────────────

/**
 * Delete all expired link previews.
 */
export function pruneExpiredLinks(): number {
  const db = getDb();
  const now = Date.now();

  const result = db.runSync(
    'DELETE FROM link_previews WHERE (fetched_at + ttl_ms) < ?',
    now
  );

  const deleted = result.changes;
  if (deleted > 0) {
    logger.debug(`Pruned ${deleted} expired link previews`);
  }
  return deleted;
}

/**
 * Clear all link previews.
 */
export function clearAllLinks(): void {
  const db = getDb();
  db.execSync('DELETE FROM link_previews');
}

/**
 * Invalidate a single URL.
 */
export function invalidateLink(url: string): void {
  const normalized = normalizeUrl(url);
  if (!normalized) return;
  const db = getDb();
  db.runSync('DELETE FROM link_previews WHERE url = ?', normalized);
}
