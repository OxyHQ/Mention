/**
 * `federated_media_cache` — the activity-based S3 cache for remote media.
 *
 * Three callers, and they do not share a failure posture, so the return types
 * here are deliberately not uniform:
 *
 *  - The **proxy read path** (`mediaCache/cacheStore.ts`) runs inside a user's
 *    request. A wrong answer costs a cache hit and the user sees a slower
 *    response, so it fails soft.
 *  - The **worker** and the **eviction job** are unattended background sweeps.
 *    Nothing is watching them, and both of their empty answers ("no entry is
 *    due", "nothing is evictable") are indistinguishable from a healthy idle
 *    run — so nothing here converts a failure into an empty result. A query
 *    that cannot answer throws and the sweep's own logging reports it.
 *
 * `remote_url` is the cache key and is never rewritten; `id` exists only so the
 * purge script has a stable paging key.
 */

import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import {
  FEDERATED_MEDIA_CACHE_STATES,
  federatedMediaCache,
} from '../schema/federation';

/** Lifecycle state of one remote media URL. See `db/schema/federation.ts`. */
export type FederatedMediaCacheState = (typeof FEDERATED_MEDIA_CACHE_STATES)[number];

/** The projection the proxy needs to decide how to serve a URL. */
export interface MediaCacheServeRow {
  state: FederatedMediaCacheState;
  oxyFileId?: string;
  posterFileId?: string;
  contentType?: string;
}

/** The projection the eviction job needs to release an entry's S3 objects. */
export interface MediaCacheEvictionCandidate {
  remoteUrl: string;
  oxyFileId?: string;
  posterFileId?: string;
}

/** The projection the purge script needs to release an entry's S3 objects. */
export interface MediaCacheFileRow {
  remoteUrl: string;
  oxyFileId?: string;
  posterFileId?: string;
}

/** What the media cache newly stored for a URL. */
export interface CachedMediaFacts {
  oxyFileId: string;
  posterFileId?: string;
  contentType: string;
  sizeBytes: number;
}

/** `null` columns reach the application as `undefined`, matching the old DTOs. */
function optional(value: string | null): string | undefined {
  return value ?? undefined;
}

