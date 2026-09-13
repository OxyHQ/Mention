import { config } from '../config';
import { createCache } from '../utils/cache';
import type { PostRecord } from '../db/posts/postRecord';

/**
 * Redis-backed cache for the VIEWER-AGNOSTIC assembled {@link PostRecord} a
 * single-post/feed-item detail read starts from — the raw output of the
 * 9-table join `postRepository.ts` centralizes, before any per-viewer field
 * (liked/saved, ACL) is added.
 *
 * WHY THIS EXISTS — `GET /posts/:id` and `GET /feed/item/:id` re-assemble that
 * join from scratch on EVERY view, by EVERY viewer. A post is read far more
 * often than it is written, and a viral/shared post is read by many viewers at
 * once, so caching the assembly (not the per-viewer hydration, which still
 * runs on every request regardless — see `PostHydrationService.hydratePosts`)
 * collapses repeat views of the same post to a single Redis read.
 *
 * Design constraints:
 *  - Storage, TTL and the fail-open contract come from the shared
 *    {@link createCache} primitive.
 *  - Caches the record BEFORE per-viewer fields exist, so it can never leak
 *    one viewer's liked/saved/ACL state into another viewer's response.
 *  - `Date` fields (`createdAt`, `updatedAt`, `scheduledFor`,
 *    `lastCorrectedAt`, `postClassification.classifiedAt`) do not survive a
 *    JSON round trip as `Date` instances — {@link reviveDates} restores them on
 *    every cache HIT so a cached record is indistinguishable from one Drizzle
 *    just returned.
 *  - Engagement counters (`stats.*`) are NOT actively invalidated — a bumped
 *    counter simply ages out within the TTL. This mirrors `anonFeedCache`'s
 *    already-accepted staleness tradeoff, and engagement is already delivered
 *    live out-of-band via `postEngagementBroadcast.ts`, so the REST payload is
 *    not the frontend's only freshness source for those fields. Content edits,
 *    visibility changes, authorship changes and deletes DO invalidate — see
 *    {@link invalidate} and its call sites in `postRepository.ts`.
 */

const POST_DETAIL_PREFIX = 'postdetail:v1:';

function keyFor(postId: string): string {
  return `${POST_DETAIL_PREFIX}${postId}`;
}

const cache = createCache({ name: 'PostDetailCache', ttlSeconds: config.cache.postTTL });

/** Restore the `Date` fields `JSON.parse` hands back as ISO strings. */
function reviveDates(record: PostRecord): PostRecord {
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    scheduledFor: record.scheduledFor ? new Date(record.scheduledFor) : record.scheduledFor,
    lastCorrectedAt: record.lastCorrectedAt ? new Date(record.lastCorrectedAt) : record.lastCorrectedAt,
    postClassification: record.postClassification?.classifiedAt
      ? {
        ...record.postClassification,
        classifiedAt: new Date(record.postClassification.classifiedAt),
      }
      : record.postClassification,
  };
}

/**
 * Serve `postId`'s assembled record from cache, computing it (via `load`) at
 * most once per key across concurrent callers in this process — the burst a
 * viral post's simultaneous viewers produce collapses to one assembly.
 *
 * A miss (`load` resolving `null` — the post does not exist) is never cached:
 * a post created moments after a 404 must be visible on the very next read.
 */
export async function getOrLoadPostRecord(
  postId: string,
  load: () => Promise<PostRecord | null>,
): Promise<PostRecord | null> {
  const record = await cache.getOrCompute<PostRecord | null>(keyFor(postId), load, {
    ttlSecondsFor: (value) => (value === null ? null : config.cache.postTTL),
  });
  return record ? reviveDates(record) : null;
}

/**
 * Evict `postId`'s cached record so the next read re-assembles it. Called from
 * `postRepository.ts` wherever a write changes what `loadPostRecord` returns
 * for an EXISTING post (edit, authorship change, a scheduled post going live,
 * delete) — never from a counter bump, see the module doc above.
 */
export async function invalidate(postId: string): Promise<void> {
  await cache.delete([keyFor(postId)]);
}
