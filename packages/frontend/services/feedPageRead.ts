import { feedService, type ExtendedFeedRequest } from '@/services/feedService';
import type { FeedPageParam } from '@/stores/feedQueryCache';
import type { FeedReadIdentity } from '@/stores/feedStaleness';

export const FEED_PAGE_SIZE = 20;

export type FeedPageResponse = Awaited<ReturnType<typeof feedService.getFeed>>;

/**
 * One page of a feed off the wire, exactly as a `<Feed>` asks for it. No retry
 * wrapper: `feedService` owns the one policy (`utils/feedRetry`).
 */
export function requestFeedPage(
  feed: FeedReadIdentity,
  cursor: FeedPageParam,
  signal?: AbortSignal,
): Promise<FeedPageResponse> {
  const request: ExtendedFeedRequest = {
    type: feed.type,
    limit: FEED_PAGE_SIZE,
    cursor,
    filters: feed.filters,
  };
  return feed.userId
    ? feedService.getUserFeed(feed.userId, request, { signal })
    : feedService.getFeed(request, { signal });
}

/**
 * The home feed's first page, read while the app is still booting
 * (`lib/bootFeedRead`), for the viewer the read was made as: `null` for an
 * anonymous read, else the account the bearer belonged to.
 */
let bootRead: { viewerId: string | null; page: Promise<FeedPageResponse | null> } | null = null;
/** The home feed already asked for its first page: a boot read now would be a second one. */
let bootWindowClosed = false;

const BOOT_FEED: FeedReadIdentity = { type: 'for_you' };

export function startBootFeedRead(viewerId: string | null): void {
  if (bootRead || bootWindowClosed) return;
  bootRead = {
    viewerId,
    // A failed boot read is simply absent: the feed reads for itself.
    page: requestFeedPage({ ...BOOT_FEED, viewerId: viewerId ?? undefined }, undefined).catch(
      () => null,
    ),
  };
}

/**
 * The boot read, when `feed`'s first page is the read it made: For You,
 * unfiltered, for the SAME viewer. Anything else leaves it unused — a viewer
 * who resolved differently never sees a page read for someone else. Taken at
 * most once; the home feed's first page read takes it or retires it.
 */
export function takeBootFeedRead(
  feed: FeedReadIdentity,
  cursor: FeedPageParam,
): Promise<FeedPageResponse | null> | null {
  const read = bootRead;
  if (cursor !== undefined || feed.type !== BOOT_FEED.type || feed.userId) return null;
  if (feed.filters && Object.keys(feed.filters).length > 0) return null;
  bootWindowClosed = true;
  bootRead = null;
  return read && read.viewerId === (feed.viewerId ?? null) ? read.page : null;
}

export const __feedPageReadForTests = {
  reset: () => {
    bootRead = null;
    bootWindowClosed = false;
  },
};
