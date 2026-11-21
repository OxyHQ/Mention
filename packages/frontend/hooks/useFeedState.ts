import { useCallback, useEffect, useMemo, useRef } from 'react';
import { skip, useList, useStore, withStore } from '@oxy.so/bloom-data';
import type {
  FeedInterstitialSlot,
  FeedPostSlice,
  FeedType,
  HydratedPost,
} from '@mention/shared-types';
import { createLogger } from '@oxy.so/core/logger';
import {
  FED_PENDING_POLL_DELAYS_MS,
  type FeedIdentity,
  feedContent,
  feedSource,
  hasUnresolvedAuthor,
  UNRESOLVED_AUTHOR_REREAD_DELAYS_MS,
} from '@/data/feeds';
import { classifyFeedFailure, type FeedFailureKind, isFeedCursorExpired } from '@/utils/feedRetry';
import { buildFeedScrollKey, type FeedFilters } from '@/utils/feedUtils';
import { useBoundedReread } from './useBoundedReread';
import { useDeepCompareMemo } from './useDeepCompare';
import { useFeedRankingStaleness } from './useFeedRankingStaleness';
import { useReloadOnFeedRuleChange } from './useReloadOnFeedRuleChange';

export { FED_PENDING_POLL_DELAYS_MS, UNRESOLVED_AUTHOR_REREAD_DELAYS_MS } from '@/data/feeds';

const logger = createLogger('useFeedState');

/** Backoff per reason a feed's first page is read again. */
export const REREAD_DELAYS_MS = {
  pending: FED_PENDING_POLL_DELAYS_MS,
  'unresolved-author': UNRESOLVED_AUTHOR_REREAD_DELAYS_MS,
} as const;

export function logRereadExhausted(reason: string): void {
  logger.debug('Feed reread budget exhausted', { reason });
}

export interface UseFeedStateOptions {
  type: FeedType;
  userId?: string;
  filters?: FeedFilters;
  reloadKey?: string | number;
  isAuthenticated?: boolean;
  currentUserId?: string;
}

export interface UseFeedStateReturn {
  /** Stable viewer/feed identity used by cache and scroll restoration. */
  feedScrollKey: string;
  items: HydratedPost[];
  slices?: FeedPostSlice[];
  /**
   * Recommendation-card placements accumulated across the loaded pages:
   * appended on `loadMore`, replaced on a first-page read. Placements only;
   * the cards fetch their own content.
   */
  interstitials?: FeedInterstitialSlot[];
  hasMore: boolean;
  isLoading: boolean;
  error: string | null;
  /**
   * What KIND of failure `error` was, for a surface that has to choose what to
   * say about it. `null` whenever there is no error. Only set after the feed's
   * retries are exhausted (`utils/feedRetry`).
   */
  errorKind: FeedFailureKind | null;
  /** A federated profile feed is still populating (the hook reads it again meanwhile). */
  pending: boolean;
  fetchInitial: (forceRefresh?: boolean) => Promise<void>;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  clearError: () => void;
}

/**
 * One feed: its rows, its state and its commands, from the feed source
 * (`data/feeds`, `@oxy.so/bloom-data`).
 *
 * Every feed is one list of post ids, per identity: native and web, scoped and
 * not. A feed that unmounts and remounts renders its held rows synchronously,
 * which is what Bloom's scroll restoration needs; an unscoped feed also keeps a
 * disk copy on native, shown at a cold start while it is read again. A
 * remount reads page 1 again only when a write made the held read stale
 * (`stores/feedStaleness`). The list does not re-render when a post changes:
 * each row reads its own post (`usePostSelector`).
 *
 * Every feed renders the server's slices (threads grouped, each with its
 * social context), on every platform.
 */
