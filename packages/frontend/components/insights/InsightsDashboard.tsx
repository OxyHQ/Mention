import type React from 'react';
import { Fragment, useMemo, useState } from 'react';
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
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@oxy.so/bloom/accordion';
import { PostItem } from '@/components/Feed/PostItem.bloom';
import { useOpenPostEngagement } from '@/components/Post/postEngagementContext';
import type { AccountInsights, EngagementRatios } from '@/services/insightsService';
import type { HydratedPost } from '@mention/shared-types';
import { RiCalendarEventLine } from '@oxy.so/bloom/icons/RiCalendarEventLine';
import { RiChat3Line } from '@oxy.so/bloom/icons/RiChat3Line';
import { RiHeart3Line } from '@oxy.so/bloom/icons/RiHeart3Line';
import { RiRepeat2Line } from '@oxy.so/bloom/icons/RiRepeat2Line';
import { RiUpload2Line } from '@oxy.so/bloom/icons/RiUpload2Line';
import { formatCompactNumber } from '@/utils/formatNumber';
import {
  buildInsightsSeries,
  buildWeekdayInteractions,
  buildPublishingSummary,
} from './insightsSeries';

import {
  Button as LButton,
  Divider as LDivider,
  Embed,
  Grid,
  HStack,
  Icon,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';
import { Option, Segmented } from '@oxy.so/bloom-language/inputs';

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

const PeriodSelector: React.FC<PeriodSelectorProps> = ({ selected, onSelect, t }) =>
  toElement(
    VStack(
      VStack(
        Segmented(
          [String(selected), (value) => onSelect(Number(value))],
          PERIOD_OPTIONS.map((opt) => Option(String(opt.value), t(opt.labelKey))),
        ).label(t('insights.title')),
      ).align('start'),
    ).margin('bottom', 'xs'),
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
  const openPostEngagement = useOpenPostEngagement();
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState<string | string[] | undefined>();
  const { formatNumber, formatDecimal, formatPercent, formatDate } = useMemo(() => {
    const numberFormat = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 0 });
    const decimalFormat = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
    const dateFormat = new Intl.DateTimeFormat(i18n.language, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
    return {
      formatNumber: (value: number) => numberFormat.format(value),
      formatDecimal: (value: number) => decimalFormat.format(value),
      formatPercent: (value: number) => `${decimalFormat.format(value)}%`,
      formatDate: (date: string) => dateFormat.format(new Date(date)),
    };
  }, [i18n.language]);

  const series = useMemo(() => buildInsightsSeries(stats, i18n.language), [stats, i18n.language]);
  const publishing = buildPublishingSummary(stats);
  const formats = Object.entries(stats.postsByType)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a);
  const leadingFormat = formats[0]?.[0];
  const weekdayInteractions = useMemo(
    () => buildWeekdayInteractions(stats, i18n.language),
    [stats, i18n.language],
  );
  const range = `${formatDate(stats.period.startDate)} – ${formatDate(stats.period.endDate)}`;
  const interactions = [
    {
      label: t('insights.post.likes'),
      value: stats.interactions.likes,
      icon: toElement(Icon(RiHeart3Line).size('sm').foreground('foreground')),
    },
    {
      label: t('insights.post.replies'),
      value: stats.interactions.replies,
      icon: toElement(Icon(RiChat3Line).size('sm').foreground('foreground')),
    },
    {
      label: t('insights.post.boosts'),
      value: stats.interactions.boosts,
      icon: toElement(Icon(RiRepeat2Line).size('sm').foreground('foreground')),
    },
    {
      label: t('insights.post.shares'),
      value: stats.interactions.shares,
      icon: toElement(Icon(RiUpload2Line).size('sm').foreground('foreground')),
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
      value: formatDecimal(stats.overview.averageEngagementPerPost),
    },
  ];
  const viewStats = [
    {
      label: t('insights.viewsPerPost'),
      value: formatDecimal(engagementRatios.averages.viewsPerPost),
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
      value: formatDecimal(
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
          value: formatDecimal(
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
      {toElement(
        VStack(
          HStack(
            Embed(<PeriodSelector selected={selectedPeriod} onSelect={handlePeriodChange} t={t} />),
            !accountId
              ? LButton(
                  Icon(RiCalendarEventLine).size('sm').foreground('foreground'),
                  LText(t('insights.weeklyRecap.title')),
                )
                  .style('subtle')
                  .tint('neutral')
                  .size('sm')
                  .onPress(() => router.push('/insights/weekly_recap'))
              : null,
          )
            .wrap()
            .align('center')
            .justify('between')
            .spacing('sm'),
          // A live region: it announces the refresh.
          LText(isFetching ? t('insights.updating') : `${range} · UTC`)
            .font('xs')
            .leading('16px')
            .foreground('muted')
            .liveRegion('polite'),
        ).spacing('sm'),
      )}
      {toElement(LText(t('insights.periodScope')).font('14').leading('20px').foreground('muted'))}

      {activeTab === 'overview' ? (
        <>
          {toElement(
            Grid(
              Embed(
                <ChartCardSurface height="auto" testID="insights-views-summary">
                  {toElement(
                    HStack(
                      Embed(
                        <ChartHeadline
                          label={t('insights.post.views')}
                          value={stats.overview.totalViews}
                          format={formatNumber}
                          caption={range}
                        />,
                      ),
                      Embed(
                        <Sparkline
                          data={series.map((point) => point.value)}
                          width={96}
                          height={40}
                          shape="sharp"
                          accessibilityLabel={t('insights.viewsByPublicationDate')}
                        />,
                      ),
                    )
                      .align('center')
                      .justify('between')
                      .spacing('md'),
                  )}
                  <ChartStatTiles
                    items={[
                      {
                        label: t('insights.posts'),
                        value: formatNumber(stats.overview.totalPosts),
                      },
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
                        value: formatDecimal(engagementRatios.averages.viewsPerPost),
                      },
                      {
                        label: t('insights.interactionsPerPostShort'),
                        value: formatDecimal(stats.overview.averageEngagementPerPost),
                      },
                      {
                        label: t('insights.activeDaysShort'),
                        value: formatNumber(publishing.activeDays),
                      },
                    ]}
                  />
                </ChartCardSurface>,
              ),
              Embed(
                <BarListCard
                  title={t('insights.post.interactions')}
                  metricLabel={t('insights.post.totalInteractions')}
                  items={interactions}
                  showShares
                  stats={interactionStats}
                  metric="value"
                  format={formatNumber}
                />,
              ),
            )
              .stretchItems()
              .testID('insights-summary-grid'),
          )}
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
                {toElement(LText(t('insights.viewsByPublicationDate')).font('caption-1'))}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
          {stats.topPosts.length > 0 &&
            toElement(
              Grid(
                VStack(
                  LText(t('insights.topPerformingPosts')).font('headline').weight('medium'),
                  Embed(
                    topPostsData.length > 0
                      ? topPostsData.map((post, index) => (
                          <Fragment key={post.id}>
                            {toElement(PostItem({ post, openPostEngagement }))}
                            {index < topPostsData.length - 1 ? toElement(LDivider()) : null}
                          </Fragment>
                        ))
                      : toElement(LText(t('insights.unableToLoadPosts'))),
                  ),
                ).spacing('md'),
                VStack(
                  Embed(publishingCard),
                  Embed(strongestDates),
                  LText(t('insights.strongestDatesScope')).font('caption-1'),
                ).spacing('lg'),
              ).testID('insights-posts-grid'),
            )}
        </>
      ) : activeTab === 'engagement' ? (
        <>
          {toElement(
            Grid(
              Embed(
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
                      {
                        label: t('insights.posts'),
                        value: formatNumber(stats.overview.totalPosts),
                      },
                      {
                        label: t('insights.mainInteraction'),
                        value: topInteraction.value > 0 ? topInteraction.label : '—',
                      },
                    ]}
                  />
                </ChartCardSurface>,
              ),
              Embed(
                <ChartCardSurface height="auto">
                  <ChartHeadline
                    label={t('insights.engagementPerPost')}
                    value={engagementRatios.averages.engagementPerPost}
                    format={(value) => formatDecimal(value)}
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
                        value: formatDecimal(engagementRatios.averages.viewsPerPost),
                      },
                    ]}
                  />
                </ChartCardSurface>,
              ),
            ).stretchItems(),
          )}
          {toElement(
            Grid(
              Embed(
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
                />,
              ),
              Embed(
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
                />,
              ),
            )
              .stretchItems()
              .testID('insights-engagement-grid'),
          )}
          {toElement(
            LText(t('insights.weekdayScope')).font('xs').leading('16px').foreground('muted'),
          )}
          {toElement(
            Grid(
              Embed(
                <BarListCard
                  title={t('insights.engagementRatios')}
                  stats={[
                    {
                      label: t('insights.post.views'),
                      value: formatNumber(stats.overview.totalViews),
                    },
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
                />,
              ),
              Embed(
                <BarListCard
                  title={t('insights.engagementPerPost')}
                  stats={[
                    { label: t('insights.posts'), value: formatNumber(stats.overview.totalPosts) },
                    {
                      label: t('insights.viewsPerPost'),
                      value: formatDecimal(engagementRatios.averages.viewsPerPost),
                    },
                  ]}
                  metricLabel={t('insights.perPost')}
                  metric="value"
                  format={(value) => formatDecimal(value)}
                  items={interactions.map((item) => ({
                    ...item,
                    value: stats.overview.totalPosts ? item.value / stats.overview.totalPosts : 0,
                  }))}
                />,
              ),
            ).stretchItems(),
          )}
        </>
      ) : (
        <>
          {toElement(
            Grid(
              Embed(publishingCard),
              Embed(
                Object.keys(stats.postsByType).length > 0 && (
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
                        value: formatDecimal(
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
                ),
              ),
            )
              .stretchItems()
              .testID('insights-publishing-grid'),
          )}
          {toElement(
            Grid(
              Embed(
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
                />,
              ),
              Embed(strongestDates),
            )
              .stretchItems()
              .testID('insights-publishing-detail-grid'),
          )}
          {toElement(LText(t('insights.strongestDatesScope')).font('caption-1'))}
        </>
      )}
    </>
  );
  return toElement(
    VStack(Embed(body))
      .padding('horizontal', 'lg')
      .padding('top', 'lg')
      .padding('bottom', '4xl')
      .spacing('lg'),
  );
}
