/**
 * CURATOR FOLLOWER COUNTS — a dedicated, batched, non-recursive resolver for the
 * one input the starter-pack curation score needs about a CURATOR: how big their
 * audience is (`curatorAuthority`, see `services/starterPackCuration.ts`).
 *
 * WHY ITS OWN CACHE, SEPARATE FROM `usersummary:`:
 *
 * The obvious shortcut — reading the curator's follower count off the shared
 * identity cache (`usersummary:v4:`) — is wrong twice over:
 *  1. RECURSION. `usersummary:` entries are filled by
 *     `PostHydrationService.resolveUserSummaries`, which is exactly the function
 *     that computes curation scores. Resolving a curator through it would re-enter
 *     the curation path for that curator, and so on.
 *  2. FILL-ORDER BUG. Writing a curator's identity entry from the curation path
 *     would cache a summary whose OWN `starterPackScore` was never computed — so
 *     whether an author gets their curation boost would depend on the accidental
 *     order in which the cache happened to be filled.
 *
 * So this is a SINGLE-VALUE cache under its own key, written and read only here.
 * It NEVER touches `usersummary:`. That makes the resolution non-recursive and
 * lets the follower weighting actually WORK for a cold curator (the point of the
 * signal) instead of silently collapsing to the neutral floor.
 *
 * COST: one Redis MGET + at most ONE bulk Oxy `getUsersByIds` per batch, for the
 * cache MISSES only. The curator set is already bounded by
 * `maxCuratorsPerAuthor · authors`, and the TTL is long (a follower count is a
 * coarse, slow-moving input to a bounded log factor), so the steady-state cost of
 * a warm cache is a single Redis round trip.
 *
 * FAIL-SOFT: every failure degrades to "count unknown" for the affected curators,
 * which `curatorAuthority` reads as the NEUTRAL floor — the curator still endorses
 * at full base weight, they are just not amplified. Curation can never break a feed.
 */

import { MtnConfig } from '@mention/shared-types';
import type { User as OxyUser } from '@oxyhq/core';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { getRedisClient } from '../utils/redis';
import { withRedisFallback, ensureRedisConnected } from '../utils/redisHelpers';
import { logger } from '../utils/logger';

/**
 * Redis key prefix. Bump when the cached VALUE shape changes.
 *  - `v1` — a bare follower count (a JSON number).
 */
const CURATOR_FOLLOWERS_PREFIX = 'curatorfollowers:v1:';

const { cacheTtlSeconds } = MtnConfig.ranking.optInSignals.starterPackBoost.curatorAuthority;

function keyFor(curatorId: string): string {
  return `${CURATOR_FOLLOWERS_PREFIX}${curatorId}`;
}

/** A follower count is only usable if it is a real, non-negative, finite number. */
function isUsableCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Batch-read cached counts in ONE Redis round trip. Returns only the HITS; any
 * failure (no Redis, server down, corrupt entry, non-array reply) degrades to an
 * empty map, i.e. "everything is a miss".
 */
async function readCached(curatorIds: string[]): Promise<Map<string, number>> {
  const hits = new Map<string, number>();
  const redis = getRedisClient();

  return withRedisFallback(
    redis,
    async () => {
      const connected = await ensureRedisConnected(redis);
      if (!connected) return hits;

      const values = await redis.mGet(curatorIds.map(keyFor));

      // A Redis client/server can hand back a non-array reply for MGET (observed
      // against ElastiCache Valkey); iterating it would throw a TypeError that
      // `withRedisFallback` does NOT swallow. Treat it as a full miss.
      if (!Array.isArray(values)) {
        logger.debug('[CuratorFollowerCounts] mGet returned a non-array reply; treating as cache miss', {
          keyCount: curatorIds.length,
        });
        return hits;
      }

      values.forEach((raw, index) => {
        if (!raw) return;
        const parsed = Number(raw);
        if (isUsableCount(parsed)) {
          hits.set(curatorIds[index], parsed);
        }
      });

      return hits;
    },
    hits,
    'curatorFollowerCountsRead',
  );
}

/** Write freshly-resolved counts with a TTL, in one pipelined round trip. */
async function writeCached(counts: Map<string, number>): Promise<void> {
  if (counts.size === 0) return;

  const redis = getRedisClient();
  await withRedisFallback(
    redis,
    async () => {
      const connected = await ensureRedisConnected(redis);
      if (!connected) return;

      const pipeline = redis.multi();
      for (const [curatorId, count] of counts) {
        pipeline.setEx(keyFor(curatorId), cacheTtlSeconds, String(count));
      }
      await pipeline.exec();
    },
    undefined,
    'curatorFollowerCountsWrite',
  ).catch((error: unknown) => {
    logger.debug('[CuratorFollowerCounts] Store failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  });
}

/**
 * Resolve follower counts for a batch of curators: cache first, then ONE bulk Oxy
 * call for the misses, then write the fresh counts back.
 *
 * A curator absent from the returned map has an UNKNOWN follower count (never
 * resolved, or Oxy failed) — `curatorAuthority` maps that to the neutral floor, so
 * an unresolvable curator is never penalized, only un-amplified. Never throws.
 */
export async function resolveCuratorFollowerCounts(curatorIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const uniqueIds = Array.from(new Set(curatorIds.filter((id) => id.length > 0)));
  if (uniqueIds.length === 0) {
    return counts;
  }

  const cached = await readCached(uniqueIds);
  const missIds: string[] = [];
  for (const curatorId of uniqueIds) {
    const hit = cached.get(curatorId);
    if (hit === undefined) {
      missIds.push(curatorId);
    } else {
      counts.set(curatorId, hit);
    }
  }

  if (missIds.length === 0) {
    return counts;
  }

  // ONE bulk service-token call for every miss. `/users/by-ids` is server-to-server,
  // so it must go through the service client (the bare client carries no app token).
  const resolved = new Map<string, number>();
  try {
    const users: OxyUser[] = await getServiceOxyClient().getUsersByIds(missIds);
    for (const user of users) {
      const curatorId = String(user.id ?? '');
      const followers = user._count?.followers;
      if (curatorId.length > 0 && isUsableCount(followers)) {
        resolved.set(curatorId, followers);
      }
    }
  } catch (error) {
    // Fail-soft: the misses keep an UNKNOWN count → neutral curator authority. The
    // curation signal still scores (usage-weighted), the feed still serves.
    logger.warn('[CuratorFollowerCounts] Bulk follower lookup failed; curators fall back to neutral authority', {
      curatorCount: missIds.length,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return counts;
  }

  for (const [curatorId, count] of resolved) {
    counts.set(curatorId, count);
  }
  await writeCached(resolved);

  return counts;
}
