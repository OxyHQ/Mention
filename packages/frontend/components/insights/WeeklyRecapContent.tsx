import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
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
import { useOpenPostEngagement } from '@/components/Post/postEngagementContext';
import { buildInsightsSeries, buildPublishingSummary } from './insightsSeries';

import {
  Divider as LDivider,
  Embed,
  Grid,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

export interface WeeklyRecapContentProps {
  stats: AccountInsights;
  summary: string | null;
  topPosts: HydratedPost[];
}

export function WeeklyRecapContent({ stats, summary, topPosts }: WeeklyRecapContentProps) {
  const openPostEngagement = useOpenPostEngagement();
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
  return toElement(
    VStack(
      VStack(
        LText(t('insights.weeklyRecap.pageTitle')).font('title-1').weight('medium'),
        LText(
          date.format(new Date(stats.period.startDate)),
          ' –',
          ' ',
          date.format(new Date(stats.period.endDate)),
          ' · UTC',
        ).font('body-2'),
        LText(t('insights.periodScope')).font('caption-1'),
      ).spacing('sm'),
      Embed(
        <ChartCardSurface height="auto">
          {summary &&
            toElement(
              VStack(
                LText(t('insights.weeklyRecap.summary')).font('headline').weight('medium'),
                LText(summary).font('body'),
              ).spacing('sm'),
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
        </ChartCardSurface>,
      ),
      Grid(
        Embed(
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
          />,
        ),
        Embed(
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
          />,
        ),
      )
        .stretchItems()
        .testID('weekly-charts'),
      Grid(
        Embed(
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
          />,
        ),
        Embed(
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
          />,
        ),
      ).stretchItems(),
      Grid(
        VStack(
          LText(t('insights.topPerformingPosts')).font('headline').weight('medium'),
          Embed(
            topPosts.length
              ? topPosts.map((post, index) => (
                  <Fragment key={post.id}>
                    <PostItem post={post} openPostEngagement={openPostEngagement} />
                    {index < topPosts.length - 1 && toElement(LDivider())}
                  </Fragment>
                ))
              : toElement(
                  LText(
                    t(
                      stats.topPosts.length
                        ? 'insights.unableToLoadPosts'
                        : 'insights.weeklyRecap.noDataAvailable',
                    ),
                  ).font('body'),
                ),
          ),
        ).spacing('md'),
        Embed(calendar),
      ).testID('weekly-posts-grid'),
    )
      .padding('all', 'lg')
      .spacing('lg')
      .testID('weekly-recap-content'),
  );
}
