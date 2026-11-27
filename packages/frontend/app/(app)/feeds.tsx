import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { SupervisedFeatureGate } from '@/components/SupervisedFeatureGate';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet } from 'react-native';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiCheckLine } from '@oxy.so/bloom/icons/RiCheckLine';
import { RiEarthLine } from '@oxy.so/bloom/icons/RiEarthLine';
import { RiFireLine } from '@oxy.so/bloom/icons/RiFireLine';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiHeartLine } from '@oxy.so/bloom/icons/RiHeartLine';
import { RiLineChartLine } from '@oxy.so/bloom/icons/RiLineChartLine';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { RiSparklingLine } from '@oxy.so/bloom/icons/RiSparklingLine';
import { RiUserCommunityLine } from '@oxy.so/bloom/icons/RiUserCommunityLine';
import { useTranslation } from 'react-i18next';
import { useRouter, useFocusEffect } from '@/lib/navigation/router';
import { PRESET_FEEDS, type PresetFeed } from '@mention/shared-types/mtn/presetFeeds';
import { useAgeProtections } from '@/hooks/useAgeProtections';
import { useTrendsStore } from '@/stores/trendsStore';
import { reportTrendEvent } from '@/utils/feedTelemetry';
import type { Trend } from '@/interfaces/Trend';

import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { SEO } from '@/components/SEO';

import { requestSettings } from '@/components/settings/settingsRoutes';
import type { BloomIcon } from '@/components/settings/RowIcon';
import { customFeedsService } from '@/services/customFeedsService';

import { useFeedPreferences } from '@/hooks/useFeedPreferences';
import { useTheme } from '@oxy.so/bloom/theme';
import { formatCompactNumber } from '@/utils/formatNumber';
import { logger } from '@oxy.so/core/logger';
import { useAuth } from '@oxy.so/services/ui/client';
import {
  Avatar as LAvatar,
  Button as LButton,
  Embed,
  HStack,
  Header,
  Icon,
  RawText,
  Search as LSearch,
  VStack,
  defineTokens,
  toElement,
  type Child,
  Embed as LEmbed,
  ScrollView,
  Group,
  FAB,
  identity,
} from '@oxy.so/bloom-language';

import { screen } from '@oxy.so/bloom-language/router';
const appColors = defineTokens({ color: { hexfff: '#fff' } });

/**
 * Live trends offered on this screen.
 *
 * A handful, not the whole batch: this is a DIRECTORY, and the trending page is
 * one tap away for the rest. Enough to answer "is anything happening?" without
 * the day's churn pushing the curated shelf off the screen.
 */
const TREND_FEED_LIMIT = 5;

/** Pin key for a trend row. Keyed on the TERM, which is what the descriptor addresses. */
const trendKey = (trend: Trend): string => `trend:${trend.text}`;

/**
 * Bloom glyph per preset id. The shared catalog carries Lucide names; the feeds
 * screen renders with Bloom's Remix icons, so this maps the small, fixed preset
 * set rather than pulling in a second icon library.
 */
const PRESET_ICONS: Record<string, BloomIcon> = {
  for_you: RiSparklingLine,
  following: RiGroupLine,
  trending: RiFireLine,
  explore: RiEarthLine,
  mutuals: RiUserCommunityLine,
  friends_popular: RiHeartLine,
};

interface FeedItem {
  _id?: string;
  id?: string;
  uri?: string;
  title?: string;
  description?: string;
  avatar?: string;
  owner?: {
    username?: string;
    handle?: string;
    displayName?: string;
    avatar?: string;
  };
  memberOxyUserIds?: string[];
  likeCount?: number;
  isLiked?: boolean;
}

/**
 * A directory row: its body, then the pin control when the viewer can edit,
 * over a hairline rule.
 */
function feedRow(body: Child, pin: Child | null) {
  return toElement(
    HStack(body, pin)
      .align('center')
      .spacing('md')
      .padding('vertical', 'md')
      .border('border', 'hairline', 'bottom'),
  );
}

// Pin toggle button shared by preset + custom rows.
function pinButton(pinned: boolean, onPress: () => void) {
  return VStack(
    pinned
      ? Icon(RiCheckLine).size('14').foreground('foreground')
      : Icon(RiAddLine).size('14').foreground(appColors.color.hexfff),
  )
    .frame({ width: '28', height: '28' })
    .background(pinned ? 'surface' : 'primary')
    .corner('14')
    .align('center')
    .justify('center')
    .onPress(onPress)
    .hitSlop('md')
    .pressFade();
}

