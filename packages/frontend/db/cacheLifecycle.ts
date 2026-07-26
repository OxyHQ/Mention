import { getDb, resetDb, type SQLiteDb } from './database';
import { memClearAll } from './memoryStore';
import { createScopedLogger } from '@/lib/logger';

const VIEWER_OWNER_KEY = 'viewer_id';
const ANONYMOUS_VIEWER_ID = 'anon';
const BROWSER_VIEWER_OWNER_KEY = 'mention.viewer-cache-owner.v1';
const logger = createScopedLogger('ViewerCache');

let activeViewerId: string | null = null;

export interface ViewerCacheClaim {
  /**
   * True when the persisted cache did not already belong to this viewer and
   * was wiped before the claim was written.
   */
  reset: boolean;
  /** Previous persisted owner, when this build could identify one. */
  previousViewerId: string | null;
  /**
   * False only when SQLite remained readable but could not be wiped. Callers
   * must keep viewer-dependent descendants unmounted in that case.
   */
  trusted: boolean;
}

function normalizeViewerId(viewerId: string | null | undefined): string {
  const normalized = viewerId?.trim();
  return normalized ? normalized : ANONYMOUS_VIEWER_ID;
}

function getBrowserStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === 'undefined'
      ? null
      : globalThis.localStorage;
  } catch {
    return null;
  }
}

function readViewerOwner(db: SQLiteDb): string | null {
  return db.getFirstSync<{ value: string }>(
    'SELECT value FROM cache_metadata WHERE key = ?',
    VIEWER_OWNER_KEY,
  )?.value ?? null;
}

function writeViewerOwner(db: SQLiteDb, viewerId: string): void {
  db.runSync(
    'INSERT OR REPLACE INTO cache_metadata (key, value) VALUES (?, ?)',
    VIEWER_OWNER_KEY,
    viewerId,
  );
}

/**
 * Delete every persisted response as one SQLite transaction and atomically
 * assign the now-empty cache to its next viewer.
 */
function replaceViewerOwner(db: SQLiteDb, viewerId: string): void {
  db.execSync('BEGIN IMMEDIATE');
  try {
    db.execSync(`
      DELETE FROM feed_items;
      DELETE FROM feed_meta;
      DELETE FROM posts;
      DELETE FROM link_previews;
      DELETE FROM cache_metadata;
    `);
    writeViewerOwner(db, viewerId);
    db.execSync('COMMIT');
  } catch (error) {
    try {
      db.execSync('ROLLBACK');
    } catch {
      // Preserve the original failure; resetDb() below is the recovery path.
    }
    throw error;
  }
}

/**
 * Claim all post/feed persistence for one resolved auth identity.
 *
 * A missing owner is intentionally treated as untrusted. That covers both
 * pre-v4 databases and interrupted/corrupt metadata writes: no legacy row may
 * be painted before the current viewer has been established.
 *
 * This function is synchronous so AccountSwitchReset can call it from a layout
 * effect while descendants remain unmounted.
 */
export function claimViewerCache(
  viewerId: string | null | undefined,
): ViewerCacheClaim {
  const nextViewerId = normalizeViewerId(viewerId);
  const db = getDb();

  // Web is deliberately network-only. Its fallback maps are process-local, but
  // localStorage keeps the owner marker across a cold navigation/reload so a
  // browser cannot restore A-owned persisted stores while signed in as B.
  if (!db) {
    const browserStorage = getBrowserStorage();
    let previousViewerId = activeViewerId;
    if (browserStorage) {
      try {
        previousViewerId =
          browserStorage.getItem(BROWSER_VIEWER_OWNER_KEY);
      } catch {
        // Fall back to the process marker below.
      }
    }
    const reset = previousViewerId !== nextViewerId;
    if (reset) memClearAll();
    if (browserStorage) {
      try {
        browserStorage.setItem(BROWSER_VIEWER_OWNER_KEY, nextViewerId);
      } catch {
        // The memory cache is still process-local and already safe.
      }
    }
    activeViewerId = nextViewerId;
    return { reset, previousViewerId, trusted: true };
  }

  let previousViewerId: string | null = null;
  try {
    previousViewerId = readViewerOwner(db);
    if (previousViewerId === nextViewerId) {
      activeViewerId = nextViewerId;
      return { reset: false, previousViewerId, trusted: true };
    }

    memClearAll();
    replaceViewerOwner(db, nextViewerId);
  } catch (error) {
    // Fail closed if an old/corrupt schema cannot be cleared transactionally:
    // recreate the cache file, write the owner, and only then release renders.
    logger.error('Failed to replace viewer cache transactionally', { error });
    memClearAll();
    resetDb();
    const freshDb = getDb();
    if (freshDb) {
      try {
        replaceViewerOwner(freshDb, nextViewerId);
      } catch (recoveryError) {
        logger.error('Viewer cache recovery failed; keeping UI gated', {
          error: recoveryError,
        });
        activeViewerId = null;
        return {
          reset: true,
          previousViewerId,
          trusted: false,
        };
      }
    }
  }

  activeViewerId = nextViewerId;
  return { reset: true, previousViewerId, trusted: true };
}

/**
 * Synchronously clear all post/feed persistence at a viewer identity boundary.
 *
 * Native deletes the SQLite cache and web clears its process-local fallback.
 * Calling both is intentional: a native database initialization failure can
 * temporarily route reads through memory, and neither cache may survive A → B.
 */
export function clearAllCachedData(): void {
  memClearAll();
  resetDb();

  // Generic cache resets (corruption recovery, tests, manual refresh) should
  // not silently orphan later writes. Preserve the already-established viewer
  // claim; an identity transition will overwrite it synchronously.
  if (activeViewerId) {
    const db = getDb();
    if (db) {
      writeViewerOwner(db, activeViewerId);
    }
  }
}
