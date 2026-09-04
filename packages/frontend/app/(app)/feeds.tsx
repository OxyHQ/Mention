import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  TextInput,
  Platform,
} from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { SafeAreaView } from '@/lib/SafeAreaViewInterop';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import { router, useFocusEffect } from 'expo-router';
import { PRESET_FEEDS, type PresetFeed } from '@mention/shared-types/mtn/presetFeeds';
import { useTrendsStore } from '@/stores/trendsStore';
import { reportTrendEvent } from '@/utils/feedTelemetry';
import type { Trend } from '@/interfaces/Trend';

import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { Fab } from '@oxyhq/bloom/fab';
import { Avatar } from '@oxyhq/bloom/avatar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';

import { SEO } from '@/components/SEO';

import { customFeedsService } from '@/services/customFeedsService';
import { useFeedPreferences } from '@/hooks/useFeedPreferences';
import { useTheme } from '@oxyhq/bloom/theme';
import { Search } from '@/assets/icons/search-icon';
import { formatCompactNumber } from '@/utils/formatNumber';
import { logger } from '@oxyhq/core/logger';
import { useAuth } from '@oxyhq/services/ui/client';
import { HIT_SLOP_MD } from '@/styles/hitSlop';

const IS_WEB = Platform.OS === 'web';

/**
 * Ionicons glyph per preset id. The shared catalog carries Lucide names; the
 * feeds screen renders with Ionicons (its existing icon set), so this maps the
 * small, fixed preset set rather than pulling in a second icon library.
 */
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

const PRESET_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  for_you: 'sparkles',
  following: 'people',
  trending: 'flame',
  explore: 'compass',
  mutuals: 'people-circle',
  friends_popular: 'heart',
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
      <Ionicons name={pinned ? 'checkmark' : 'add'} size={14} color={pinned ? theme.colors.text : '#fff'} />
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
          <Ionicons name={PRESET_ICONS[preset.id] ?? 'sparkles'} size={20} color={theme.colors.primary} />
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
          <Ionicons name="trending-up" size={20} color={theme.colors.primary} />
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
            <Ionicons name="close-circle" size={18} color={theme.colors.textSecondary} />
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
      <SafeAreaView className="flex-1 bg-background relative flex-col" edges={['top']}>
        <Header
          options={{
            title: t('Feeds'),
            rightComponents: [
              <IconButton variant="icon" key="settings" onPress={() => router.push('/settings/feed')}>
                <Ionicons name="settings-outline" size={22} color={theme.colors.text} />
              </IconButton>,
            ],
          }}
          hideBottomBorder
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
          <ScrollView
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />
            }
            contentContainerStyle={styles.scrollContent}
          >
            {content}
          </ScrollView>
        )}

        {/* Clears the BottomBar on every platform — Bloom's Fab reads the
              bottom edge's occupancy, which the bar publishes. */}
        {canEdit ? (
          <Fab
            size={48}
            onPress={() => router.push('/feeds/new')}
            icon={<Ionicons name="add" size={24} color={theme.colors.tertiaryForeground} />}
            accessibilityLabel={t('feeds.create.title', { defaultValue: 'Create feed' })}
          />
        ) : null}
      </SafeAreaView>
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
