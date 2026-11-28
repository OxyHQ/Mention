/**
 * Viewing an imported Bluesky post is when Mention learns which accounts KNOWN
 * here liked, reposted or quoted it (`atproto/engagementImport.ts`). The post's
 * likes/boosts/quotes lists then name them through the ordinary engagement
 * records. ActivityPub publishes only totals for a remote post, so an
 * ActivityPub post has nothing to import here and keeps its inbound activities.
 *
 * Bounded twice, and both bounds hold the request path harmless: one import per
 * post per {@link IMPORT_COOLDOWN_MS} across the fleet (a Redis key that is
 * never released, so it IS the cooldown; with Redis unavailable nothing runs),
 * and at most {@link MAX_IN_FLIGHT} imports in one process (more are dropped,
 * and the next view after the cooldown tries again).
 */

import type { PostRecord } from '../db/posts/postRecord';
import { logger } from '../utils/logger';
import { createRedisLock, type DistributedLock } from '../utils/redisLock';
import { ATPROTO_ENABLED } from './atproto/constants';
import { importAtprotoEngagement } from './atproto/engagementImport';

const IMPORT_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_IN_FLIGHT = 4;

let lock: DistributedLock | undefined;
let inFlight = 0;

/** The Bluesky post a local post mirrors, or undefined for anything else. */
function blueskyPostUri(post: Pick<PostRecord, 'federation'>): string | undefined {
  const uri = post.federation?.activityId;
  return uri?.startsWith('at://') && uri.includes('/app.bsky.feed.post/') ? uri : undefined;
}

/** Start the import for a viewed post if it is due. Never throws, never awaits remote I/O. */
export function importRemoteEngagementOnView(post: Pick<PostRecord, 'id' | 'federation'>): void {
  const uri = blueskyPostUri(post);
  if (!ATPROTO_ENABLED || !uri || inFlight >= MAX_IN_FLIGHT) return;
  inFlight += 1;
  void (async () => {
    try {
      lock ??= createRedisLock();
      const attempt = await lock.tryAcquire(`remote-engagement:v1:${post.id}`, IMPORT_COOLDOWN_MS);
      if (attempt.status !== 'acquired') return;
      await importAtprotoEngagement(post.id, uri);
    } catch (err) {
      logger.warn('[RemoteEngagement] import failed', { error: String(err) });
    } finally {
      inFlight -= 1;
    }
  })();
}
