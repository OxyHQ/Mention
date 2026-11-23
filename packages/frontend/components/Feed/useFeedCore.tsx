import { recoverChunkError } from '@/lib/chunkReload';
import { useFeedVisibility } from '@/hooks/useFeedVisibility';
import { useFeedLiveUpdates } from './FeedUpdatePolicy';
import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import type { View } from 'react-native';
import type { FeedType } from '@mention/shared-types';
import { useTabPageContentPainted } from '@oxy.so/bloom/tab-pager';
import { ErrorBoundary } from '@oxy.so/bloom/error-boundary';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTheme } from '@oxy.so/bloom/theme';
import { useRouter } from '@/lib/navigation/router';
import { useOpenPostEngagement } from '@/components/Post/postEngagementContext';
import { useTranslation } from 'react-i18next';
import { createLogger } from '@oxy.so/core/logger';
import { useFeedState } from '@/hooks/useFeedState';
import { useDeepCompareMemo } from '@/hooks/useDeepCompare';
import { usePrivacyControls } from '@/hooks/usePrivacyControls';
import { type FeedFilters, feedReceivesOwnNewPost, shallowFiltersEqual } from '@/utils/feedUtils';
import { resolveFeedDescriptor, useFeedImpressionTracker } from '@/utils/feedTelemetry';
import { classifyFeedFailure, logFeedFailure } from '@/utils/feedRetry';
import { FeedHeader } from './FeedHeader';
import { FeedFooter } from './FeedFooter';
import { FeedEmptyState } from './FeedEmptyState';
import { useHoldForLeading } from './holdForLeading';
import { type FeedRow, buildFeedRows } from './feedRows';
import { boundFeedRows, canAutoLoadFeed, showsCaughtUp } from './feedPaging';
import { useAgeProtections } from '@/hooks/useAgeProtections';

/**
 * EVERYTHING A FEED IS, except how it scrolls.
 *
 * Mention has one Feed per platform because each platform virtualizes against a
 * different scroller: native uses FlashList, web virtualizes against the
 * DOCUMENT (`window`) so back/forward restores the page, the address bar
 * collapses on mobile and the shell owns scroll. That difference is the list and
 * nothing else, so it is the only thing the two platform files keep.
 *
 * What a feed shows and does — its data, rows, pagination, retry and refresh,
 * the pinned-post hold, the empty state, the footer, the header, impression
 * telemetry, the error boundary, its props and when it re-renders — lives here
 * once. Before this, each platform carried its own copy, and they drifted: the
 * native feed opened the sign-in sheet on its own (#1272), only web held the
 * first page for a pinned post (#1246), and only native stopped paginating a
 * bounded preview. A behaviour change now lands in one place for both.
 */

const logger = createLogger('Feed');

export interface FeedProps {
  type: FeedType;
  userId?: string;
  showComposeButton?: boolean;
  onComposePress?: () => void;
  hideHeader?: boolean;
  hideRefreshControl?: boolean;
  scrollEnabled?: boolean;
  filters?: FeedFilters;
  reloadKey?: string | number;
  style?: React.ComponentProps<typeof View>['style'];
  contentContainerStyle?: React.ComponentProps<typeof View>['style'];
  listHeaderComponent?: React.ReactElement | null;
  /**
   * A row above the header (the compose prompt): the screen's own navigation,
   * such as Home's feed tabs, so it scrolls up and away with the feed instead of
   * staying pinned over it.
   */
  listTopComponent?: React.ReactElement | null;
  /** A normal row rendered before the sticky row. */
  listContentHeaderComponent?: React.ReactElement | null;
  /**
   * A row that sticks independently from `listHeaderComponent`, so callers can
   * scroll a large summary away while pinning only the compact navigation row
   * below it.
   */
  listStickyHeaderComponent?: React.ReactElement | null;
  /** Optional non-sticky row rendered immediately after the sticky row. */
  listLeadingComponent?: React.ReactElement | null;
  /** Identity rendered by the leading section; excluded from normal rows. */
  leadingPostId?: string;
  /**
   * The leading element is still being fetched (a profile's pinned post). The
   * feed's FIRST presentation waits for it AND for its own first page — its
   * loading state stays up, without the leading element, until both are
   * known — so the pinned post and the rows appear together, in their final
   * order, whichever request finishes last. Before, the loser landed on top of
   * what the winner had painted and pushed the column down (#1216). After
   * that first presentation it is ignored.
   */
  leadingPending?: boolean;
  threaded?: boolean;
  threadPostId?: string;
  /** Extra data owned by the screen chrome that shares this refresh. */
  onRefresh?: () => Promise<void>;
  /**
   * An EMBEDDED preview (`scrollEnabled={false}` inside a parent scroller):
   * render at most this many rows and never page. An embedded feed is not
   * virtualized — every row it holds is mounted — so without a bound it grows
   * with every page the parent's scroll pulls in (#1103). Every non-scrolling
   * Feed must be bounded; `validate:feed-hot-path` checks it.
   */
  previewLimit?: number;
  /**
   * Draw the header alone for now: the rows, the loading state and the footer
   * come once this is false. The data loads meanwhile. A screen whose header is
   * what the reader opened (a post above its replies) passes it for its first
   * frame (`useAfterFirstFrame`), so that frame is the header's alone.
   */
  rowsDeferred?: boolean;
}