/** The current cache row for a remote URL, or `undefined` when there is none. */
export async function lookupMediaCacheRow(
  remoteUrl: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<MediaCacheServeRow | undefined> {
  const [row] = await db
    .select({
      state: federatedMediaCache.state,
      oxyFileId: federatedMediaCache.oxyFileId,
      posterFileId: federatedMediaCache.posterFileId,
      contentType: federatedMediaCache.contentType,
    })
    .from(federatedMediaCache)
    .where(eq(federatedMediaCache.remoteUrl, remoteUrl))
    .limit(1);

  if (!row) return undefined;
  return {
    state: row.state,
    oxyFileId: optional(row.oxyFileId),
    posterFileId: optional(row.posterFileId),
    contentType: optional(row.contentType),
  };
}

/** Bump `last_accessed_at` on an existing row. A missing row is a no-op. */
export async function touchMediaCacheAccess(
  remoteUrl: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(federatedMediaCache)
    .set({ lastAccessedAt: new Date() })
    .where(eq(federatedMediaCache.remoteUrl, remoteUrl));
}

/**
 * Record activity on a remote URL and ensure a cache attempt is scheduled.
 *
 * Idempotent and safe under concurrency:
 *  - `pending`/`cached` row → only bump `last_accessed_at` (no state churn, no
 *    double-enqueue of an in-flight job).
 *  - `evicted`/`failed` row → flip back to `pending` so it re-caches on access,
 *    clearing the backoff so the worker retries promptly.
 *  - No row → insert a `pending` one.
 *
 * The three branches partition the four states, so the order only reorders
 * disjoint cases — the hot path is tried first. The insert is
 * `ON CONFLICT DO UPDATE` rather than a caught duplicate-key error: a
 * concurrent insert between the second branch and the third is the only way to
 * reach a conflict, and either way the URL ends up pending with its access
 * recorded.
 *
 * @returns Whether a fresh cache attempt was (re)scheduled.
 */
export async function recordMediaCacheAccess(
  remoteUrl: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = new Date();

  const bumped = await db
    .update(federatedMediaCache)
    .set({ lastAccessedAt: now })
    .where(
      and(
        eq(federatedMediaCache.remoteUrl, remoteUrl),
        inArray(federatedMediaCache.state, ['pending', 'cached']),
      ),
    )
    .returning({ id: federatedMediaCache.id });
  if (bumped.length > 0) return false;

  const reArmed = await db
    .update(federatedMediaCache)
    .set({ state: 'pending', lastAccessedAt: now, failCount: 0, nextAttemptAt: null })
    .where(
      and(
        eq(federatedMediaCache.remoteUrl, remoteUrl),
        inArray(federatedMediaCache.state, ['evicted', 'failed']),
      ),
    )
    .returning({ id: federatedMediaCache.id });
  if (reArmed.length > 0) return true;

  await db
    .insert(federatedMediaCache)
    .values({ remoteUrl, state: 'pending', failCount: 0, lastAccessedAt: now })
    .onConflictDoUpdate({
      target: federatedMediaCache.remoteUrl,
      set: { lastAccessedAt: now },
    });
  return true;
}

/** Mark a URL permanently un-cacheable; the proxy stays in remote-stream mode. */
export async function markMediaCacheFailed(
  remoteUrl: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(federatedMediaCache)
    .set({ state: 'failed', nextAttemptAt: null })
    .where(eq(federatedMediaCache.remoteUrl, remoteUrl));
}

/**
 * Mark a URL cached, recording what was stored.
 *
 * `poster_file_id` is written UNCONDITIONALLY, including as `null` when this
 * attempt produced no poster. The row describes the bytes that are in S3 right
 * now, so leaving a previous attempt's poster id in place would point at an
 * object this entry no longer owns.
 */
export async function markMediaCacheCached(
  remoteUrl: string,
  facts: CachedMediaFacts,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(federatedMediaCache)
    .set({
      state: 'cached',
      oxyFileId: facts.oxyFileId,
      posterFileId: facts.posterFileId ?? null,
      contentType: facts.contentType,
      sizeBytes: facts.sizeBytes,
      cachedAt: new Date(),
      failCount: 0,
      nextAttemptAt: null,
    })
    .where(eq(federatedMediaCache.remoteUrl, remoteUrl));
}

/**
 * Increment `fail_count` and return the new value.
 *
 * @returns The incremented count, or `null` when no row matched — which the
 *   caller must treat as "the row went away", never as a count of zero.
 */
export async function incrementMediaCacheFailCount(
  remoteUrl: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number | null> {
  const [row] = await db
    .update(federatedMediaCache)
    .set({ failCount: sql`${federatedMediaCache.failCount} + 1` })
    .where(eq(federatedMediaCache.remoteUrl, remoteUrl))
    .returning({ failCount: federatedMediaCache.failCount });
  return row?.failCount ?? null;
}

/** Hold a URL back from the worker until `nextAttemptAt`. */
export async function scheduleMediaCacheRetry(
  remoteUrl: string,
  nextAttemptAt: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(federatedMediaCache)
    .set({ nextAttemptAt })
    .where(eq(federatedMediaCache.remoteUrl, remoteUrl));
}

/**
 * The `pending` URLs whose backoff has elapsed, most recently accessed first.
 *
 * A row that has never been attempted has a `null` `next_attempt_at` and is due
 * immediately — in Mongo that was three alternatives (`<= now`, explicit null,
 * field absent); Postgres has no absent column, so it is two.
 */
export async function findDueMediaCacheEntries(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ remoteUrl: federatedMediaCache.remoteUrl })
    .from(federatedMediaCache)
    .where(
      and(
        eq(federatedMediaCache.state, 'pending'),
        or(
          lte(federatedMediaCache.nextAttemptAt, new Date()),
          isNull(federatedMediaCache.nextAttemptAt),
        ),
      ),
    )
    .orderBy(desc(federatedMediaCache.lastAccessedAt))
    .limit(limit);
  return rows.map((row) => row.remoteUrl);
}

