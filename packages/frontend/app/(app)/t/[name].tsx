import { Button } from '@oxy.so/bloom/button';
import { useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import { useLocalSearchParams } from '@/lib/navigation/router';
import { useQuery } from '@tanstack/react-query';
import { RiMoreFill } from '@oxy.so/bloom/icons/RiMoreFill';

import { RiFlagLine } from '@oxy.so/bloom/icons/RiFlagLine';
import { RiShare2Line } from '@oxy.so/bloom/icons/RiShare2Line';
import { toast } from '@oxy.so/bloom/toast';
import { useTranslation } from 'react-i18next';
import Feed from '@/components/Feed/Feed';
import type { FeedType } from '@mention/shared-types';
import { SEO } from '@/components/SEO';
import { TopicInlineWidgets } from '@/components/topic/TopicWidgets';
import { WEB_BASE_URL } from '@/config';
import { useTrendItemMenu } from '@/hooks/useTrendItemMenu';
import { ReportModal } from '@/components/report/ReportModal';
import { reportService } from '@/services/reportService';
import { presentSheet } from '@/utils/sheet';
import { trendingService } from '@/services/trendingService';
import { useTrendsStore } from '@/stores/trendsStore';
import { useTopicRailStore } from '@/stores/topicRailStore';
import { publicQueryKeys } from '@/lib/viewerQueryKeys';
import { formatRelativeTime, useBloomLocale } from '@oxy.so/bloom/locale';
import { shareLink } from '@/utils/shareLink';
import {
  Button as LButton,
  Embed,
  Group as LGroup,
  Header,
  Icon,
  Item,
  Menu,
  Text as LText,
  VStack,
  toElement,
  toElement as LtoElement,
} from '@oxy.so/bloom-language';
import { TabItem, Tabs as LTabs } from '@oxy.so/bloom-language/containers';
import { screen } from '@oxy.so/bloom-language/router';

/** How the topic's posts are ordered. `top` is the default, as on the mock. */
type TopicSort = 'top' | 'latest';

export default screen(function TrendScreen() {
  // The TERM is the whole address. Everything shown about the trend is
  // resolved from it, never carried alongside it.
  const { name } = useLocalSearchParams<{ name: string }>();
  const { t } = useTranslation();
  const locale = useBloomLocale();

  const term = name || '';
  const [sort, setSort] = useState<TopicSort>('top');

  /*
   * The label comes from the live trends the app already holds when the term
   * is one of them — instant, and correct by construction because it is the
   * same state every other surface renders. A cold deep link has no such
   * entry and falls back to the fetched topic, then to the term itself.
   */
  const listed = useTrendsStore((state) => state.trends.find((trend) => trend.text === term));

  /*
   * The numbers this page states: updated time, people, volume, curve and
   * neighbours. Stored facts and counts only, see `GET /trending/topic`.
   */
  const { data: topic } = useQuery({
    queryKey: publicQueryKeys.trendTopic(term),
    queryFn: () => trendingService.getTrendTopic(term),
    enabled: term.length > 0,
    staleTime: 60_000,
  });

  /*
   * A stored description, when the trend has one. New trends carry none, and
   * the page is complete without it: its numbers already say what is happening.
   * Requested per open, as before — the request is the demand signal.
   */
  const { data: detail } = useQuery({
    queryKey: publicQueryKeys.trendSummary(term),
    queryFn: () => trendingService.getTrendDetail(term),
    enabled: term.length > 0,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });

  /*
   * `trend|<term>`, NOT `topic|<term>`: the trend feed matches the same union
   * of extracted terms, hashtags and topic slugs that detection counted, so a
   * trend detected purely from prose still opens onto its posts. The `|top`
   * suffix ranks the same posts; latest is the bare descriptor.
   */
  const feedType = useMemo(
    () => (sort === 'top' ? `trend|${term}|top` : `trend|${term}`) as FeedType,
    [term, sort],
  );

  // Tell the right rail which topic is open, so its widgets sit above the
  // shared ones. Cleared on leave, so they cannot outlive this page.
  const setTopicRailTerm = useTopicRailStore((state) => state.setTerm);
  useEffect(() => {
    setTopicRailTerm(term || null);
    return () => setTopicRailTerm(null);
  }, [term, setTopicRailTerm]);

  const heading = topic?.displayName || listed?.displayName || detail?.displayName || term;
  const summary = detail?.description;
  const category = topic?.category ?? listed?.category ?? detail?.category;
  const categoryLabel = category ? t(`trend.category.${category}`, { defaultValue: '' }) : '';

  const updatedLabel = topic?.updatedAt
    ? t('trend.topic.updated', {
        time: formatRelativeTime(new Date(topic.updatedAt), locale, { style: 'short' }),
        defaultValue: 'Actualizado {{time}}',
      })
    : null;

  const statsLabel =
    topic?.authorCount !== undefined && topic.volume !== undefined
      ? t('trend.topic.stats', {
          authors: topic.authorCount,
          posts: topic.volume,
          hours: topic?.windowHours ?? 0,
          defaultValue: '{{authors}} personas, {{posts}} publicaciones en las últimas {{hours}} h',
        })
      : null;

  // Share goes to this topic's own page, whether or not the term is in the
  // current batch — the link is the same either way.
  const shareTopic = () => {
    void shareLink({
      title: heading,
      url: `${WEB_BASE_URL}/t/${encodeURIComponent(term)}`,
      copiedToast: t('widgetMenu.linkCopied'),
      errorToast: t('widgetMenu.shareFailed'),
    });
  };

  // The ⋯ menu acts on a trend row (hide it from the rail), so it only exists
  // when this term is in the live batch to hide.
  const getTrendMenuActions = useTrendItemMenu();

  const trendActions = listed ? getTrendMenuActions(listed) : null;

  // Reporting a trend stores it for Mention's moderators (`reportedType: 'trend'`).
  const reportTopic = () => {
    void presentSheet((surface) => (
      <ReportModal
        visible={true}
        onClose={() => surface.dismiss()}
        onSubmit={async (categories, details) => {
          surface.dismiss();
          const success = await reportService.reportTrend(term, categories, details);
          if (success) {
            toast(
              t('report.thankYou', {
                defaultValue: 'Thank you for helping keep our community safe.',
              }),
              { type: 'success' },
            );
          } else {
            toast(t('report.failed', { defaultValue: 'Failed to submit report.' }), {
              type: 'error',
            });
          }
        }}
      />
    ));
  };

  const headerActions = (
    <Button.Group accessibilityLabel={t('trend.topic.actions', { defaultValue: 'Acciones' })}>
      {toElement(
        LButton(Icon(RiFlagLine))
          .shape('circle')
          .label(t('trend.topic.report', { defaultValue: 'Reportar' }))
          .onPress(reportTopic),
      )}
      {toElement(
        LButton(Icon(RiShare2Line))
          .shape('circle')
          .label(t('widgetMenu.share', { defaultValue: 'Compartir' }))
          .onPress(shareTopic),
      )}
      {trendActions
        ? toElement(
            Menu(
              LButton(Icon(RiMoreFill))
                .shape('circle')
                .label(t('trend.topic.more', { defaultValue: 'Más' })),
              Item(t('widgetMenu.notInterested', { defaultValue: 'No me interesa' })).onPress(
                trendActions.onNotInterested,
              ),
              Item(t('widgetMenu.share', { defaultValue: 'Compartir' })).onPress(
                trendActions.onShare,
              ),
            ).label(heading),
          )
        : null}
    </Button.Group>
  );

  const listHeader = useMemo(
    () =>
      toElement(
        VStack(
          LText(categoryLabel || t('trend.trendingLabel', { defaultValue: 'Trending' }))
            .font('xs')
            .leading('16px')
            .foreground('muted')
            .weight('medium')
            .textCase('uppercase')
            .tracking('wide')
            .margin('bottom', 'xs'),
          LText(heading)
            .font('28')
            .leading('32px')
            .weight('bold')
            .foreground('foreground')
            .margin('bottom', 'sm'),
          updatedLabel
            ? LText(updatedLabel)
                .font('xs')
                .leading('16px')
                .foreground('muted')
                .margin('bottom', 'md')
            : null,
          statsLabel
            ? LText(statsLabel)
                .font('14')
                .leading('20px')
                .foreground('foreground')
                .margin('bottom', 'sm')
            : null,
          summary
            ? LText(summary).font('14').leading('20px').foreground('muted').margin('bottom', 'sm')
            : null,
          /* Native has no right rail: the same widgets sit under the header. */ Embed(
            Platform.OS !== 'web' && term ? <TopicInlineWidgets term={term} /> : null,
          ),
          Embed(
            LtoElement(
              LTabs(
                [sort, (value) => setSort(value as TopicSort)],
                TabItem('top', t('trend.topic.sortTop', { defaultValue: 'Top' })),
                TabItem('latest', t('trend.topic.sortLatest', { defaultValue: 'Latest' })),
              )
                .style('underline')
                .fullWidth()
                .pressOpenTab('reselect')
                .label(t('trend.topic.order', { defaultValue: 'Orden' })),
            ),
          ),
        )
          .padding('horizontal', 'lg')
          .padding('bottom', 'sm'),
      ),
    [heading, summary, categoryLabel, updatedLabel, statsLabel, term, sort, t],
  );

  return LGroup(
    Embed(
      <SEO
        robots="index,follow"
        title={t('seo.trend.title', { topic: heading, defaultValue: '{{topic}} - Mention' })}
        description={t('seo.trend.description', {
          topic: heading,
          defaultValue: 'Posts about {{topic}} on Mention',
        })}
      />,
    ),
    Embed(<Feed type={feedType} listHeaderComponent={listHeader} />),
  )
    .screenScroll('auto')
    .header(
      Header(heading)
        .backLabel(t('common.back', { defaultValue: 'Back' }))
        .toolbar(Embed(headerActions))
        .inPage(),
    );
});
