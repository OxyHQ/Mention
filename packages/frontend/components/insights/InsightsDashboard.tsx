import type React from 'react';
import { Fragment, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import {
  BarListCard,
  ChartCardSurface,
  ChartHeadline,
  LineChartCard,
  HeatmapChartCard,
  StageBarsCard,
  SleepScoreCard,
  StepsCard,
  Sparkline,
  ChartStatTiles,
  RadarChartCard,
  ContributionsCard,
} from '@oxy.so/bloom/chart-cards';
import { Text } from '@oxy.so/bloom/typography';
import { Button } from '@oxy.so/bloom/button';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@oxy.so/bloom/accordion';
import { ResponsiveGrid } from '@oxy.so/bloom/grid';
import { Divider } from '@oxy.so/bloom/divider';
import PostItem from '@/components/Feed/PostItem';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import type { AccountInsights, EngagementRatios } from '@/services/insightsService';
import type { HydratedPost } from '@mention/shared-types';
import { HeartIcon } from '@/assets/icons/heart-icon';
import { CommentIcon } from '@/assets/icons/comment-icon';
import { BoostIcon } from '@/assets/icons/boost-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
import { CalendarIcon } from '@/assets/icons/calendar-icon';
import { formatCompactNumber } from '@/utils/formatNumber';
import {
  buildInsightsSeries,
  buildWeekdayInteractions,
  buildPublishingSummary,
} from './insightsSeries';

const PERIOD_OPTIONS = [
  { labelKey: 'insights.period.7days', value: 7 },
  { labelKey: 'insights.period.30days', value: 30 },
  { labelKey: 'insights.period.90days', value: 90 },
];

interface PeriodSelectorProps {
  selected: number;
  onSelect: (val: number) => void;
  t: (key: string) => string;
}

const PeriodSelector: React.FC<PeriodSelectorProps> = ({ selected, onSelect, t }) => (
  <View style={styles.periodRow}>
    <View style={styles.periodControl}>
      <SegmentedControl
        label={t('insights.title')}
        type="radio"
        value={String(selected)}
        onValueChange={(value) => onSelect(Number(value))}
      >
        {PERIOD_OPTIONS.map((opt) => (
          <SegmentedControlItem key={opt.value} value={String(opt.value)}>
            <SegmentedControlItemText>{t(opt.labelKey)}</SegmentedControlItemText>
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
    </View>
  </View>
);

export interface InsightsDashboardProps {
  stats: AccountInsights;
  engagementRatios: EngagementRatios;
  topPostsData: HydratedPost[];
  accountId?: string;
  selectedPeriod: number;
  handlePeriodChange: (days: number) => void;
  activeTab: 'overview' | 'engagement' | 'publishing';
  isFetching: boolean;
}

export function InsightsDashboard({
  stats,
  engagementRatios,
  topPostsData,
  accountId,
  selectedPeriod,
  handlePeriodChange,
  activeTab,
  isFetching,
}: InsightsDashboardProps) {
  const router = useRouter();
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState<string | string[] | undefined>();
  const numberFormat = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 0 });
  const decimalFormat = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
  const formatNumber = (value: number) => numberFormat.format(value);
  const formatPercent = (value: number) => `${decimalFormat.format(value)}%`;
  const formatDate = (date: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(date));

  const series = buildInsightsSeries(stats, i18n.language);
  const publishing = buildPublishingSummary(stats);
  const formats = Object.entries(stats.postsByType)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a);
  const leadingFormat = formats[0]?.[0];
  const weekdayInteractions = buildWeekdayInteractions(stats, i18n.language);
  const range = `${formatDate(stats.period.startDate)} – ${formatDate(stats.period.endDate)}`;
  const interactions = [
    {
      label: t('insights.post.likes'),
      value: stats.interactions.likes,
      icon: <HeartIcon size={16} className="text-foreground" />,
    },
    {
      label: t('insights.post.replies'),
      value: stats.interactions.replies,
      icon: <CommentIcon size={16} className="text-foreground" />,
    },
    {
      label: t('insights.post.boosts'),
      value: stats.interactions.boosts,
      icon: <BoostIcon size={16} className="text-foreground" />,
    },
    {
      label: t('insights.post.shares'),
      value: stats.interactions.shares,
      icon: <ShareIcon size={16} className="text-foreground" />,
    },
  ];
  const calendarDays = publishing.weekdays.total + publishing.weekends.total;
  const coverage = calendarDays ? (publishing.activeDays / calendarDays) * 100 : 0;
  const topInteraction = [...interactions].sort((a, b) => b.value - a.value)[0];
  const peakViews = [...series].sort((a, b) => b.value - a.value)[0];
  const weekdayTotals = weekdayInteractions.columns.map((label, index) => ({
    label,
    value: Object.values(weekdayInteractions.values).reduce(
      (sum, values) => sum + values[index],
      0,
    ),
  }));
  const strongestWeekday = [...weekdayTotals].sort((a, b) => b.value - a.value)[0];
  const interactionStats = [
    {
      label: t('insights.post.interactions'),
      value: formatNumber(stats.overview.totalInteractions),
    },
    {
      label: t('insights.mainInteraction'),
      value: topInteraction.value > 0 ? topInteraction.label : '—',
    },
    {
      label: t('insights.interactionsPerPostShort'),
      value: decimalFormat.format(stats.overview.averageEngagementPerPost),
    },
  ];
  const viewStats = [
    {
      label: t('insights.viewsPerPost'),
      value: decimalFormat.format(engagementRatios.averages.viewsPerPost),
    },
    { label: t('insights.topViewDate'), value: peakViews?.value > 0 ? peakViews.label : '—' },
    { label: t('insights.topDateViews'), value: formatNumber(peakViews?.value ?? 0) },
  ];
  const consistencyStats = [
    {
      label: t('insights.longestStreak'),
      value: t('insights.dayCount', { count: publishing.longestStreak }),
    },
    {
      label: t('insights.postsPerActiveDay'),
      value: decimalFormat.format(
        publishing.activeDays ? stats.overview.totalPosts / publishing.activeDays : 0,
      ),
    },
    { label: t('insights.publishingCoverage'), value: formatPercent(coverage) },
  ];
  const chartProps = {
    testID: 'insights-views-detail',
    data: series,
    title: t('insights.post.views'),
    headline: stats.overview.totalViews,
    stats: viewStats,
    format: formatNumber,
    getPointTitle: (_point: { label: string; value: number }, index: number) =>
      series[index].fullLabel,
    accessibilityLabel: t('insights.viewsByPublicationDate'),
  };
  const publishingCard = (
    <ContributionsCard
      testID="insights-contributions"
      initialScrollPosition="end"
      title={t('insights.publishingDays')}
      total={publishing.activeDays}
      format={formatNumber}
      periods={[]}
      months={[]}
      activityLabel={t('insights.publishingScope')}
      stats={[
        { label: t('insights.publishingCoverage'), value: formatPercent(coverage) },
        { label: t('insights.posts'), value: formatNumber(stats.overview.totalPosts) },
        {
          label: t('insights.longestStreak'),
          value: t('insights.dayCount', { count: publishing.longestStreak }),
        },
        {
          label: t('insights.postsPerActiveDay'),
          value: decimalFormat.format(
            publishing.activeDays ? stats.overview.totalPosts / publishing.activeDays : 0,
          ),
        },
      ]}
      columns={publishing.columns}
      cells={publishing.cells}
      getCellLabel={(cell) =>
        cell.date
          ? `${formatDate(cell.date)}: ${cell.count ? t('insights.published') : t('insights.noPublications')}`
          : t('insights.outsidePeriod')
      }
    />
  );
  const strongestDates = (
    <BarListCard
      testID="insights-top-dates"
      metricLabel={t('insights.publicationDates')}
      metric="value"
      format={formatNumber}
      limit={5}
      tabs={(['interactions', 'views'] as const).map((metric) => ({
        id: metric,
        label: t(`insights.post.${metric}`),
        items: [...stats.dailyBreakdown]
          .sort((a, b) => b[metric] - a[metric])
          .map((day) => ({ label: formatDate(day.date), value: day[metric] })),
      }))}
      stats={[
        { label: t('insights.activeDaysShort'), value: formatNumber(publishing.activeDays) },
        { label: t('insights.post.views'), value: formatNumber(stats.overview.totalViews) },
        {
          label: t('insights.post.interactions'),
          value: formatNumber(stats.overview.totalInteractions),
        },
      ]}
    />
  );
  const body = (
    <>
      <View style={styles.filters}>
        <View className="flex-row flex-wrap items-center justify-between gap-2">
          <PeriodSelector selected={selectedPeriod} onSelect={handlePeriodChange} t={t} />
          {!accountId && (
            <Button
              appearance="subtle"
              tone="neutral"
              size="sm"
              leading={<CalendarIcon size={16} className="text-foreground" />}
              onPress={() => router.push('/insights/weekly_recap')}
            >
              {t('insights.weeklyRecap.title')}
            </Button>
          )}
        </View>
        <Text className="text-xs text-muted-foreground" accessibilityLiveRegion="polite">
          {isFetching ? t('insights.updating') : `${range} · UTC`}
        </Text>
      </View>
      <Text className="text-sm text-muted-foreground">{t('insights.periodScope')}</Text>

      {activeTab === 'overview' ? (
        <>
          <ResponsiveGrid stretchItems testID="insights-summary-grid">
            <ChartCardSurface height="auto" testID="insights-views-summary">
              <View className="flex-row items-center justify-between gap-3">
                <ChartHeadline
                  label={t('insights.post.views')}
                  value={stats.overview.totalViews}
                  format={formatNumber}
                  caption={range}
                />
                <Sparkline
                  data={series.map((point) => point.value)}
                  width={96}
                  height={40}
                  shape="sharp"
                  accessibilityLabel={t('insights.viewsByPublicationDate')}
                />
              </View>
              <ChartStatTiles
                items={[
                  { label: t('insights.posts'), value: formatNumber(stats.overview.totalPosts) },
                  {
                    label: t('insights.post.interactions'),
                    value: formatNumber(stats.overview.totalInteractions),
                  },
                  {
                    label: t('insights.post.engagementRate'),
                    value: formatPercent(stats.overview.engagementRate),
                  },
                  {
                    label: t('insights.viewsPerPost'),
                    value: decimalFormat.format(engagementRatios.averages.viewsPerPost),
                  },
                  {
                    label: t('insights.interactionsPerPostShort'),
                    value: decimalFormat.format(stats.overview.averageEngagementPerPost),
                  },
                  {
                    label: t('insights.activeDaysShort'),
                    value: formatNumber(publishing.activeDays),
                  },
                ]}
              />
            </ChartCardSurface>

            <BarListCard
              title={t('insights.post.interactions')}
              metricLabel={t('insights.post.totalInteractions')}
              items={interactions}
              showShares
              stats={interactionStats}
              metric="value"
              format={formatNumber}
            />
          </ResponsiveGrid>
          <Accordion value={expanded} onValueChange={setExpanded}>
            <AccordionItem value="views">
              <AccordionTrigger>{t('insights.exploreViews')}</AccordionTrigger>
              <AccordionContent>
                {stats.period.days <= 7 ? (
                  <StepsCard
                    key={stats.period.days}
                    {...chartProps}
                    range={range}
                    totalSuffix={t('insights.post.views').toLowerCase()}
                    pointSuffix={t('insights.post.views').toLowerCase()}
                  />
                ) : (
                  <LineChartCard
                    key={stats.period.days}
                    {...chartProps}
                    shape="sharp"
                    formatAxisValue={formatCompactNumber}
                  />
                )}
                <Text variant="caption-1-regular">{t('insights.viewsByPublicationDate')}</Text>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
          {stats.topPosts.length > 0 && (
            <ResponsiveGrid testID="insights-posts-grid">
              <View className="gap-3">
                <Text variant="headline-medium">{t('insights.topPerformingPosts')}</Text>
                {topPostsData.length > 0 ? (
                  topPostsData.map((post, index) => (
                    <Fragment key={post.id}>
                      <PostItem post={post} />
                      {index < topPostsData.length - 1 ? <Divider /> : null}
                    </Fragment>
                  ))
                ) : (
                  <Text>{t('insights.unableToLoadPosts')}</Text>
                )}
              </View>
              <View className="gap-4">
                {publishingCard}
                {strongestDates}
                <Text variant="caption-1-regular">{t('insights.strongestDatesScope')}</Text>
              </View>
            </ResponsiveGrid>
          )}
        </>
      ) : activeTab === 'engagement' ? (
        <>
          <ResponsiveGrid stretchItems>
            <ChartCardSurface height="auto">
              <ChartHeadline
                label={t('insights.post.engagementRate')}
                value={engagementRatios.ratios.engagementRate}
                format={formatPercent}
                caption={t('insights.rateExplanation')}
              />
              <ChartStatTiles
                items={[
                  {
                    label: t('insights.post.views'),
                    value: formatNumber(stats.overview.totalViews),
                  },
                  { label: t('insights.posts'), value: formatNumber(stats.overview.totalPosts) },
                  {
                    label: t('insights.mainInteraction'),
                    value: topInteraction.value > 0 ? topInteraction.label : '—',
                  },
                ]}
              />
            </ChartCardSurface>
            <ChartCardSurface height="auto">
              <ChartHeadline
                label={t('insights.engagementPerPost')}
                value={engagementRatios.averages.engagementPerPost}
                format={(value) => decimalFormat.format(value)}
                caption={range}
              />
              <ChartStatTiles
                items={[
                  {
                    label: t('insights.post.interactions'),
                    value: formatNumber(engagementRatios.totals.interactions),
                  },
                  {
                    label: t('insights.activeDaysShort'),
                    value: formatNumber(publishing.activeDays),
                  },
                  {
                    label: t('insights.viewsPerPost'),
                    value: decimalFormat.format(engagementRatios.averages.viewsPerPost),
                  },
                ]}
              />
            </ChartCardSurface>
          </ResponsiveGrid>
          <ResponsiveGrid stretchItems testID="insights-engagement-grid">
            <RadarChartCard
              title={t('insights.engagementProfile')}
              variant="filled"
              tiles
              range={range}
              headline={engagementRatios.ratios.engagementRate}
              format={formatPercent}
              data={[
                { label: t('insights.post.likes'), rate: engagementRatios.ratios.likeRate },
                { label: t('insights.post.replies'), rate: engagementRatios.ratios.replyRate },
                { label: t('insights.post.boosts'), rate: engagementRatios.ratios.boostRate },
                { label: t('insights.post.shares'), rate: engagementRatios.ratios.shareRate },
              ]}
              series={[{ key: 'rate', label: t('insights.ofViews') }]}
            />
            <HeatmapChartCard
              title={t('insights.interactionsByWeekday')}
              range={range}
              stats={[
                {
                  label: t('insights.topWeekday'),
                  value: strongestWeekday.value > 0 ? strongestWeekday.label : '—',
                },
                {
                  label: t('insights.topWeekdayInteractions'),
                  value: formatNumber(strongestWeekday.value),
                },
                {
                  label: t('insights.activeDaysShort'),
                  value: formatNumber(publishing.activeDays),
                },
              ]}
              headline={stats.overview.totalInteractions}
              columns={weekdayInteractions.columns}
              rows={(['likes', 'replies', 'boosts', 'shares'] as const).map((kind) => ({
                label: t(`insights.post.${kind}`),
                values: weekdayInteractions.values[kind],
              }))}
              format={formatNumber}
              legendLabels={[t('insights.fewer'), t('insights.more')]}
            />
          </ResponsiveGrid>
          <Text className="text-xs text-muted-foreground">{t('insights.weekdayScope')}</Text>
          <ResponsiveGrid stretchItems>
            <BarListCard
              title={t('insights.engagementRatios')}
              stats={[
                { label: t('insights.post.views'), value: formatNumber(stats.overview.totalViews) },
                {
                  label: t('insights.post.interactions'),
                  value: formatNumber(stats.overview.totalInteractions),
                },
              ]}
              metricLabel={t('insights.ofViews')}
              metric="value"
              format={formatPercent}
              items={[
                { label: t('insights.likeRate'), value: engagementRatios.ratios.likeRate },
                { label: t('insights.replyRate'), value: engagementRatios.ratios.replyRate },
                { label: t('insights.boostRate'), value: engagementRatios.ratios.boostRate },
                { label: t('insights.shareRate'), value: engagementRatios.ratios.shareRate },
              ]}
            />
            <BarListCard
              title={t('insights.engagementPerPost')}
              stats={[
                { label: t('insights.posts'), value: formatNumber(stats.overview.totalPosts) },
                {
                  label: t('insights.viewsPerPost'),
                  value: decimalFormat.format(engagementRatios.averages.viewsPerPost),
                },
              ]}
              metricLabel={t('insights.perPost')}
              metric="value"
              format={(value) => decimalFormat.format(value)}
              items={interactions.map((item) => ({
                ...item,
                value: stats.overview.totalPosts ? item.value / stats.overview.totalPosts : 0,
              }))}
            />
          </ResponsiveGrid>
        </>
      ) : (
        <>
          <ResponsiveGrid stretchItems testID="insights-publishing-grid">
            {publishingCard}
            {Object.keys(stats.postsByType).length > 0 && (
              <StageBarsCard
                title={t('insights.publishingMix')}
                range={range}
                headline={stats.overview.totalPosts}
                percentageBase="total"
                stats={[
                  { label: t('insights.formatsUsed'), value: String(formats.length) },
                  {
                    label: t('insights.leadingFormat'),
                    value: leadingFormat
                      ? t(`insights.postType.${leadingFormat}`, { defaultValue: leadingFormat })
                      : '—',
                  },
                  {
                    label: t('insights.postsPerDay'),
                    value: decimalFormat.format(
                      stats.period.days > 0 ? stats.overview.totalPosts / stats.period.days : 0,
                    ),
                  },
                ]}
                stages={formats.map(([type, value]) => ({
                  label: t(`insights.postType.${type}`, { defaultValue: type }),
                  value,
                }))}
                format={formatNumber}
              />
            )}
          </ResponsiveGrid>
          <ResponsiveGrid stretchItems testID="insights-publishing-detail-grid">
            <SleepScoreCard
              testID="publishing-consistency"
              title={t('insights.publishingConsistency')}
              range={range}
              stats={consistencyStats}
              scoreLabel={t('insights.publishedDayRatio', {
                count: publishing.activeDays,
                total: publishing.weekdays.total + publishing.weekends.total,
              })}
              accessibilityLabel={t('insights.publishedDayRatio', {
                count: publishing.activeDays,
                total: publishing.weekdays.total + publishing.weekends.total,
              })}
              metrics={[
                {
                  label: t('insights.weekdays'),
                  detail: t('insights.publishedDays'),
                  score: publishing.weekdays.active,
                  max: publishing.weekdays.total,
                },
                {
                  label: t('insights.weekends'),
                  detail: t('insights.publishedDays'),
                  score: publishing.weekends.active,
                  max: publishing.weekends.total,
                },
              ]}
            />
            {strongestDates}
          </ResponsiveGrid>
          <Text variant="caption-1-regular">{t('insights.strongestDatesScope')}</Text>
        </>
      )}
    </>
  );
  return <View style={styles.scrollContent}>{body}</View>;
}

const styles = StyleSheet.create({
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
    gap: 16,
  },
  periodRow: {
    marginBottom: 4,
  },
  periodControl: {
    alignItems: 'flex-start',
  },
  filters: { gap: 8 },
});