/** `cached` entries idle since before `cutoff`, oldest access first. */
export async function findEvictableMediaCacheEntries(
  cutoff: Date,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<MediaCacheEvictionCandidate[]> {
  const rows = await db
    .select({
      remoteUrl: federatedMediaCache.remoteUrl,
      oxyFileId: federatedMediaCache.oxyFileId,
      posterFileId: federatedMediaCache.posterFileId,
    })
    .from(federatedMediaCache)
    .where(
      and(
        eq(federatedMediaCache.state, 'cached'),
        lt(federatedMediaCache.lastAccessedAt, cutoff),
      ),
    )
    .orderBy(asc(federatedMediaCache.lastAccessedAt))
    .limit(limit);

  return rows.map((row) => ({
    remoteUrl: row.remoteUrl,
    oxyFileId: optional(row.oxyFileId),
    posterFileId: optional(row.posterFileId),
  }));
}

/**
 * Transition a `cached` entry to `evicted`, clearing what described the bytes.
 *
 * The row is KEPT so a later access re-enqueues it rather than re-discovering
 * the URL. The `state = 'cached'` term is what keeps this safe against an entry
 * that was re-cached between the sweep's read and this write.
 */
export async function markMediaCacheEvicted(
  remoteUrl: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(federatedMediaCache)
    .set({
      state: 'evicted',
      oxyFileId: null,
      posterFileId: null,
      cachedAt: null,
      sizeBytes: null,
    })
    .where(
      and(
        eq(federatedMediaCache.remoteUrl, remoteUrl),
        eq(federatedMediaCache.state, 'cached'),
      ),
    );
}

/** The rows for a batch of URLs, with the file ids the purge script must release. */
export async function findMediaCacheRowsByUrls(
  remoteUrls: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<MediaCacheFileRow[]> {
  if (remoteUrls.length === 0) return [];
  const rows = await db
    .select({
      remoteUrl: federatedMediaCache.remoteUrl,
      oxyFileId: federatedMediaCache.oxyFileId,
      posterFileId: federatedMediaCache.posterFileId,
    })
    .from(federatedMediaCache)
    .where(inArray(federatedMediaCache.remoteUrl, [...remoteUrls]));

  return rows.map((row) => ({
    remoteUrl: row.remoteUrl,
    oxyFileId: optional(row.oxyFileId),
    posterFileId: optional(row.posterFileId),
  }));
}

/** How many rows a delete of these URLs would remove. Used by `DRY_RUN`. */
export async function countMediaCacheRowsByUrls(
  remoteUrls: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  if (remoteUrls.length === 0) return 0;
  const rows = await db
    .select({ id: federatedMediaCache.id })
    .from(federatedMediaCache)
    .where(inArray(federatedMediaCache.remoteUrl, [...remoteUrls]));
  return rows.length;
}

/** Remove the rows for these URLs. Returns how many were removed. */
export async function deleteMediaCacheRowsByUrls(
  remoteUrls: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  if (remoteUrls.length === 0) return 0;
  const removed = await db
    .delete(federatedMediaCache)
    .where(inArray(federatedMediaCache.remoteUrl, [...remoteUrls]))
    .returning({ id: federatedMediaCache.id });
  return removed.length;
}

/**
 * One `id`-ordered page of the whole table, for the purge script's sweep.
 *
 * `id` is `text` holding an ObjectId hex OR a uuid v7 (`@oxyhq/db`), so this
 * order is NOT chronological — but a keyset scan only needs a total order that
 * agrees between `>` and `ORDER BY`, which it does, and this phase sweeps the
 * whole table rather than reading recency off it.
 */
export async function pageMediaCacheRows(
  afterId: string | null,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<Array<{ id: string; remoteUrl: string }>> {
  return db
    .select({ id: federatedMediaCache.id, remoteUrl: federatedMediaCache.remoteUrl })
    .from(federatedMediaCache)
    .where(afterId === null ? undefined : gt(federatedMediaCache.id, afterId))
    .orderBy(asc(federatedMediaCache.id))
    .limit(limit);
}