export function useFeedState({
  type,
  userId,
  filters,
  reloadKey,
  isAuthenticated,
  currentUserId,
}: UseFeedStateOptions): UseFeedStateReturn {
  const feedScrollKey = useMemo(
    () =>
      buildFeedScrollKey({
        type,
        userId,
        filters,
        isAuthenticated,
        currentViewerId: currentUserId,
      }),
    [type, userId, filters, isAuthenticated, currentUserId],
  );

  // At restore, `isAuthenticated` can flip true a tick before `currentUserId`
  // lands. Nothing is read or shown until the id arrives.
  const viewerReady = !isAuthenticated || Boolean(currentUserId);
  const viewerId = isAuthenticated ? currentUserId : undefined;
  // Callers rebuild `filters` inline; compared by value.
  const feed = useDeepCompareMemo(
    (): FeedIdentity => ({ type, userId, filters, viewerId }),
    [type, userId, filters, viewerId],
  );

  // A cold feed asks for its first page HERE, while the screen around it is
  // still rendering, rather than from the mount effect, which runs only once
  // the whole screen has committed (~130 ms later on a throttled cold load). The
  // read is shared: the list's own observer joins it.
  const store = useStore();
  if (viewerReady) {
    withStore(store, () => {
      if (feedSource.state(feed).status === 'idle') void feedSource.fetch(feed);
    });
  }

  const view = useList(feedSource, ...(viewerReady ? ([feed] as [FeedIdentity]) : [skip]));
  const list = view.list;
  const content = useMemo(() => withStore(store, () => feedContent(list)), [store, list]);

  const staleSocialEvidence = useFeedRankingStaleness(feed, view.updatedAt, viewerReady);
  const slices = useMemo(
    () =>
      staleSocialEvidence
        ? content.slices?.map((slice) => ({ ...slice, socialContext: undefined }))
        : content.slices,
    [content.slices, staleSocialEvidence],
  );

  /**
   * Read the feed from its first page again: a pull-to-refresh, a reload, a
   * rule change, a stale warm start, a pending poll. One request; the loaded
   * rows stay on screen until it lands and replaces them, and it supersedes
   * any read in flight (a late page 2 never lands on a fresh page 1).
   */
  const { refresh: refreshList, more } = view;
  const reload = useCallback(async () => {
    if (viewerReady) await refreshList();
  }, [viewerReady, refreshList]);

  // A changed `reloadKey` (a reselect of the place the reader is on) reads
  // the feed again. The first value is the mount, which loads on its own.
  const reloadKeyRef = useRef(reloadKey);
  useEffect(() => {
    if (reloadKeyRef.current === reloadKey) return;
    reloadKeyRef.current = reloadKey;
    void reload();
  }, [reloadKey, reload]);

  useReloadOnFeedRuleChange(viewerReady, reload, feed);

  // Page 1 read again on a bounded backoff, for one of two reasons:
  //  - a federated profile still syncing (`pending`), until posts arrive;
  //  - an author Oxy could not resolve, until Oxy answers. Only while the feed
  //    holds that one page: a reread replaces every loaded page with page 1,
  //    which would pull a reader who has scrolled on out of place.
  const pending = viewerReady && list?.extra?.pending === true;
  const onFirstPage = (list?.visited.length ?? 0) === 0;
  const unresolvedAuthor = viewerReady && onFirstPage && hasUnresolvedAuthor(content.items);
  const reread = pending ? 'pending' : unresolvedAuthor ? 'unresolved-author' : undefined;
  useBoundedReread({
    feedKey: view.key,
    reason: reread,
    delays: REREAD_DELAYS_MS,
    stamp: view.updatedAt,
    reload: () => void reload(),
    onExhausted: logRereadExhausted,
  });

  // The feed loads itself when it mounts and when its identity changes, so
  // only a forced call (the empty state's retry) has anything to ask for.
  const fetchInitial = useCallback(
    (forceRefresh: boolean = false) => (forceRefresh ? reload() : Promise.resolve()),
    [reload],
  );

  // A late page from a departed feed (or account) must not start a read
  // under the current one. Recovery from an expired cursor happens once per
  // cursor, however many scroll callbacks shared the failed request.
  const liveKeyRef = useRef<string | null>(view.key);
  useEffect(() => {
    liveKeyRef.current = view.key;
    return () => {
      liveKeyRef.current = null;
    };
  }, [view.key]);
  const recoveredCursorRef = useRef<string | null>(null);
  const cursor = list?.next;
  const loadMore = useCallback(async () => {
    if (!viewerReady || !view.hasMore) return;
    const recoveryKey = JSON.stringify([view.key, cursor]);
    if (recoveredCursorRef.current === recoveryKey) return;
    await more();
    if (liveKeyRef.current !== view.key) return;
    const state = withStore(store, () => feedSource.state(feed));
    if (!cursor || state.status !== 'error' || !isFeedCursorExpired(state.error)) return;
    if (recoveredCursorRef.current === recoveryKey) return;
    recoveredCursorRef.current = recoveryKey;
    await reload();
  }, [viewerReady, view.hasMore, view.key, cursor, more, store, feed, reload]);

  const clearError = useCallback(() => undefined, []);

  // A read that wants the network and has none is `paused`: not fetching, no
  // error, no items. Left alone it renders as "No posts yet", which is a claim
  // about the feed, when the truth is that the device cannot ask. It resumes by
  // itself when the connection returns.
  const isFetching = view.isFetching;
  const waitingForNetwork =
    viewerReady && view.fetchStatus === 'paused' && content.items.length === 0;
  const failureKind: FeedFailureKind | null =
    viewerReady && !isFetching
      ? waitingForNetwork
        ? 'offline'
        : view.status === 'error'
          ? classifyFeedFailure(view.error).kind
          : null
      : null;

  return {
    feedScrollKey,
    items: content.items,
    slices,
    interstitials: content.interstitials,
    hasMore: viewerReady && view.hasMore,
    isLoading: !viewerReady || isFetching,
    // A marker, not the transport's message: the empty state owns its copy,
    // chosen by `errorKind`.
    error: failureKind ? 'Failed to load' : null,
    errorKind: failureKind,
    pending,
    fetchInitial,
    refresh: reload,
    loadMore,
    clearError,
  };
}
