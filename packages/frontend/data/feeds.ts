import { list, type ListState, type Page, source } from '@oxy.so/bloom-data';
import type {
  FeedInterstitialSlot,
  FeedPostSlice,
  FeedType,
  HydratedPost,
} from '@mention/shared-types';
import { createLogger } from '@oxy.so/core/logger';
import type { FeedItem } from '@/db/schema';
import { toFeedItem } from '@/db/feedItem';
import { precacheActorsFromPosts } from '@/lib/precacheActorsFromPosts';
import { requestFeedPage, takeBootFeedRead } from '@/services/feedPageRead';
import { advanceLocalPostRevision } from '@/stores/feedScrollStore';
import { type FeedReadIdentity, isFeedReadStale } from '@/stores/feedStaleness';
import { classifyFeedFailure, isFeedCursorExpired, logFeedFailure } from '@/utils/feedRetry';
import {
  type FeedFilters,
  feedReceivesOwnNewPost,
  feedThreadParentId,
  getItemKey,
  type MergedFeedPageContent,
  mergeFeedPageContent,
  normalizeFeedFilters,
} from '@/utils/feedUtils';
import { getPost, Post, storePosts } from './posts';

const logger = createLogger('feeds');

/**
 * Every feed a `<Feed>` shows, one list per feed identity
 * (`@oxy.so/bloom-data`): ordered post ids, with the page data the server
 * sends beside them. The posts themselves live once, in `Post`.
 *
 * This replaces both earlier feed paths: the SQLite `feed_items` tables that
 * served native's unscoped feeds, and the React Query pages that served web
 * and every scoped feed. The store belongs to one account, so the viewer is
 * not part of a feed's key.
 */

/** A feed and who reads it. `limit` sizes the request; it is not part of the identity. */
export interface FeedIdentity extends FeedReadIdentity {
  limit?: number;
}

/** A slice as stored: its posts by id, the posts themselves in `Post`. */
type StoredSliceItem = Omit<FeedPostSlice['items'][number], 'post'> & { postId: string };
type StoredSlice = Omit<FeedPostSlice, 'items'> & { items: StoredSliceItem[] };

export interface FeedExtra {
  slices?: StoredSlice[];
  interstitials?: FeedInterstitialSlot[];
  /**
   * The server answered `pending` with nothing to show: a federated profile
   * whose ActivityPub outbox is still syncing in the background.
   */
  pending: boolean;
}

/** The list key of a feed: type, profile and filters (never the viewer). */
export function feedKey(feed: Pick<FeedIdentity, 'type' | 'userId' | 'filters'>): string {
  return JSON.stringify([feed.type, feed.userId ?? null, normalizeFeedFilters(feed.filters)]);
}

export function parseFeedKey(key: string): Pick<FeedIdentity, 'type' | 'userId' | 'filters'> {
  const [type, userId, filters] = JSON.parse(key) as [FeedType, string | null, FeedFilters | null];
  return { type, userId: userId ?? undefined, filters: filters ?? undefined };
}

export const isScopedFeed = (filters: FeedFilters | undefined): boolean =>
  Boolean(filters && Object.keys(filters).length > 0);

const dropSlicePosts = (slices: StoredSlice[] | undefined, ids: ReadonlySet<string>) =>
  slices
    ?.map((slice) => ({ ...slice, items: slice.items.filter((item) => !ids.has(item.postId)) }))
    .filter((slice) => slice.items.length > 0);

export const Feed = list<FeedExtra>('feed', {
  of: Post,
  // Unscoped feeds keep a disk copy, as their SQLite tables did; a thread's
  // replies, a search or a filtered view stay in memory, as their queries did.
  persist: (key) => !isScopedFeed(parseFeedKey(key).filters),
  dropFromExtra: (extra, ids) => ({ ...extra, slices: dropSlicePosts(extra.slices, ids) }),
});

/**
 * Reads of page 1 again while it shows an author Oxy could not resolve, or a
 * federated profile still syncing (`hooks/useFeedState`).
 */
export const FED_PENDING_POLL_DELAYS_MS = [1000, 2500, 5000] as const;
export const UNRESOLVED_AUTHOR_REREAD_DELAYS_MS = [15_000, 60_000, 300_000] as const;

/**
 * A replies list read this recently was read for the navigation in progress
 * (the post screen prefetches it from the route id), so mounting does not read
 * it a second time.
 */
const REPLIES_REREAD_AFTER_MS = 10_000;

/**
 * Whether any row shows an author the server could not resolve from Oxy: the
 * degraded placeholder, the only user with an EMPTY `username`. That is the
 * server's answer for the moment of the read, so a feed holding one is worth
 * reading again.
 */