// Built-in preset feed row (For You / Following / Trending / Discover / …). The
// row body opens the feed viewer; pin/unpin is a separate control beside it.
const PresetRow = ({
  preset,
  pinned,
  canEdit,
  onOpen,
  onTogglePin,
  t,
}: {
  preset: PresetFeed;
  pinned: boolean;
  canEdit: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
  t: (key: string) => string;
}) => {
  const theme = useTheme();
  const PresetIcon = PRESET_ICONS[preset.id] ?? RiSparklingLine;
  return feedRow(
    HStack(
      VStack(Embed(<PresetIcon width={20} height={20} fill={theme.colors.primary} />))
        .frame({ width: '36', height: '36' })
        .background('mutedFill')
        .corner('infinite')
        .align('center')
        .justify('center'),
      VStack(
        RawText(t(preset.labelKey)).font('md').weight('semibold').foreground('foreground').lines(1),
        RawText(t(preset.descriptionKey)).font('sm').leading('18px').foreground('muted').lines(2),
      )
        .flex('1')
        .spacing('2xs'),
    )
      .flex('1')
      .align('center')
      .spacing('md')
      .onPress(onOpen)
      .role('button')
      .label(t(preset.labelKey))
      .pressFade('70'),
    canEdit ? pinButton(pinned, onTogglePin) : null,
  );
};

/**
 * A live trend, offered as a feed.
 *
 * Rendered BELOW the curated presets on purpose: curated feeds are the editorial
 * shelf and these are what happens to be loud today, so they are an addition to
 * the directory rather than a competitor for its top.
 *
 * Pinnable like anything else, and that is not a slip. Unlike Bluesky's — where
 * a trend is a frozen record that stops meaning anything once the moment passes
 * — our `trend|<term>` is a live query over the term with no time window. Pin
 * `trend|fifa` and it keeps working long after FIFA stops trending, as "posts
 * about fifa". The trend is what surfaced it; the feed outlives it.
 */
const TrendFeedRow = ({
  trend,
  subtitle,
  pinned,
  canEdit,
  onOpen,
  onTogglePin,
}: {
  trend: Trend;
  subtitle: string;
  pinned: boolean;
  canEdit: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
}) => {
  return feedRow(
    HStack(
      VStack(Icon(RiLineChartLine).size('md').foreground('primary'))
        .frame({ width: '36', height: '36' })
        .background('mutedFill')
        .corner('infinite')
        .align('center')
        .justify('center'),
      VStack(
        RawText(trend.displayName).font('md').weight('semibold').foreground('foreground').lines(1),
        RawText(subtitle).font('sm').leading('18px').foreground('muted').lines(1),
      )
        .flex('1')
        .spacing('2xs'),
    )
      .flex('1')
      .align('center')
      .spacing('md')
      .onPress(onOpen)
      .role('button')
      .label(trend.displayName)
      .pressFade('70'),
    canEdit ? pinButton(pinned, onTogglePin) : null,
  );
};

// Compact custom-feed card row. The row body opens the feed detail; pin/unpin is
// a separate control beside it.
const FeedRow = ({
  item,
  pinned,
  canEdit,
  onOpen,
  onTogglePin,
}: {
  item: FeedItem;
  pinned: boolean;
  canEdit: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
}) => {
  const memberCount = (item.memberOxyUserIds || []).length;

  return feedRow(
    HStack(
      LAvatar(item.avatar || undefined, { variant: MEDIA_VARIANT_AVATAR }).size('lg'),
      VStack(
        RawText(item.title || 'Untitled Feed')
          .font('md')
          .weight('semibold')
          .foreground('foreground')
          .lines(1),
        RawText(
          item.owner ? `@${item.owner.username || item.owner.handle}` : '',
          memberCount > 0 ? ` · ${formatCompactNumber(memberCount)} members` : '',
          typeof item.likeCount === 'number' && item.likeCount > 0
            ? ` · ${formatCompactNumber(item.likeCount)} likes`
            : '',
        )
          .font('sm')
          .foreground('muted')
          .lines(1),
        item.description
          ? RawText(item.description)
              .font('sm')
              .leading('18px')
              .margin('top', '2xs')
              .foreground('muted')
              .lines(2)
          : null,
      )
        .flex('1')
        .spacing('2xs'),
    )
      .flex('1')
      .align('center')
      .spacing('md')
      .onPress(onOpen)
      .role('button')
      .label(item.title || 'Untitled Feed')
      .pressFade('70'),
    canEdit ? pinButton(pinned, onTogglePin) : null,
  );
};