type DefaultedFeedProp =
  | 'showComposeButton'
  | 'hideHeader'
  | 'hideRefreshControl'
  | 'scrollEnabled';

const DEFAULT_FEED_PROPS: Required<Pick<FeedProps, DefaultedFeedProp>> = {
  showComposeButton: false,
  hideHeader: false,
  hideRefreshControl: false,
  scrollEnabled: true,
};

type ResolvedFeedProps = FeedProps & Required<Pick<FeedProps, DefaultedFeedProp>>;

export function useFeedCore(props: FeedProps) {
  const merged: ResolvedFeedProps = { ...DEFAULT_FEED_PROPS, ...props };
  const {
    type,
    userId,
    filters,
    reloadKey,
    threaded,
    threadPostId,
    previewLimit,
    onRefresh,
    rowsDeferred = false,
  } = merged;

  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const openPostEngagement = useOpenPostEngagement();
  const { user: currentUser, isAuthenticated, canUsePrivateApi } = useAuth();
  const { blockedSet } = usePrivacyControls();
  const currentUserId = currentUser?.id;

  const feedState = useFeedState({
    type,
    userId,
    filters,
    reloadKey,
    isAuthenticated,
    currentUserId,
  });
  const {
    refresh: feedRefresh,
    loadMore: feedLoadMore,
    clearError: feedClearError,
    fetchInitial: feedFetchInitial,
  } = feedState;

  const [impressionRefresh, setImpressionRefresh] = useState(0);
  const refreshSession = useCallback(async () => {
    await feedRefresh();
    setImpressionRefresh((value) => value + 1);
  }, [feedRefresh]);
  useFeedLiveUpdates(type, refreshSession, canUsePrivateApi);

  // Slices (or items) into rows with thread state, the server's recommendation
  // cards spliced in, and a preview's bound applied.
  const allFeedRows = useDeepCompareMemo(
    (): FeedRow[] =>
      buildFeedRows({
        slices: feedState.slices,
        items: feedState.items,
        interstitials: feedState.interstitials,
        type,
        currentUserId,
        blockedSet,
        threaded,
        threadPostId,
        leadingPostId: merged.leadingPostId,
      }),
    [
      feedState.slices,
      feedState.items,
      feedState.interstitials,
      type,
      currentUserId,
      blockedSet,
      threaded,
      threadPostId,
      merged.leadingPostId,
    ],
  );
  // Memoized explicitly, not left to the compiler: these rows are FlashList's
  // `data`, and a new array identity re-renders every mounted row.
  const feedRows = useMemo(
    () => boundFeedRows(allFeedRows, previewLimit),
    [allFeedRows, previewLimit],
  );

  // The feed has settled on its first content: rows, or an empty or failed read.
  const settled = feedRows.length > 0 || !feedState.isLoading;
  const holdForLeading = useHoldForLeading(merged.leadingPending, settled);
  // A feed is its page's first content: the pager mounts the pages beside this one only once
  // it is on screen, so they do not compete with its first paint (Home's neighbour is the
  // Videos tab, with its reel and its player).
  useTabPageContentPainted(settled);

  // Infinite scroll for everyone, anonymous included. An anonymous reader is
  // never prompted to sign in by scrolling: `signIn()` opens the SDK sheet, and
  // opening it from here hijacked public browse one fling in (#1272). The
  // footer's tap is the only sign-in affordance. A bounded preview never pages.
  //
  // The one exception is a minor's account (oxy ADR 0068): its feed loads on
  // request. This handler is the list's end-reached trigger, so it does nothing
  // there and the footer's "Load more" is how the next page is asked for.
  const loadsOnRequest = useAgeProtections().feedProfile === 'protected';
  const handleLoadMore = useCallback(() => {
    // A header drawn alone is not the end of the list.
    if (rowsDeferred) return;
    if (
      !canAutoLoadFeed({
        previewLimit,
        hasMore: feedState.hasMore,
        isLoading: feedState.isLoading,
        loadsOnRequest,
      })
    )
      return;
    feedLoadMore();
  }, [
    rowsDeferred,
    previewLimit,
    feedState.hasMore,
    feedState.isLoading,
    loadsOnRequest,
    feedLoadMore,
  ]);

  const handleRetry = useCallback(async () => {
    feedClearError();
    try {
      await feedFetchInitial(true);
    } catch (retryError) {
      // `fetchInitial` reports its own failures and resolves; anything that
      // escapes it is a transport failure the feed has already retried, so
      // it is a warn with a bounded context, not a red console entry.
      logFeedFailure(logger, 'Feed retry failed', classifyFeedFailure(retryError));
    }
  }, [feedClearError, feedFetchInitial]);

  // Native shows a pull-to-refresh spinner from `refreshing`; web reaches the
  // same refresh from the home signal or a tab re-press, where a swallowed
  // failure would surface as an unhandled rejection.
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([refreshSession(), onRefresh?.()]);
    } catch (err) {
      logFeedFailure(logger, 'Feed refresh failed', classifyFeedFailure(err));
    } finally {
      setRefreshing(false);
    }
  }, [refreshSession, onRefresh]);

  // Feed-ranking telemetry. The session resets when the descriptor changes or
  // the feed is reloaded, so impressions count once per post per session.
  // `canUsePrivateApi` keeps an anonymous (or still-resolving) viewer from ever
  // POSTing, which would 401 `/feed/mtn/interactions` in a loop.
  const feedDescriptor = resolveFeedDescriptor(type, userId, filters);
  const impressionTracker = useFeedImpressionTracker(
    feedDescriptor,
    JSON.stringify([currentUserId, reloadKey, impressionRefresh]),
    canUsePrivateApi,
    currentUserId,
  );
  useFeedVisibility(impressionTracker);

  const receivesOwnNewPost = feedReceivesOwnNewPost({ type, userId, filters, currentUserId });

  // While the pinned post holds the first presentation, the feed is still
  // "loading": no rows, no leading element, no footer.
  const presentedRows = holdForLeading || rowsDeferred ? EMPTY_ROWS : feedRows;
  const isLoadingMore = feedState.isLoading && presentedRows.length > 0;
  // `error` is reported only while nothing is in flight, so with rows on screen
  // it is the next page that failed, not the feed.
  const loadMoreFailed = Boolean(feedState.error) && presentedRows.length > 0;
  const paged = previewLimit === undefined && presentedRows.length > 0;
  // A feed that loads on request offers its next page instead of fetching it.
  const offersLoadMore = loadsOnRequest && paged && feedState.hasMore && !feedState.isLoading;
  // The end of a home timeline, said out loud: there is nothing more to read,
  // rather than a list that just stops. For everyone, not only a minor.
  const caughtUp =
    paged &&
    isAuthenticated &&
    !feedState.hasMore &&
    !feedState.isLoading &&
    !feedState.error &&
    showsCaughtUp(feedDescriptor);
  const showFooter =
    isLoadingMore ||
    loadMoreFailed ||
    offersLoadMore ||
    caughtUp ||
    (!isAuthenticated && presentedRows.length > 0);

  const { listHeaderComponent, listTopComponent, showComposeButton, onComposePress, hideHeader } =
    merged;
  const header = useMemo(() => {
    const own = listHeaderComponent ?? (
      <FeedHeader
        showComposeButton={showComposeButton}
        onComposePress={onComposePress}
        hideHeader={hideHeader}
      />
    );
    return listTopComponent ? (
      <>
        {listTopComponent}
        {own}
      </>
    ) : (
      own
    );
  }, [listHeaderComponent, listTopComponent, showComposeButton, onComposePress, hideHeader]);

  const isThread = type === 'replies' && Boolean(filters?.parentPostId || filters?.postId);
  const emptyState = useMemo(
    () => (
      <FeedEmptyState
        isLoading={feedState.isLoading || holdForLeading}
        error={feedState.error}
        errorKind={feedState.errorKind}
        hasItems={Boolean(merged.listLeadingComponent) && !holdForLeading}
        type={type}
        onRetry={handleRetry}
        pending={feedState.pending}
        isThread={isThread}
      />
    ),
    [
      feedState.isLoading,
      holdForLeading,
      merged.listLeadingComponent,
      feedState.error,
      feedState.errorKind,
      type,
      handleRetry,
      feedState.pending,
      isThread,
    ],
  );

  const footerHasMore = previewLimit === undefined && feedState.hasMore;
  const hasPresentedRows = presentedRows.length > 0;
  const footer = useMemo(
    () =>
      showFooter ? (
        <FeedFooter
          hasMore={footerHasMore}
          isLoadingMore={isLoadingMore}
          hasItems={hasPresentedRows}
          loadFailed={loadMoreFailed}
          onRetryLoadMore={feedLoadMore}
          loadOnRequest={offersLoadMore}
          caughtUp={caughtUp}
        />
      ) : null,
    [
      showFooter,
      footerHasMore,
      isLoadingMore,
      hasPresentedRows,
      loadMoreFailed,
      feedLoadMore,
      offersLoadMore,
      caughtUp,
    ],
  );

  return {
    props: merged,
    t,
    theme,
    router,
    openPostEngagement,
    feedState,
    /** The rows to present: empty while the pinned post holds the first paint. */
    feedRows: presentedRows,
    holdForLeading,
    /** The leading element, or nothing while it holds the first paint. */
    leading: holdForLeading ? null : (merged.listLeadingComponent ?? null),
    handleLoadMore,
    handleRetry,
    handleRefresh,
    refreshing,
    feedDescriptor,
    impressionTracker,
    receivesOwnNewPost,
    header,
    emptyState: rowsDeferred ? null : emptyState,
    footer: rowsDeferred ? null : footer,
  };
}