export function hasUnresolvedAuthor(items: readonly (HydratedPost | FeedItem)[]): boolean {
  const unresolved = (user: { username?: string } | null | undefined) =>
    Boolean(user) && !user?.username;
  return items.some(
    (post) =>
      unresolved(post.user) ||
      unresolved(post.boost?.actor) ||
      unresolved((post.boost?.originalPost ?? post.quotedPost ?? post.originalPost)?.user),
  );
}

/** The posts a list holds, in order (the ones still held). */
export function feedPosts(state: ListState<FeedExtra> | undefined): FeedItem[] {
  if (!state) return [];
  const posts: FeedItem[] = [];
  for (const id of state.ids) {
    const post = getPost(id);
    if (post) posts.push(post);
  }
  return posts;
}

/** What a feed renders: its posts, slices and card placements, every overlap removed. */
export function feedContent(state: ListState<FeedExtra> | undefined): MergedFeedPageContent {
  if (!state) return { items: [] };
  const slices: FeedPostSlice[] | undefined = state.extra?.slices?.map((slice) => ({
    ...slice,
    items: slice.items.flatMap(({ postId, ...item }) => {
      const post = getPost(postId);
      return post ? [{ ...item, post: post as HydratedPost }] : [];
    }),
  }));
  return mergeFeedPageContent(undefined, {
    items: feedPosts(state) as HydratedPost[],
    slices,
    interstitials: state.extra?.interstitials,
  });
}

function storedSlices(slices: readonly FeedPostSlice[] | undefined): StoredSlice[] | undefined {
  return slices?.map((slice) => ({
    ...slice,
    items: slice.items.map(({ post, ...item }) => ({ ...item, postId: String(post.id) })),
  }));
}

/**
 * Read one page of a feed: a thread's replies narrowed to that thread, the
 * page normalised, and its authors seeded into the actor cache.
 */
async function loadFeedPage(
  {
    cursor,
    signal,
    current,
  }: { cursor: string | undefined; signal: AbortSignal; current: ListState<FeedExtra> | undefined },
  feed: FeedIdentity,
): Promise<Page<FeedItem, FeedExtra>> {
  try {
    // The home feed's first page may already have been read while the app
    // booted, for this same viewer. Not awaited when there is none: the read
    // leaves in this same tick.
    const bootRead = takeBootFeedRead(feed, cursor);
    const response =
      (bootRead && (await bootRead)) ?? (await requestFeedPage(feed, cursor, signal, feed.limit));

    // The replies endpoint owns membership; any other thread-scoped feed is
    // narrowed to the posts that answer the thread.
    const parentId = feedThreadParentId(feed.filters);
    const items =
      parentId && feed.type !== 'replies'
        ? (response.items ?? []).filter((item) => String(item.parentPostId) === parentId)
        : (response.items ?? []);
    const content = mergeFeedPageContent(undefined, {
      items,
      slices: response.slices,
      interstitials: response.interstitials,
    });
    // The web feed's only actor source: avatars and names render from it.
    precacheActorsFromPosts(content.items);

    const pending = Boolean(feed.userId) && response.pending === true && content.items.length === 0;
    // A still-syncing outbox answering empty is not the profile emptying: a
    // first page already on screen stays, flagged pending.
    if (pending && cursor === undefined && current && current.ids.length > 0) {
      return {
        items: feedPosts(current),
        next: current.next,
        hasMore: current.hasMore,
        extra: { ...(current.extra ?? {}), pending: true },
      };
    }
    const listed = new Set(content.items.map(getItemKey));
    const slicePosts =
      content.slices?.flatMap((slice) =>
        slice.items.flatMap((item) => (listed.has(getItemKey(item.post)) ? [] : [item.post])),
      ) ?? [];
    return {
      // Stored in the one shape every surface reads.
      items: content.items.map((item) => toFeedItem(item)),
      related: slicePosts.map((item) => toFeedItem(item)),
      next: response.nextCursor,
      hasMore: Boolean(response.hasMore),
      extra: {
        slices: storedSlices(content.slices),
        interstitials: content.interstitials,
        pending,
      },
    };
  } catch (error) {
    // A superseded read is not a failure; anything else is one the feed
    // service has already retried, so it is a bounded warn, never an error.
    if (!signal.aborted && !(cursor !== undefined && isFeedCursorExpired(error))) {
      logFeedFailure(
        logger,
        cursor === undefined ? 'Feed load failed' : 'Feed pagination failed',
        classifyFeedFailure(error),
        { feedType: feed.type },
      );
    }
    throw error;
  }
}

