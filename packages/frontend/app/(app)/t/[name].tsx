import { Screen } from '@oxy.so/bloom/screen';
import { useEffect, useMemo, useState } from 'react';
import { Platform, View } from 'react-native';
import { useLocalSearchParams } from '@/lib/navigation/router';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { RiMoreFill } from '@oxy.so/bloom/icons/RiMoreFill';
import { RiShare2Line } from '@oxy.so/bloom/icons/RiShare2Line';
import { Text } from '@oxy.so/bloom/typography';
import { useTranslation } from 'react-i18next';
import Feed from '@/components/Feed/Feed';
import type { FeedType } from '@mention/shared-types';
import { SEO } from '@/components/SEO';
import { TopicInlineWidgets } from '@/components/topic/TopicWidgets';
import { WEB_BASE_URL } from '@/config';
import { useTrendItemMenu } from '@/hooks/useTrendItemMenu';
import { trendingService } from '@/services/trendingService';
import { useTrendsStore } from '@/stores/trendsStore';
import { useTopicRailStore } from '@/stores/topicRailStore';
import { publicQueryKeys } from '@/lib/viewerQueryKeys';
import { formatRelativeTimeLocalized } from '@/utils/dateUtils';
import { shareLink } from '@/utils/shareLink';

/** How the topic's posts are ordered. `top` is the default, as on the mock. */
type TopicSort = 'top' | 'latest';

export default function TrendScreen() {
  // The TERM is the whole address. Everything shown about the trend is
  // resolved from it, never carried alongside it.
  const { name } = useLocalSearchParams<{ name: string }>();
  const { t } = useTranslation();

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
        time: formatRelativeTimeLocalized(topic.updatedAt, t),
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

  const headerActions = (
    <ButtonGroup accessibilityLabel={t('trend.topic.actions', { defaultValue: 'Acciones' })}>
      <ButtonGroupItem
        iconOnly
        leadingIcon={RiShare2Line}
        accessibilityLabel={t('widgetMenu.share', { defaultValue: 'Compartir' })}
        onPress={shareTopic}
      />
      {trendActions ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild label={t('trend.topic.more', { defaultValue: 'Más' })}>
            <ButtonGroupItem
              iconOnly
              leadingIcon={RiMoreFill}
              accessibilityLabel={t('trend.topic.more', { defaultValue: 'Más' })}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent label={heading}>
            <DropdownMenuItem onPress={trendActions.onNotInterested}>
              {t('widgetMenu.notInterested', { defaultValue: 'No me interesa' })}
            </DropdownMenuItem>
            <DropdownMenuItem onPress={trendActions.onShare}>
              {t('widgetMenu.share', { defaultValue: 'Compartir' })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </ButtonGroup>
  );

  const listHeader = useMemo(
    () => (
      <View className="px-4 pb-2">
        <Text className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-1">
          {categoryLabel || t('trend.trendingLabel', { defaultValue: 'Trending' })}
        </Text>
        <Text className="text-[28px] leading-8 font-bold mb-2 text-foreground">{heading}</Text>
        {updatedLabel ? (
          <Text className="text-xs text-muted-foreground mb-3">{updatedLabel}</Text>
        ) : null}
        {statsLabel ? <Text className="text-sm text-foreground mb-2">{statsLabel}</Text> : null}
        {summary ? <Text className="text-sm text-muted-foreground mb-2">{summary}</Text> : null}
        {/* Native has no right rail: the same widgets sit under the header. */}
        {Platform.OS !== 'web' && term ? <TopicInlineWidgets term={term} /> : null}
        <Tabs
          value={sort}
          onValueChange={(value) => setSort(value as TopicSort)}
          variant="underline"
          fullWidth
          label={t('trend.topic.order', { defaultValue: 'Orden' })}
        >
          <TabsTrigger value="top" label={t('trend.topic.sortTop', { defaultValue: 'Top' })} />
          <TabsTrigger
            value="latest"
            label={t('trend.topic.sortLatest', { defaultValue: 'Latest' })}
          />
        </Tabs>
      </View>
    ),
    [heading, summary, categoryLabel, updatedLabel, statsLabel, term, sort, t],
  );

  return (
    <Screen
      scroll="auto"
      header={
        <PageHeader
          title={heading}
          backLabel={t('common.back', { defaultValue: 'Back' })}
          actions={headerActions}
        />
      }
    >
      <SEO
        title={t('seo.trend.title', { topic: heading, defaultValue: '{{topic}} - Mention' })}
        description={t('seo.trend.description', {
          topic: heading,
          defaultValue: 'Posts about {{topic}} on Mention',
        })}
      />

      <Feed type={feedType} listHeaderComponent={listHeader} />
    </Screen>
  );
}