const FeedsScreen = screen(function FeedsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const theme = useTheme();
  const { isAuthResolved, canUsePrivateApi, isPrivateApiPending } = useAuth();
  const { isPinned, pin, unpin, canEdit } = useFeedPreferences();
  const [myFeeds, setMyFeeds] = useState<FeedItem[]>([]);
  const [publicFeeds, setPublicFeeds] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const loadFeeds = useCallback(async () => {
    if (!isAuthResolved || isPrivateApiPending) {
      return;
    }

    try {
      setLoading(true);
      const [mine, pub] = await Promise.all([
        canUsePrivateApi
          ? customFeedsService.list({ mine: true })
          : Promise.resolve({ items: [], total: 0 }),
        customFeedsService.list({ publicOnly: true }),
      ]);

      setMyFeeds(mine.items || []);

      const mineIds = new Set(
        (mine.items || []).map((feed: FeedItem) => String(feed._id || feed.id)),
      );
      setPublicFeeds(
        (pub.items || []).filter((feed: FeedItem) => !mineIds.has(String(feed._id || feed.id))),
      );
    } catch (e) {
      logger.warn('Failed loading feeds', { error: e });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [canUsePrivateApi, isAuthResolved, isPrivateApiPending]);

  // Reload on focus so a feed created / edited in the builder appears when the
  // user returns to this screen (loadFeeds no-ops until auth resolves).
  useFocusEffect(
    useCallback(() => {
      loadFeeds();
    }, [loadFeeds]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadFeeds();
  }, [loadFeeds]);

  // Presets available to this viewer: hide viewer-relative (requiresAuth) presets
  // for anonymous viewers, and the ranked ones for a minor's account, which is
  // served none of them (oxy ADR 0068).
  const { feedProfile } = useAgeProtections();
  const visiblePresets = useMemo(
    () =>
      PRESET_FEEDS.filter(
        (preset) =>
          (canUsePrivateApi || !preset.requiresAuth) &&
          !(feedProfile === 'protected' && preset.ranked),
      ),
    [canUsePrivateApi, feedProfile],
  );

  /*
   * Live trends, offered as feeds under the curated shelf.
   *
   * Read from the store rather than fetched: every other trending surface
   * already shares it, so this screen costs no request, inherits the reader's
   * language ordering, and honours the trends they hid.
   */
  const trends = useTrendsStore((state) => state.trends);
  const hiddenTrendIds = useTrendsStore((state) => state.hiddenTrendIds);
  const fetchTrends = useTrendsStore((state) => state.fetchTrends);
  const hasFetchedTrends = useTrendsStore((state) => state.hasFetched);

  useEffect(() => {
    if (!hasFetchedTrends) void fetchTrends();
  }, [fetchTrends, hasFetchedTrends]);

  const trendFeeds = useMemo(
    () => trends.filter((trend) => !hiddenTrendIds.includes(trend.id)).slice(0, TREND_FEED_LIMIT),
    [trends, hiddenTrendIds],
  );

  /*
   * A trend opens and pins exactly like every other row here: through the shared
   * viewer, addressed by its descriptor. `navigateToTrend` is the RICH screen
   * (header, category, generated summary) reached from the widget and search;
   * this is the feeds directory, where a row's job is to open the feed itself.
   * Both request the identical descriptor, so they are two presentations of one
   * feed rather than two feeds.
   */
  const openTrend = useCallback(
    (trend: Trend, rank: number) => {
      reportTrendEvent({
        event: 'click',
        type: trend.type,
        surface: 'feeds',
        rank,
        ...(trend.recId ? { recId: trend.recId } : {}),
      });
      router.push({
        pathname: '/feeds/view',
        params: { descriptor: `trend|${trend.text}`, title: trend.displayName },
      });
    },
    [router],
  );

  const toggleTrend = useCallback(
    (trend: Trend) => {
      const key = trendKey(trend);
      if (isPinned(key)) unpin(key);
      else pin({ key, descriptor: `trend|${trend.text}` });
    },
    [isPinned, pin, unpin],
  );

  const togglePreset = useCallback(
    (preset: PresetFeed) => {
      if (isPinned(preset.id)) unpin(preset.id);
      else pin({ key: preset.id, descriptor: preset.descriptor });
    },
    [isPinned, pin, unpin],
  );

  // Tapping a preset row opens a read-only viewer for that descriptor (no pin
  // required); the descriptor + resolved title are passed through to the viewer.
  const openPreset = useCallback(
    (preset: PresetFeed) => {
      router.push({
        pathname: '/feeds/view',
        params: { descriptor: preset.descriptor, title: t(preset.labelKey) },
      });
    },
    [t, router],
  );

  const toggleCustom = useCallback(
    (feedId: string) => {
      const key = `custom:${feedId}`;
      if (isPinned(key)) unpin(key);
      else pin({ key, descriptor: `custom|${feedId}` });
    },
    [isPinned, pin, unpin],
  );

  const filteredPublic = useMemo(() => {
    if (!searchQuery.trim()) return publicFeeds;
    const q = searchQuery.toLowerCase();
    return publicFeeds.filter(
      (f) =>
        f.title?.toLowerCase().includes(q) ||
        f.description?.toLowerCase().includes(q) ||
        f.owner?.username?.toLowerCase().includes(q),
    );
  }, [publicFeeds, searchQuery]);

  // Directory body — identical on both platforms; only the scroll host differs.
  const content = (
    <>
      {/* Built-in preset feeds */}
      {toElement(
        RawText(t('feeds.presets.title'))
          .font('md')
          .weight('bold')
          .foreground('foreground')
          .margin('top', 'sm')
          .margin('bottom', 'xs'),
      )}
      {visiblePresets.map((preset) => (
        <PresetRow
          key={preset.id}
          preset={preset}
          pinned={isPinned(preset.id)}
          canEdit={canEdit}
          onOpen={() => openPreset(preset)}
          onTogglePin={() => togglePreset(preset)}
          t={t}
        />
      ))}

      {/* Live trends — under the curated shelf, never above it. */}
      {trendFeeds.length > 0 ? (
        <>
          {toElement(
            RawText(t('feeds.trending.title'))
              .font('md')
              .weight('bold')
              .foreground('foreground')
              .margin('top', '2xl')
              .margin('bottom', 'xs'),
          )}
          {trendFeeds.map((trend, index) => (
            <TrendFeedRow
              key={trend.id}
              trend={trend}
              subtitle={
                trend.authorCount
                  ? t('feeds.trending.people', { count: trend.authorCount })
                  : t('feeds.trending.subtitle')
              }
              pinned={isPinned(trendKey(trend))}
              canEdit={canEdit}
              onOpen={() => openTrend(trend, index + 1)}
              onTogglePin={() => toggleTrend(trend)}
            />
          ))}
        </>
      ) : null}

      {/* Discover feeds */}
      {toElement(
        RawText(t('feeds.discoverNew.title'))
          .font('md')
          .weight('bold')
          .foreground('foreground')
          .margin('top', '2xl')
          .margin('bottom', 'xs'),
      )}

      {toElement(
        VStack(
          LSearch([searchQuery, setSearchQuery])
            .label(t('feeds.searchPlaceholder'))
            .onClearText(() => setSearchQuery('')),
        )
          .margin('top', 'sm')
          .margin('bottom', 'xs'),
      )}

      {loading && !refreshing && publicFeeds.length === 0 ? (
        <ListSkeleton />
      ) : (
        filteredPublic.map((item) => (
          <FeedRow
            key={String(item._id || item.id)}
            item={item}
            pinned={isPinned(`custom:${item._id || item.id}`)}
            canEdit={canEdit}
            onOpen={() => router.push(`/feeds/${item._id || item.id}`)}
            onTogglePin={() => toggleCustom(String(item._id || item.id))}
          />
        ))
      )}

      {/* Your feeds */}
      {myFeeds.length > 0 && (
        <>
          {toElement(
            RawText(t('feeds.yourFeeds.title'))
              .font('md')
              .weight('bold')
              .foreground('foreground')
              .margin('top', '28')
              .margin('bottom', 'xs'),
          )}
          {myFeeds.map((f) => (
            <FeedRow
              key={String(f._id || f.id)}
              item={f}
              pinned={isPinned(`custom:${f._id || f.id}`)}
              canEdit={canEdit}
              onOpen={() => router.push(`/feeds/${f._id || f.id}`)}
              onTogglePin={() => toggleCustom(String(f._id || f.id))}
            />
          ))}
        </>
      )}

      {toElement(VStack().frame({ height: '80' }))}
    </>
  );

  // The SEO tags draw nothing in place (the document's head on the web).
  const page = Group(
    LEmbed(<SEO title={t('seo.feeds.title')} description={t('seo.feeds.description')} />),
    ScrollView(LEmbed(content))
      .refreshable({ refreshing: refreshing, onRefresh: onRefresh }, { ios: 'primary' })
      .contentMargins('horizontal', 'lg'),
  )
    .onReselect(onRefresh)
    .header(
      Header(t('feeds.title'))
        .toolbar(
          LButton(Icon(RiSettings3Line))
            .shape('circle')
            .style('subtle')
            .tint('neutral')
            .onPress(() => requestSettings('/settings/feed'))
            .label(t('sidebar.settings', { defaultValue: 'Settings' })),
        )
        .inPage(),
    );
  if (!canEdit) return page;
  // The page's own action; the shell's compose FAB steps aside for it.
  return page.floatingAction(
    LEmbed(
      toElement(
        FAB(Icon(RiAddLine))
          .size('md')
          .onPress(() => router.push('/feeds/new'))
          .label(t('feeds.create.title', { defaultValue: 'Create feed' }))
          .glass(identity),
      ),
    ),
  );
});

const styles = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: 16,
  },
});

export default function AvailableFeedsScreen() {
  return (
    <SupervisedFeatureGate>
      <FeedsScreen />
    </SupervisedFeatureGate>
  );
}
