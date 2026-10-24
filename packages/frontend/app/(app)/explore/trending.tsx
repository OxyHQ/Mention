import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { Fragment, useCallback, useEffect, useMemo } from 'react';
import { View, Text, Pressable, Platform } from 'react-native';
import { RiNodeTree } from '@oxy.so/bloom/icons/RiNodeTree';
import { ScreenScrollView, useScreenReselectHandler } from '@oxy.so/bloom/screen';
import { VirtualList } from '@oxy.so/bloom/list';
import { useTheme } from '@oxy.so/bloom/theme';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useRouter } from '@/lib/navigation/router';

import { trendingService, type TrendingTopic, type TrendingDay } from '@/services/trendingService';
import { EmptyState } from '@/components/common/EmptyState';
import { TrendItemRow } from '@/components/trending/TrendItemRow';
import { useTrendNavigation } from '@/hooks/useTrendNavigation';
import { useTrendItemMenu } from '@/hooks/useTrendItemMenu';
import { useTrendsStore } from '@/stores/trendsStore';
import type { Trend } from '@/interfaces/Trend';
import { FONT_SIZES } from '@/styles/typography';
import { publicQueryKeys } from '@/lib/viewerQueryKeys';

/**
 * Explore › Trending (route `/explore/trending`).
 *
 * Merges the two previous trending surfaces into one screen so nothing is lost:
 *  - "Trending now" — the LIVE current trends from the realtime trends store
 *    (the old in-Explore Trending tab), with the AI summary as a header. This is
 *    the authoritative today view, refreshed via socket + polling.
 *  - Past days — the paginated trending HISTORY (the old standalone `/trending`
 *    screen), grouped by day. Today's history day is skipped to avoid duplicating
 *    the live "Trending now" section above it.
 */

interface TrendSection {
  key: string;
  title: string;
  data: Trend[];
}

/** One row of the flattened list: a section's heading, or a trend within it. */
type TrendRow =
  | { kind: 'header'; section: TrendSection }
  | { kind: 'trend'; section: TrendSection; trend: Trend; index: number };

const IS_WEB = Platform.OS === 'web';

function rowKey(row: TrendRow): string {
  return row.kind === 'header'
    ? `header-${row.section.key}`
    : `${row.section.key}-${row.trend.id || row.trend.text}-${row.index}`;
}

/** Section key of the live "Trending now" block; every other section is a past day. */
const LIVE_SECTION_KEY = 'now';

/** History page size (days per request). */
const HISTORY_PAGE_SIZE = 5;

/** Trending history stays fresh for 5 minutes before a background refetch. */
const HISTORY_STALE_TIME_MS = 5 * 60_000;

function formatDayLabel(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00`);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (target.getTime() === today.getTime()) return 'Today';
  if (target.getTime() === yesterday.getTime()) return 'Yesterday';

  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Local `YYYY-MM-DD` for today — used to drop the history day the live section covers. */
function localTodayKey(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function topicToTrend(topic: TrendingTopic): Trend {
  const momentum = topic.momentum || 0;
  let direction: Trend['direction'] = 'flat';
  if (momentum > 0.3) direction = 'up';
  else if (momentum < -0.1) direction = 'down';

  return {
    id: topic.name,
    type: (topic.type || 'hashtag') as Trend['type'],
    text: topic.name,
    // Same coalesce as the store's: a row from before labelling shows its term
    // rather than nothing, and no renderer below here decides this again.
    displayName: topic.displayName?.trim() || topic.name,
    ...(topic.category ? { category: topic.category } : {}),
    ...(topic.startedAt ? { startedAt: topic.startedAt } : {}),
    ...(topic.firstSeenAt ? { firstSeenAt: topic.firstSeenAt } : {}),
    ...(topic.status ? { status: topic.status } : {}),
    ...(typeof topic.authorCount === 'number' ? { authorCount: topic.authorCount } : {}),
    ...(topic.actors?.length ? { actors: topic.actors } : {}),
    hashtag: topic.type === 'hashtag' ? `#${topic.name}` : topic.name,
    description: topic.description || '',
    score: topic.score || 0,
    volume: topic.volume || 0,
    momentum,
    rank: topic.rank || 0,
    created_at: topic.calculatedAt || '',
    direction,
  };
}

