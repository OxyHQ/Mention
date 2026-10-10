import type { FeedQueryIdentity } from '@/lib/viewerQueryKeys';
import { isFeedCacheStale } from '@/stores/engagementInvalidation';
import { isLaneFeedCacheStale } from '@/stores/laneInvalidation';
import { isFeedCacheStaleForSafety } from '@/stores/safetyInvalidation';
import { isFeedCacheStaleForByline } from '@/stores/bylineInvalidation';

/** The feed whose held read is being judged, and who is reading it. */
export interface FeedReadIdentity extends FeedQueryIdentity {
    viewerId?: string;
}

/**
 * Whether a feed read made at `readAt` predates a write that changed what the
 * feed shows — in which case a warm start must read it again instead of trusting
 * what it holds.
 *
 * A held read is only good if it postdates ALL FOUR classes of change that
 * decide what a feed shows. Three decide what a list CONTAINS: an engagement
 * (like/boost/save), a lane write (a post moved between lanes, a lane's
 * displayMode changed, a lane muted), and a safety-rule change (muted words, the
 * sensitive-content toggle — these decide what the server is willing to send at
 * all). The fourth decides what a row already in the list SAYS: a channel
 * turning its byline on or off adds or removes the writer from every one of its
 * posts, and the client was never sent the writer's id while it was off. Each
 * lives in its own authority module and none can see another's writes, so all
 * four are asked. Ask them HERE rather than at each call site: a caller that
 * consults three of the four still returns a plausible feed, which is why that
 * mistake survives review. Both read paths ask — the feed query
 * (`hooks/useFeedQuery`) and the SQLite store (`hooks/useFeedState`).
 */
export function isFeedReadStale(feed: FeedReadIdentity, readAt: number): boolean {
    return isFeedCacheStale(feed.type, feed.userId, feed.viewerId, readAt)
        || isLaneFeedCacheStale(feed.userId, feed.viewerId, feed.filters?.laneId, readAt)
        || isFeedCacheStaleForSafety(readAt)
        || isFeedCacheStaleForByline(readAt);
}
