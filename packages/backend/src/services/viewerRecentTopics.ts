import { getRedisClient } from '../utils/redis';
import { withRedisFallback, ensureRedisConnected } from '../utils/redisHelpers';
import { logger } from '../utils/logger';

/**
 * Redis-backed set of the topics a viewer has RECENTLY engaged with / been shown,
 * powering the opt-in `noveltyBoost` ranking signal (which lifts posts whose
 * topics are NOT in this set, to encourage exploration).
 *
 * Design constraints (mirror {@link ./dwellAggregate} + {@link ./userSummaryCache}):
 *  - Uses the shared {@link getRedisClient} singleton — never opens a new socket.
 *  - Every operation degrades to a NO-OP when Redis is unavailable (the signal
 *    then reads an empty set and stays neutral) — best-effort ranking input only.
 *  - The set's TTL bounds "recent" and keeps it from growing without limit; each
 *    write also caps how many topics it adds so one post can't flood the set.
 */

/** Redis key prefix for a viewer's recent-topic set. `v1` namespaces the schema. */
const RECENT_TOPICS_PREFIX = 'recenttopics:v1:';

/** How long a topic stays "recent". 6 hours — long enough to shape a session. */
const RECENT_TOPICS_TTL_SECONDS = Number(process.env.VIEWER_RECENT_TOPICS_TTL_SECONDS ?? 6 * 60 * 60);

/** Max topics folded in from a single post, so one post can't dominate the set. */
const MAX_TOPICS_PER_WRITE = 10;

function keyFor(viewerId: string): string {
  return `${RECENT_TOPICS_PREFIX}${viewerId}`;
}

/**
 * Fold the topics of a just-seen/engaged post into the viewer's recent-topic set,
 * refreshing the TTL. Fire and forget — normalizes (lowercase, trim, dedupe),
 * caps the batch, and no-ops on an empty input or a Redis outage.
 */
export async function recordSeenTopics(viewerId: string, topics: string[]): Promise<void> {
  if (!viewerId || topics.length === 0) {
    return;
  }
  const normalized = Array.from(
    new Set(topics.map((t) => (typeof t === 'string' ? t.toLowerCase().trim() : '')).filter((t) => t.length > 0)),
  ).slice(0, MAX_TOPICS_PER_WRITE);
  if (normalized.length === 0) {
    return;
  }

  const redis = getRedisClient();
  await withRedisFallback(
    redis,
    async () => {
      const connected = await ensureRedisConnected(redis);
      if (!connected) return;
      const key = keyFor(viewerId);
      const multi = redis.multi();
      multi.sAdd(key, normalized);
      multi.expire(key, RECENT_TOPICS_TTL_SECONDS);
      await multi.exec();
    },
    undefined,
    'viewerRecentTopicsRecord',
  ).catch((error: unknown) => {
    logger.debug('[ViewerRecentTopics] record failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  });
}

/**
 * Read a viewer's recent-topic set (lowercased topic slugs). Returns an empty set
 * when there is nothing recorded or Redis is unavailable, so `noveltyBoost` stays
 * neutral.
 */
export async function getRecentTopics(viewerId: string): Promise<Set<string>> {
  const result = new Set<string>();
  if (!viewerId) {
    return result;
  }

  const redis = getRedisClient();
  return withRedisFallback(
    redis,
    async () => {
      const connected = await ensureRedisConnected(redis);
      if (!connected) return result;
      const members = await redis.sMembers(keyFor(viewerId));
      for (const member of members) result.add(member);
      return result;
    },
    result,
    'viewerRecentTopicsGet',
  );
}