export default function ExploreTrendingScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const { navigateToTrend } = useTrendNavigation();
  const getTrendMenuActions = useTrendItemMenu();

  // Live current trends (realtime store): same single source the right-rail
  // TrendsWidget reads. Start polling on mount (idempotent) so a direct deep-link
  // to this tab still populates "Trending now" even when no widget is mounted.
  const trends = useTrendsStore((state) => state.trends);
  const summary = useTrendsStore((state) => state.summary);
  const hiddenTrendIds = useTrendsStore((state) => state.hiddenTrendIds);
  const trendsLoading = useTrendsStore((state) => state.isLoading);
  const fetchTrends = useTrendsStore((state) => state.fetchTrends);
  const startPolling = useTrendsStore((state) => state.startPolling);
  const stopPolling = useTrendsStore((state) => state.stopPolling);

  useEffect(() => {
    const subscriptionId = startPolling();
    return () => stopPolling(subscriptionId);
  }, [startPolling, stopPolling]);

  const visibleTrends = useMemo(
    () => (trends || []).filter((trend) => !hiddenTrendIds.includes(trend.id)),
    [trends, hiddenTrendIds],
  );

  // Paginated trending history (past days).
  const historyQuery = useInfiniteQuery({
    queryKey: publicQueryKeys.trendingHistory(),
    queryFn: ({ pageParam }) => trendingService.getTrendingHistory(pageParam, HISTORY_PAGE_SIZE),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.page < lastPage.totalPages ? lastPage.page + 1 : undefined,
    staleTime: HISTORY_STALE_TIME_MS,
  });

  const historyDays = useMemo<TrendingDay[]>(
    () => historyQuery.data?.pages.flatMap((page) => page.days) ?? [],
    [historyQuery.data],
  );

  const sections = useMemo<TrendSection[]>(() => {
    const result: TrendSection[] = [];
    if (visibleTrends.length > 0) {
      result.push({ key: LIVE_SECTION_KEY, title: t('Trending now'), data: visibleTrends });
    }
    const todayKey = localTodayKey();
    for (const day of historyDays) {
      if (day.date === todayKey) continue; // "Trending now" already covers today
      const dayTrends = day.trends.map(topicToTrend);
      if (dayTrends.length === 0) continue;
      result.push({
        key: day.date,
        title: `${formatDayLabel(day.date)} · ${dayTrends.length} trend${dayTrends.length !== 1 ? 's' : ''}`,
        data: dayTrends,
      });
    }
    return result;
  }, [visibleTrends, historyDays, t]);

  const rows = useMemo<TrendRow[]>(
    () =>
      sections.flatMap((section): TrendRow[] => [
        { kind: 'header', section },
        ...section.data.map((trend, index) => ({
          kind: 'trend' as const,
          section,
          trend,
          index,
        })),
      ]),
    [sections],
  );

  // Section headings stick while their trends scroll under them.
  const headerIndices = useMemo(
    () => rows.flatMap((row, index) => (row.kind === 'header' ? [index] : [])),
    [rows],
  );

  const handleRefresh = useCallback(() => {
    void fetchTrends();
    void historyQuery.refetch();
  }, [fetchTrends, historyQuery]);
  useScreenReselectHandler({ refresh: handleRefresh });

  const handleLoadMore = useCallback(() => {
    if (historyQuery.hasNextPage && !historyQuery.isFetchingNextPage) {
      void historyQuery.fetchNextPage();
    }
  }, [historyQuery]);

  // The live section and the archive are different surfaces, not one screen:
  // a press on "Trending now" is a press on a recommendation, while a press on
  // a past day is a press on history — and only the former carries a `recId`.
  const handleTrendPress = useCallback(
    (trend: Trend, section: TrendSection, index: number) => {
      navigateToTrend(trend, section.key === LIVE_SECTION_KEY ? 'explore' : 'history', index + 1);
    },
    [navigateToTrend],
  );

  const renderRow = useCallback(
    (row: TrendRow) =>
      row.kind === 'header' ? (
        <View className="px-4 py-2" style={{ backgroundColor: theme.colors.backgroundSecondary }}>
          <Text className="text-muted-foreground font-medium" style={{ fontSize: FONT_SIZES.sm }}>
            {row.section.title}
          </Text>
        </View>
      ) : (
        <View className="px-4">
          <TrendItemRow
            trend={row.trend}
            // Position within THIS section's rendered rows. `trend.rank` is the
            // rank across the whole unfiltered batch, so it shows gaps here as
            // soon as a reader hides one — and it means nothing at all in a
            // history section, whose rows come from a different day's batch.
            ordinal={row.index + 1}
            onPress={(trend) => handleTrendPress(trend, row.section, row.index)}
            // Parity with the widget: a trend could be hidden from the rail but
            // not from the screen that exists to browse trends.
            getMenuActions={getTrendMenuActions}
            showBorder
            size="large"
          />
        </View>
      ),
    [theme, handleTrendPress, getTrendMenuActions],
  );

  // The relation graph explains this list, so its way in belongs ON the list.
  // Rendered unconditionally: an entry point that appears only when there
  // happens to be a summary is an entry point most readers never see.
  const renderHeader = useCallback(
    () => (
      <View className="px-4 pt-3 pb-1 gap-2">
        {summary ? (
          <Text
            className="text-muted-foreground"
            style={{ fontSize: FONT_SIZES.sm, lineHeight: 18 }}
          >
            {summary}
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push('/trend-graph')}
          className="flex-row items-center gap-1 self-start"
        >
          <RiNodeTree width={14} height={14} fill={theme.colors.primary} />
          <Text className="text-primary" style={{ fontSize: FONT_SIZES.sm }}>
            {t('trendGraph.openLink')}
          </Text>
        </Pressable>
      </View>
    ),
    [summary, router, theme, t],
  );

  const renderFooter = useCallback(() => {
    if (!historyQuery.isFetchingNextPage) return null;
    return <ListSkeleton count={2} />;
  }, [historyQuery.isFetchingNextPage]);

  const isInitialLoading = historyQuery.isPending && visibleTrends.length === 0 && trendsLoading;

  if (isInitialLoading) {
    return <ListSkeleton />;
  }

  const empty = <EmptyState sticker="trending" title="No trending topics available" />;

  // WEB: the screen scroller is the document, so the rows render in normal flow
  // and paginate from the window's end. NATIVE: a virtualized list bound to the
  // Explore screen.
  if (IS_WEB) {
    return (
      <ScreenScrollView onEndReached={handleLoadMore} onEndReachedThreshold={0.5}>
        {renderHeader()}
        {rows.length === 0
          ? empty
          : rows.map((row) => <Fragment key={rowKey(row)}>{renderRow(row)}</Fragment>)}
        {renderFooter()}
      </ScreenScrollView>
    );
  }

  return (
    <VirtualList
      screen={{}}
      data={rows}
      renderItem={({ item }) => renderRow(item)}
      getItemType={(row) => row.kind}
      keyExtractor={rowKey}
      stickyHeaderIndices={headerIndices}
      ListHeaderComponent={renderHeader}
      ListFooterComponent={renderFooter}
      onEndReached={handleLoadMore}
      onEndReachedThreshold={0.5}
      onRefresh={handleRefresh}
      refreshing={trendsLoading || historyQuery.isRefetching}
      ListEmptyComponent={empty}
    />
  );
}
