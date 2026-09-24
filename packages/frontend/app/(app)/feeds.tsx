import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  TextInput,
  Platform,
} from 'react-native';
import { Loading } from '@oxy.so/bloom/loading';
import { Button } from '@oxy.so/bloom/button';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiCheckLine } from '@oxy.so/bloom/icons/RiCheckLine';
import { RiCloseCircleLine } from '@oxy.so/bloom/icons/RiCloseCircleLine';
import { RiEarthLine } from '@oxy.so/bloom/icons/RiEarthLine';
import { RiFireLine } from '@oxy.so/bloom/icons/RiFireLine';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiHeartLine } from '@oxy.so/bloom/icons/RiHeartLine';
import { RiLineChartLine } from '@oxy.so/bloom/icons/RiLineChartLine';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { RiSparklingLine } from '@oxy.so/bloom/icons/RiSparklingLine';
import { RiUserCommunityLine } from '@oxy.so/bloom/icons/RiUserCommunityLine';
import { useTranslation } from 'react-i18next';
import { router, useFocusEffect } from 'expo-router';
import { PRESET_FEEDS, type PresetFeed } from '@mention/shared-types/mtn/presetFeeds';
import { useTrendsStore } from '@/stores/trendsStore';
import { reportTrendEvent } from '@/utils/feedTelemetry';
import type { Trend } from '@/interfaces/Trend';

import { Fab } from '@oxy.so/bloom/fab';
import { Avatar } from '@oxy.so/bloom/avatar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';

import { SEO } from '@/components/SEO';
import type { BloomIcon } from '@/components/settings/RowIcon';

import { customFeedsService } from '@/services/customFeedsService';
import { useFeedPreferences } from '@/hooks/useFeedPreferences';
import { useTheme } from '@oxy.so/bloom/theme';
import { Search } from '@/assets/icons/search-icon';
import { formatCompactNumber } from '@/utils/formatNumber';
import { logger } from '@oxy.so/core/logger';
import { useAuth } from '@oxy.so/services/ui/client';
import { HIT_SLOP_MD } from '@/styles/hitSlop';
import { FocusedScrollView } from '@/components/common/FocusedScrollView';
import { useScreenReselect } from '@/context/ScreenReselectContext';

const IS_WEB = Platform.OS === 'web';

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

