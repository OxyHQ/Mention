import FederatedMediaCache, {
  type FederatedMediaCacheState,
  type IFederatedMediaCache,
} from '../../models/FederatedMediaCache';
import { logger } from '../../utils/logger';

/**
 * Database-side operations for the federated media cache. These are the calls
 * the proxy read-path makes synchronously; they never touch the network and are
 * always safe to run regardless of whether the write side (worker/eviction) is
 * enabled.
 */

/** Minimal projection returned to the proxy for its serve decision. */
export interface CacheRow {
  state: FederatedMediaCacheState;
  oxyFileId?: string;
  posterFileId?: string;
}

/** Look up the current cache row for a remote URL (lean, projected). */
export async function lookupCacheRow(remoteUrl: string): Promise<CacheRow | undefined> {
  const row = await FederatedMediaCache.findOne(
    { remoteUrl },
    { state: 1, oxyFileId: 1, posterFileId: 1 },
  ).lean<Pick<IFederatedMediaCache, 'state' | 'oxyFileId' | 'posterFileId'>>();

  if (!row) return undefined;
  return {
    state: row.state,
    oxyFileId: row.oxyFileId ?? undefined,
    posterFileId: row.posterFileId ?? undefined,
  };
}

/** Bump `lastAccessedAt` for a cached URL without blocking the response. */
export async function bumpAccess(remoteUrl: string): Promise<void> {
  await FederatedMediaCache.updateOne(
    { remoteUrl },
    { $set: { lastAccessedAt: new Date() } },
  ).catch((error: unknown) => {
    logger.warn('[MediaCache] Failed to bump lastAccessedAt', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  });
}

/**
 * Record activity on a remote URL and ensure a cache attempt is scheduled.
 *
 * Idempotent and safe under concurrency:
 *  - No row → insert a `pending` row (the worker will pick it up).
 *  - `evicted`/`failed` row → flip back to `pending` so it re-caches on access.
 *  - `pending`/`cached` row → only bump `lastAccessedAt` (no state churn, no
 *    double-enqueue of an in-flight job).
 *
 * Returns whether a fresh attempt was (re)scheduled, for logging/metrics.
 */
export async function recordAccessAndMaybeEnqueue(remoteUrl: string): Promise<boolean> {
  const now = new Date();

  // Re-arm terminal/idle states to pending; clears any backoff so the worker
  // re-attempts promptly on renewed activity.
  const reArm = await FederatedMediaCache.updateOne(
    { remoteUrl, state: { $in: ['evicted', 'failed'] } },
    {
      $set: { state: 'pending', lastAccessedAt: now, failCount: 0 },
      $unset: { nextAttemptAt: '' },
    },
  );
  if (reArm.modifiedCount > 0) return true;

  // Bump access on an existing pending/cached row (no enqueue).
  const bumped = await FederatedMediaCache.updateOne(
    { remoteUrl, state: { $in: ['pending', 'cached'] } },
    { $set: { lastAccessedAt: now } },
  );
  if (bumped.matchedCount > 0) return false;

  // No row at all → create a pending one. `upsert` + the unique index make this
  // race-safe: a concurrent insert collides on the unique key and is swallowed
  // (we re-read is unnecessary — either way the URL is now pending).
  try {
    await FederatedMediaCache.updateOne(
      { remoteUrl },
      {
        $setOnInsert: {
          remoteUrl,
          state: 'pending',
          failCount: 0,
        },
        $set: { lastAccessedAt: now },
      },
      { upsert: true },
    );
    return true;
  } catch (error: unknown) {
    // Duplicate-key from a concurrent insert is benign; anything else is logged.
    const code = (error as { code?: number } | null)?.code;
    if (code === 11000) return true;
    logger.warn('[MediaCache] Failed to upsert pending cache entry', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
}
