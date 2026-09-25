/**
 * The Redis half of an erasure: every cache key Mention derives from an account id.
 *
 * Redis is a cache here, never the record, so this is best-effort. Each helper
 * already degrades to a no-op when Redis is unavailable. A key this misses expires
 * on its own TTL: the longest per-account one (viewer relations, recent topics) is
 * hours, not days.
 *
 * Keys that cannot be found from the account id are not listed here, because they
 * would need a keyspace SCAN: a per-post view marker (`viewseen:<post>:<viewer>`,
 * 24 hours), the anonymous feed pages and the search overview (minutes). They hold
 * no content of their own and expire on their TTL; `docs/account-erasure.md` says so.
 */

import { invalidate as invalidateUserSummary } from '../userSummaryCache';
import { invalidateFediverseSharing } from '../fediverseSharing';
import { feedSeenPostsService } from '../FeedSeenPostsService';
import { invalidateViewerRelations } from '../../utils/privacyHelpers';
import { clearRecentTopics } from '../viewerRecentTopics';

/** Drop every cache entry keyed by the account. Returns how many helpers ran. */
export async function dropAccountCaches(oxyUserId: string): Promise<number> {
  const operations: Array<() => Promise<unknown>> = [
    () => invalidateUserSummary([oxyUserId]),
    () => invalidateFediverseSharing(oxyUserId),
    () => invalidateViewerRelations(oxyUserId),
    () => feedSeenPostsService.clearSeenPosts(oxyUserId),
    () => clearRecentTopics(oxyUserId),
  ];
  const settled = await Promise.allSettled(operations.map((operation) => operation()));
  return settled.filter((outcome) => outcome.status === 'fulfilled').length;
}