/**
 * The one feed source. Staleness is decided by RULE, never by age: a held
 * read is shown and kept, unless a write it cannot see happened since it was
 * read (`stores/feedStaleness`), it showed an author Oxy could not resolve, or
 * it is a thread's replies read more than a moment ago. A disk copy from an
 * earlier session is always read again. Feeds stay for the session; an
 * account switch opens another store.
 */
export const feedSource = source(Feed, {
  key: (feed: FeedIdentity) => feedKey(feed),
  load: loadFeedPage,
  fold: (current, extra, mode): FeedExtra =>
    mode === 'first' || !current
      ? {
          slices: extra?.slices,
          interstitials: extra?.interstitials,
          pending: extra?.pending ?? false,
        }
      : {
          // Each page's card slots anchor to slices of THAT page, so appending
          // keeps every card at its position in the accumulated feed.
          slices: [...(current.slices ?? []), ...(extra?.slices ?? [])],
          interstitials: [...(current.interstitials ?? []), ...(extra?.interstitials ?? [])],
          pending: current.pending,
        },
  stale: (read, feed) => {
    const age = Date.now() - read.updatedAt;
    if (feed.type === 'replies') return age > REPLIES_REREAD_AFTER_MS;
    if (isFeedReadStale(feed, read.updatedAt)) return true;
    return (
      age > UNRESOLVED_AUTHOR_REREAD_DELAYS_MS[0] &&
      hasUnresolvedAuthor(feedPosts(Feed.get(feedKey(feed))))
    );
  },
  gcTime: Number.POSITIVE_INFINITY,
  // One retry policy, owned by `feedService` (`utils/feedRetry`).
  retry: 0,
  // Feeds are read again by rule, on mount and on a rule change, never because
  // the app came to the front or the network came back.
  refetchOnFocus: false,
  refetchOnReconnect: false,
});

/**
 * Start a feed's first page before its `<Feed>` mounts, from a route id or a
 * press. Only a feed with no data (or stale data) is read, and the feed's own
 * observer joins this read.
 */
export function prefetchFeed(feed: FeedIdentity): void {
  void feedSource.fetch(feed);
}

/** Puts `postId` at the top of a held feed, and of its slices when it renders by slice. */
function prependToFeed(key: string, post: FeedItem): void {
  const postId = String(post.id);
  Feed.set(key, (current) => {
    if (!current || current.ids.includes(postId)) return current;
    const slices = current.extra?.slices;
    const inASlice = slices?.some((slice) => slice.items.some((item) => item.postId === postId));
    const local: StoredSlice = {
      _sliceKey: `local-new:${getItemKey(post)}`,
      isIncompleteThread: false,
      items: [{ postId, isThreadParent: false, isThreadChild: false, isThreadLastChild: false }],
    };
    return {
      ...current,
      ids: [postId, ...current.ids],
      extra: {
        ...(current.extra ?? { pending: false }),
        slices: slices && slices.length > 0 && !inASlice ? [local, ...slices] : slices,
      },
    };
  });
}

/**
 * Put a post the viewer just created at the top of every held feed it belongs
 * in (the home feeds and the author's own profile posts), mounted or not, and
 * advance the revision that brings it into view.
 */
export function publishNewLocalPost(post: FeedItem): void {
  Post.put(post);
  const authorId = post.user?.id ? String(post.user.id) : undefined;
  for (const key of Feed.keys()) {
    if (feedReceivesOwnNewPost({ ...parseFeedKey(key), currentUserId: authorId })) {
      prependToFeed(key, post);
    }
  }
  advanceLocalPostRevision();
}

/**
 * Put a reply the server accepted on top of the thread it answers (#1140),
 * matched on the same parent id the feed's read narrows its results to.
 */
export function publishNewLocalReply(reply: FeedItem): void {
  const parentId = String(reply.parentPostId ?? '');
  if (!parentId) return;
  Post.put(reply);
  for (const key of Feed.keys()) {
    const feed = parseFeedKey(key);
    if (feed.type === 'replies' && feedThreadParentId(feed.filters) === parentId) {
      prependToFeed(key, reply);
    }
  }
}

/**
 * Posts a broadcast says are new on a feed type, put at the top of that type's
 * held unscoped feed. The broadcast is hydrated for no viewer.
 */
export function prependBroadcastPosts(type: FeedType, posts: readonly HydratedPost[]): void {
  const key = feedKey({ type });
  if (!Feed.get(key)) return;
  const stored = storePosts(posts, { anonymous: true });
  for (const post of [...stored].reverse()) prependToFeed(key, post);
}

/** Forgets a held feed in memory and on disk (a private profile's feeds). */
export function clearFeed(feed: Pick<FeedIdentity, 'type' | 'userId' | 'filters'>): void {
  Feed.set(feedKey(feed), () => undefined);
}