const EMPTY_ROWS: FeedRow[] = [];

function logBoundaryError(error: Error, errorInfo: React.ErrorInfo): void {
  recoverChunkError(error);
  logger.error('Error caught by boundary', error, { errorInfo });
}

/** The error boundary every feed renders inside, with the same copy on both platforms. */
export function FeedErrorBoundary({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <ErrorBoundary
      title={t('error.boundary.title')}
      message={t('error.boundary.message')}
      retryLabel={t('error.boundary.retry')}
      onError={logBoundaryError}
    >
      {children}
    </ErrorBoundary>
  );
}

/**
 * When a feed re-renders from its parent. Filters are compared shallowly so a
 * new object with the same values does not refetch.
 */
export function areFeedPropsEqual(prevProps: FeedProps, nextProps: FeedProps): boolean {
  if (
    prevProps.reloadKey !== nextProps.reloadKey ||
    prevProps.type !== nextProps.type ||
    prevProps.userId !== nextProps.userId ||
    prevProps.scrollEnabled !== nextProps.scrollEnabled ||
    prevProps.previewLimit !== nextProps.previewLimit ||
    prevProps.threaded !== nextProps.threaded ||
    prevProps.threadPostId !== nextProps.threadPostId ||
    prevProps.listHeaderComponent !== nextProps.listHeaderComponent ||
    prevProps.listTopComponent !== nextProps.listTopComponent ||
    prevProps.listContentHeaderComponent !== nextProps.listContentHeaderComponent ||
    prevProps.listStickyHeaderComponent !== nextProps.listStickyHeaderComponent ||
    prevProps.listLeadingComponent !== nextProps.listLeadingComponent ||
    prevProps.leadingPostId !== nextProps.leadingPostId ||
    prevProps.leadingPending !== nextProps.leadingPending ||
    prevProps.rowsDeferred !== nextProps.rowsDeferred
  ) {
    return false;
  }
  return shallowFiltersEqual(prevProps.filters, nextProps.filters);
}
