import { Fragment } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@oxy.so/bloom/typography';
import { ResponsiveGrid } from '@oxy.so/bloom/grid';
import { Divider } from '@oxy.so/bloom/divider';
import {
  BarListCard,
  ChartCardSurface,
  SleepScoreCard,
  ChartStatTiles,
  StepsCard,
  StageBarsCard,
  ContributionsCard,
} from '@oxy.so/bloom/chart-cards';
import type { HydratedPost } from '@mention/shared-types';
import type { AccountInsights } from '@/services/insightsService';
import PostItem from '@/components/Feed/PostItem';
import { buildInsightsSeries, buildPublishingSummary } from './insightsSeries';

export interface WeeklyRecapContentProps {
  stats: AccountInsights;
  summary: string | null;
  topPosts: HydratedPost[];
}

export function WeeklyRecapContent({ stats, summary, topPosts }: WeeklyRecapContentProps) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
  const date = new Intl.DateTimeFormat(i18n.language, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const series = buildInsightsSeries(stats, i18n.language);
  const publishing = buildPublishingSummary(stats);
  const formats = Object.entries(stats.postsByType)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a);
  const leadingFormat = formats[0]?.[0];
  const interactions = (['likes', 'replies', 'boosts', 'shares'] as const).map((kind) => ({
    label: t(`insights.post.${kind}`),
    value: stats.interactions[kind],
  }));
  const calendarDays = publishing.weekdays.total + publishing.weekends.total;
  const range = `${date.format(new Date(stats.period.startDate))} – ${date.format(new Date(stats.period.endDate))}`;
  const peakViews = [...series].sort((a, b) => b.value - a.value)[0];
  const mainInteraction = [...interactions].sort((a, b) => b.value - a.value)[0];
  const calendar = (
    <ContributionsCard
      testID="weekly-contributions"
      title={t('insights.publishingDays')}
      total={publishing.activeDays}
      format={(value) => number.format(value)}
      periods={[]}
      months={[]}
      initialScrollPosition="end"
      activityLabel={t('insights.publishingScope')}
      columns={publishing.columns}
      cells={publishing.cells}
      stats={[
        { label: t('insights.posts'), value: number.format(stats.overview.totalPosts) },
        {
          label: t('insights.daysWithoutPosts'),
          value: number.format(calendarDays - publishing.activeDays),
        },
        {
          label: t('insights.longestStreak'),
          value: t('insights.dayCount', { count: publishing.longestStreak }),
        },
        {
          label: t('insights.postsPerActiveDay'),
          value: number.format(
            publishing.activeDays ? stats.overview.totalPosts / publishing.activeDays : 0,
          ),
        },
      ]}
      getCellLabel={(cell) =>
        cell.date
          ? `${date.format(new Date(cell.date))}: ${cell.count ? t('insights.published') : t('insights.noPublications')}`
          : t('insights.outsidePeriod')
      }
    />
  );
  return (
    <View className="gap-4 p-4" testID="weekly-recap-content">
      <View className="gap-2">
        <Text variant="title-1-medium">{t('insights.weeklyRecap.pageTitle')}</Text>
        <Text variant="body-2-regular">
          {date.format(new Date(stats.period.startDate))} –{' '}
          {date.format(new Date(stats.period.endDate))} · UTC
        </Text>
        <Text variant="caption-1-regular">{t('insights.periodScope')}</Text>
      </View>
      <ChartCardSurface height="auto">
        {summary && (
          <View className="gap-2">
            <Text variant="headline-medium">{t('insights.weeklyRecap.summary')}</Text>
            <Text variant="body-regular">{summary}</Text>
          </View>
        )}
        <ChartStatTiles
          items={[
            { label: t('insights.posts'), value: number.format(stats.overview.totalPosts) },
            {
              label: t('insights.post.interactions'),
              value: number.format(stats.overview.totalInteractions),
            },
            {
              label: t('insights.post.engagementRate'),
              value: `${number.format(stats.overview.engagementRate)}%`,
            },
          ]}
        />
      </ChartCardSurface>
      <ResponsiveGrid stretchItems testID="weekly-charts">
        <StepsCard
          testID="weekly-views"
          range={range}
          title={t('insights.viewsByPublicationDate')}
          data={series}
          getPointTitle={(_, index) => series[index].fullLabel}
          headline={stats.overview.totalViews}
          totalSuffix={t('insights.post.views')}
          pointSuffix={t('insights.post.views')}
          stats={[
            {
              label: t('insights.viewsPerPost'),
              value: number.format(
                stats.overview.totalPosts
                  ? stats.overview.totalViews / stats.overview.totalPosts
                  : 0,
              ),
            },
            {
              label: t('insights.interactionsPerPostShort'),
              value: number.format(stats.overview.averageEngagementPerPost),
            },
            { label: t('insights.activeDaysShort'), value: number.format(publishing.activeDays) },
            {
              label: t('insights.topViewDate'),
              value: peakViews?.value > 0 ? peakViews.label : '—',
            },
            { label: t('insights.topDateViews'), value: number.format(peakViews?.value ?? 0) },
            {
              label: t('insights.postsPerDay'),
              value: number.format(
                stats.period.days > 0 ? stats.overview.totalPosts / stats.period.days : 0,
              ),
            },
          ]}
          format={(value) => number.format(value)}
        />
        <BarListCard
          title={t('insights.post.interactions')}
          metricLabel={t('insights.post.interactions')}
          metric="value"
          format={(value) => number.format(value)}
          items={interactions}
          showShares
          stats={[
            {
              label: t('insights.post.interactions'),
              value: number.format(stats.overview.totalInteractions),
            },
            {
              label: t('insights.mainInteraction'),
              value: mainInteraction.value > 0 ? mainInteraction.label : '—',
            },
            {
              label: t('insights.post.engagementRate'),
              value: `${number.format(stats.overview.engagementRate)}%`,
            },
          ]}
        />
      </ResponsiveGrid>
      <ResponsiveGrid stretchItems>
        <StageBarsCard
          title={t('insights.publishingMix')}
          range={range}
          format={(value) => number.format(value)}
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
              value: number.format(
                stats.period.days > 0 ? stats.overview.totalPosts / stats.period.days : 0,
              ),
            },
          ]}
          stages={formats.map(([kind, value]) => ({
            label: t(`insights.postType.${kind}`, { defaultValue: kind }),
            value,
          }))}
        />
        <SleepScoreCard
          testID="publishing-consistency"
          title={t('insights.publishingConsistency')}
          range={range}
          stats={[
            {
              label: t('insights.longestStreak'),
              value: t('insights.dayCount', { count: publishing.longestStreak }),
            },
            {
              label: t('insights.postsPerActiveDay'),
              value: number.format(
                publishing.activeDays ? stats.overview.totalPosts / publishing.activeDays : 0,
              ),
            },
            {
              label: t('insights.publishingCoverage'),
              value: `${number.format(calendarDays ? (publishing.activeDays / calendarDays) * 100 : 0)}%`,
            },
          ]}
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
      </ResponsiveGrid>
      <ResponsiveGrid testID="weekly-posts-grid">
        <View className="gap-3">
          <Text variant="headline-medium">{t('insights.topPerformingPosts')}</Text>
          {topPosts.length ? (
            topPosts.map((post, index) => (
              <Fragment key={post.id}>
                <PostItem post={post} />
                {index < topPosts.length - 1 && <Divider />}
              </Fragment>
            ))
          ) : (
            <Text variant="body-regular">
              {t(
                stats.topPosts.length
                  ? 'insights.unableToLoadPosts'
                  : 'insights.weeklyRecap.noDataAvailable',
              )}
            </Text>
          )}
        </View>
        {calendar}
      </ResponsiveGrid>
    </View>
  );
}
