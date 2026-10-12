import React, { useCallback, useMemo, useState } from 'react';
import type { View } from 'react-native';
import type { FeedType } from '@mention/shared-types';
import { ErrorBoundary } from '@oxy.so/bloom/error-boundary';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTheme } from '@oxy.so/bloom/theme';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { createLogger } from '@oxy.so/core/logger';
import { useFeedState } from '@/hooks/useFeedState';
import { useDeepCompareMemo } from '@/hooks/useDeepCompare';
import { usePrivacyControls } from '@/hooks/usePrivacyControls';
import { FeedFilters, feedReceivesOwnNewPost, shallowFiltersEqual } from '@/utils/feedUtils';
import { resolveFeedDescriptor, useFeedImpressionTracker } from '@/utils/feedTelemetry';
import { classifyFeedFailure, logFeedFailure } from '@/utils/feedRetry';
import { FeedHeader } from './FeedHeader';
import { FeedFooter } from './FeedFooter';
import { FeedEmptyState } from './FeedEmptyState';
import { useHoldForLeading } from './holdForLeading';
import { type FeedRow, buildFeedRows } from './feedRows';
import { boundFeedRows, canLoadMoreFeed } from './feedPaging';

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

export type ResolvedFeedProps = FeedProps & Required<Pick<FeedProps, DefaultedFeedProp>>;

export function useFeedCore(props: FeedProps) {
  const merged: ResolvedFeedProps = { ...DEFAULT_FEED_PROPS, ...props };
  const { type, userId, filters, reloadKey, threaded, threadPostId, previewLimit, onRefresh } =
    merged;

  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const { user: currentUser, isAuthenticated, canUsePrivateApi } = useAuth();
  const { blockedSet } = usePrivacyControls();
  const currentUserId = currentUser?.id;

  const feedState = useFeedState({
    type,
    userId,
    filters,
    useScoped: !!(filters && Object.keys(filters).length),
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
    ],
  );
  // Memoized explicitly, not left to the compiler: these rows are FlashList's
  // `data`, and a new array identity re-renders every mounted row.
  const feedRows = useMemo(
    () => boundFeedRows(allFeedRows, previewLimit),
    [allFeedRows, previewLimit],
  );

  const holdForLeading = useHoldForLeading(
    merged.leadingPending,
    feedRows.length > 0 || !feedState.isLoading,
  );

  // Infinite scroll for everyone, anonymous included. An anonymous reader is
  // never prompted to sign in by scrolling: `signIn()` opens the SDK sheet, and
  // opening it from here hijacked public browse one fling in (#1272). The
  // footer's tap is the only sign-in affordance. A bounded preview never pages.
  const handleLoadMore = useCallback(() => {
    if (
      !canLoadMoreFeed({ previewLimit, hasMore: feedState.hasMore, isLoading: feedState.isLoading })
    )
      return;
    feedLoadMore();
  }, [previewLimit, feedState.hasMore, feedState.isLoading, feedLoadMore]);

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
      await Promise.all([feedRefresh(), onRefresh?.()]);
    } catch (err) {
      logFeedFailure(logger, 'Feed refresh failed', classifyFeedFailure(err));
    } finally {
      setRefreshing(false);
    }
  }, [feedRefresh, onRefresh]);

  // Feed-ranking telemetry. The session resets when the descriptor changes or
  // the feed is reloaded, so impressions count once per post per session.
  // `canUsePrivateApi` keeps an anonymous (or still-resolving) viewer from ever
  // POSTing, which would 401 `/feed/mtn/interactions` in a loop.
  const feedDescriptor = resolveFeedDescriptor(type, userId, filters);
  const impressionTracker = useFeedImpressionTracker(feedDescriptor, reloadKey, canUsePrivateApi);

  const receivesOwnNewPost = feedReceivesOwnNewPost({ type, userId, filters, currentUserId });

  // While the pinned post holds the first presentation, the feed is still
  // "loading": no rows, no leading element, no footer.
  const presentedRows = holdForLeading ? EMPTY_ROWS : feedRows;
  const isLoadingMore = feedState.isLoading && presentedRows.length > 0;
  const showFooter = isLoadingMore || (!isAuthenticated && presentedRows.length > 0);

  const { listHeaderComponent, showComposeButton, onComposePress, hideHeader } = merged;
  const header = useMemo(
    () =>
      listHeaderComponent ?? (
        <FeedHeader
          showComposeButton={showComposeButton}
          onComposePress={onComposePress}
          hideHeader={hideHeader}
        />
      ),
    [listHeaderComponent, showComposeButton, onComposePress, hideHeader],
  );

  const isThread = type === 'replies' && Boolean(filters?.parentPostId || filters?.postId);
  const emptyState = useMemo(
    () => (
      <FeedEmptyState
        isLoading={feedState.isLoading || holdForLeading}
        error={feedState.error}
        errorKind={feedState.errorKind}
        hasItems={false}
        type={type}
        onRetry={handleRetry}
        pending={feedState.pending}
        isThread={isThread}
      />
    ),
    [
      feedState.isLoading,
      holdForLeading,
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
        />
      ) : null,
    [showFooter, footerHasMore, isLoadingMore, hasPresentedRows],
  );

  return {
    props: merged,
    t,
    theme,
    router,
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
    emptyState,
    footer,
  };
}

const EMPTY_ROWS: FeedRow[] = [];

function logBoundaryError(error: Error, errorInfo: React.ErrorInfo): void {
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
    prevProps.listContentHeaderComponent !== nextProps.listContentHeaderComponent ||
    prevProps.listStickyHeaderComponent !== nextProps.listStickyHeaderComponent ||
    prevProps.listLeadingComponent !== nextProps.listLeadingComponent ||
    prevProps.leadingPending !== nextProps.leadingPending
  ) {
    return false;
  }
  return shallowFiltersEqual(prevProps.filters, nextProps.filters);
}