// Pin toggle button shared by preset + custom rows.
const PinButton = ({ pinned, onPress }: { pinned: boolean; onPress: () => void }) => {
  const theme = useTheme();
  return (
    <TouchableOpacity
      onPress={onPress}
      hitSlop={HIT_SLOP_MD}
      style={[
        styles.pinBtn,
        pinned
          ? { backgroundColor: theme.colors.backgroundSecondary }
          : { backgroundColor: theme.colors.primary },
      ]}
    >
      {pinned ? (
        <RiCheckLine width={14} height={14} fill={theme.colors.text} />
      ) : (
        <RiAddLine width={14} height={14} fill="#fff" />
      )}
    </TouchableOpacity>
  );
};

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
  return (
    <View style={[styles.feedRow, { borderBottomColor: theme.colors.border }]}>
      <TouchableOpacity
        className="flex-1 flex-row items-center gap-3"
        onPress={onOpen}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={t(preset.labelKey)}
      >
        <View className="w-9 h-9 rounded-full items-center justify-center bg-muted">
          <PresetIcon width={20} height={20} fill={theme.colors.primary} />
        </View>
        <View className="flex-1 gap-0.5">
          <Text className="text-[15px] font-semibold text-foreground" numberOfLines={1}>
            {t(preset.labelKey)}
          </Text>
          <Text className="text-[13px] leading-[18px] text-muted-foreground" numberOfLines={2}>
            {t(preset.descriptionKey)}
          </Text>
        </View>
      </TouchableOpacity>
      {canEdit ? <PinButton pinned={pinned} onPress={onTogglePin} /> : null}
    </View>
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
  const theme = useTheme();
  return (
    <View style={[styles.feedRow, { borderBottomColor: theme.colors.border }]}>
      <TouchableOpacity
        className="flex-1 flex-row items-center gap-3"
        onPress={onOpen}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={trend.displayName}
      >
        <View className="w-9 h-9 rounded-full items-center justify-center bg-muted">
          <RiLineChartLine size="md" fill={theme.colors.primary} />
        </View>
        <View className="flex-1 gap-0.5">
          <Text className="text-[15px] font-semibold text-foreground" numberOfLines={1}>
            {trend.displayName}
          </Text>
          <Text className="text-[13px] leading-[18px] text-muted-foreground" numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
      </TouchableOpacity>
      {canEdit ? <PinButton pinned={pinned} onPress={onTogglePin} /> : null}
    </View>
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
  const theme = useTheme();
  const memberCount = (item.memberOxyUserIds || []).length;

  return (
    <View style={[styles.feedRow, { borderBottomColor: theme.colors.border }]}>
      <TouchableOpacity
        className="flex-1 flex-row items-center gap-3"
        onPress={onOpen}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={item.title || 'Untitled Feed'}
      >
        <Avatar source={item.avatar || undefined} size={36} variant={MEDIA_VARIANT_AVATAR} />
        <View className="flex-1 gap-0.5">
          <Text className="text-[15px] font-semibold text-foreground" numberOfLines={1}>
            {item.title || 'Untitled Feed'}
          </Text>
          <Text className="text-[13px] text-muted-foreground" numberOfLines={1}>
            {item.owner ? `@${item.owner.username || item.owner.handle}` : ''}
            {memberCount > 0 ? ` · ${formatCompactNumber(memberCount)} members` : ''}
            {typeof item.likeCount === 'number' && item.likeCount > 0 ? ` · ${formatCompactNumber(item.likeCount)} likes` : ''}
          </Text>
          {item.description ? (
            <Text className="text-[13px] leading-[18px] mt-0.5 text-muted-foreground" numberOfLines={2}>
              {item.description}
            </Text>
          ) : null}
        </View>
      </TouchableOpacity>
      {canEdit ? <PinButton pinned={pinned} onPress={onTogglePin} /> : null}
    </View>
  );
};

const FeedsScreen: React.FC = () => {
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

      const mineIds = new Set((mine.items || []).map((feed: FeedItem) => String(feed._id || feed.id)));
      setPublicFeeds(
        (pub.items || []).filter((feed: FeedItem) => !mineIds.has(String(feed._id || feed.id)))
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
  useScreenReselect({ refresh: onRefresh });

  // Presets available to this viewer: hide viewer-relative (requiresAuth) presets
  // for anonymous viewers.
  const visiblePresets = useMemo(
    () => PRESET_FEEDS.filter((preset) => canUsePrivateApi || !preset.requiresAuth),
    [canUsePrivateApi],
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
    [],
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
    [t],
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
        f.owner?.username?.toLowerCase().includes(q)
    );
  }, [publicFeeds, searchQuery]);

  // Directory body — identical on both platforms; only the scroll host differs.
  const content = (
    <>
      {/* Built-in preset feeds */}
      <Text className="text-[15px] font-bold text-foreground mt-2 mb-1">
        {t('feeds.presets.title')}
      </Text>
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
          <Text className="text-[15px] font-bold text-foreground mt-6 mb-1">
            {t('feeds.trending.title')}
          </Text>
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
      <Text className="text-[15px] font-bold text-foreground mt-6 mb-1">
        {t('feeds.discoverNew.title')}
      </Text>

      <View className="flex-row items-center px-3 h-[38px] rounded-[10px] mt-2 mb-1 gap-2 bg-muted">
        <Search size={18} className="text-muted-foreground" />
        <TextInput
          style={styles.searchInput}
          className="flex-1 text-[15px] text-foreground"
          placeholder={t('feeds.searchPlaceholder')}
          placeholderTextColor={theme.colors.textSecondary}
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={HIT_SLOP_MD}>
            <RiCloseCircleLine width={18} height={18} fill={theme.colors.textSecondary} />
          </TouchableOpacity>
        )}
      </View>

      {loading && !refreshing && publicFeeds.length === 0 ? (
        <Loading className="text-primary" size="large" style={{ flex: undefined, marginTop: 24 }} />
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
          <Text className="text-[15px] font-bold text-foreground mt-7 mb-1">
            {t('feeds.yourFeeds.title')}
          </Text>
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

      <View className="h-20" />
    </>
  );

  return (
    <>
      <SEO title={t('seo.feeds.title')} description={t('seo.feeds.description')} />
      <View className="flex-1 relative flex-col">
        <PageHeader
          title={t('Feeds')}
          actions={
            <Button
              appearance="subtle" tone="neutral"
              iconOnly
              leadingIcon={RiSettings3Line}
              onPress={() => router.push('/settings/feed')}
              accessibilityLabel={t('sidebar.settings', { defaultValue: 'Settings' })}
            />
          }
        />

        {/* WEB: the document (body) is the scroller — the shell owns scroll, so
            the directory renders in normal flow. A ScrollView here would nest a
            second scroll container inside the ContentPanel and break the sticky
            side rails, window scroll-restoration and bottom-bar auto-hide.
            NATIVE: a ScrollView is the correct screen scroller (with
            pull-to-refresh). */}
        {IS_WEB ? (
          <View className="px-4">{content}</View>
        ) : (
          <FocusedScrollView
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />
            }
            contentContainerStyle={styles.scrollContent}
          >
            {content}
          </FocusedScrollView>
        )}

        {/* Clears the BottomBar on every platform — Bloom's Fab reads the
              bottom edge's occupancy, which the bar publishes. */}
        {canEdit ? (
          <Fab
            size="md" placement="bottom-right"
            onPress={() => router.push('/feeds/new')}
            icon={<RiAddLine size="lg" fill={theme.colors.tertiaryForeground} />}
            accessibilityLabel={t('feeds.create.title', { defaultValue: 'Create feed' })}
          />
        ) : null}
      </View>
    </>
  );
};

const styles = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: 16,
  },
  searchInput: {
  },
  feedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  pinBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default FeedsScreen;
