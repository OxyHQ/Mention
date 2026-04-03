import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  TextInput,
  TextStyle,
  ScrollView,
  Platform,
  StyleProp,
} from 'react-native';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useTheme } from '@oxyhq/bloom/theme';
import { customFeedsService } from '@/services/customFeedsService';
import { useSafeBack } from '@/hooks/useSafeBack';
import { show as toast } from '@oxyhq/bloom/toast';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { formatCompactNumber } from '@/utils/formatNumber';
import StarRating from '@/components/StarRating';
import { cn } from '@/lib/utils';
import { FeedCard, FeedCardSkeleton, type FeedCardData } from '@/components/FeedCard';

const PAGE_LIMIT = 20;

type SortBy = 'trending' | 'top_rated' | 'newest';

const SORT_OPTIONS_CONFIG: { id: SortBy; labelKey: string }[] = [
  { id: 'trending', labelKey: 'feeds.marketplace.trending' },
  { id: 'top_rated', labelKey: 'feeds.marketplace.topRated' },
  { id: 'newest', labelKey: 'feeds.marketplace.newest' },
];

const ALL_CATEGORY = 'All';

/**
 * Subscribe button rendered in the FeedCard headerRight slot.
 */
const SubscribeButton = React.memo(function SubscribeButton({
  isSubscribed,
  isSubscribing,
  onPress,
}: {
  isSubscribed: boolean;
  isSubscribing: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <TouchableOpacity
      style={[
        styles.subscribeBtn,
        isSubscribed
          ? { borderColor: theme.colors.border, backgroundColor: 'transparent' }
          : { backgroundColor: theme.colors.primary },
      ]}
      onPress={onPress}
      disabled={isSubscribing}
      activeOpacity={0.7}>
      {isSubscribing ? (
        <SpinnerIcon size={16} className={isSubscribed ? "text-foreground" : "text-primary-foreground"} />
      ) : (
        <Text
          className={cn(
            'text-[13px] font-bold',
            isSubscribed ? 'text-foreground' : 'text-white',
          )}>
          {isSubscribed ? 'Subscribed' : 'Subscribe'}
        </Text>
      )}
    </TouchableOpacity>
  );
});

/**
 * Marketplace feed item — wraps the shared FeedCard with
 * subscribe button, rating, and subscriber count.
 */
const MarketplaceFeedCard = React.memo(function MarketplaceFeedCard({
  item,
  onSubscribeToggle,
  subscribingId,
}: {
  item: any;
  onSubscribeToggle: (id: string, isSubscribed: boolean) => void;
  subscribingId: string | null;
}) {
  const theme = useTheme();
  const feedId = String(item._id || item.id);
  const isSubscribing = subscribingId === feedId;

  const handleSubscribe = useCallback(() => {
    onSubscribeToggle(feedId, item.isLiked || false);
  }, [feedId, item.isLiked, onSubscribeToggle]);

  const averageRating = item.averageRating || 0;
  const reviewCount = item.ratingsCount || 0;
  const subscriberCount = item.subscriberCount || 0;

  const feedData: FeedCardData = {
    id: feedId,
    displayName: item.title,
    description: item.description,
    avatar: item.avatar,
    creator: item.owner
      ? {
          username: item.owner.username || '',
          displayName: item.owner.displayName,
          avatar: item.owner.avatar,
        }
      : undefined,
    likeCount: item.likeCount,
    memberCount: item.memberCount,
    topicCount: item.topicCount,
    memberAvatars: item.memberAvatars,
  };

  return (
    <View className="mx-4 mt-3">
      <FeedCard
        feed={feedData}
        showDescription
        showLikes={false}
        headerRight={
          <SubscribeButton
            isSubscribed={item.isLiked || false}
            isSubscribing={isSubscribing}
            onPress={handleSubscribe}
          />
        }
      />
      {/* Extra marketplace metadata below the card */}
      {(averageRating > 0 || subscriberCount > 0) && (
        <View className="flex-row items-center gap-3 px-4 pb-2 -mt-1">
          {averageRating > 0 && (
            <View className="flex-row items-center gap-1">
              <StarRating rating={averageRating} color={theme.colors.primary} />
              <Text className="text-[13px] text-muted-foreground">
                {averageRating.toFixed(1)}
                {reviewCount > 0 ? ` (${formatCompactNumber(reviewCount)})` : ''}
              </Text>
            </View>
          )}
          {subscriberCount > 0 && (
            <View className="flex-row items-center gap-[3px]">
              <Ionicons name="people-outline" size={13} color={theme.colors.textSecondary} />
              <Text className="text-[13px] text-muted-foreground">
                {formatCompactNumber(subscriberCount)}
              </Text>
            </View>
          )}
        </View>
      )}
    </View>
  );
});

export default function FeedMarketplaceScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const safeBack = useSafeBack();

  const [feeds, setFeeds] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [categories, setCategories] = useState<Array<{ category: string; count: number }>>([]);
  const [activeCategory, setActiveCategory] = useState<string>(ALL_CATEGORY);
  const [sortBy, setSortBy] = useState<SortBy>('trending');
  const [search, setSearch] = useState('');
  const [searchVisible, setSearchVisible] = useState(false);
  const [subscribingId, setSubscribingId] = useState<string | null>(null);

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);

  const handleSearchChange = useCallback((text: string) => {
    setSearch(text);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setDebouncedSearch(text);
      setPage(1);
    }, 350);
  }, []);

  useEffect(() => {
    customFeedsService
      .getMarketplaceCategories()
      .then((res) => setCategories(res.categories || []))
      .catch(() => {});
  }, []);

  const fetchFeeds = useCallback(
    async (opts: { pageNum: number; replace: boolean }) => {
      const { pageNum, replace } = opts;
      if (replace) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }

      try {
        const params: Parameters<typeof customFeedsService.getMarketplace>[0] = {
          page: pageNum,
          limit: PAGE_LIMIT,
          sortBy,
        };
        if (activeCategory !== ALL_CATEGORY) params.category = activeCategory;
        if (debouncedSearch.trim()) params.search = debouncedSearch.trim();

        const res = await customFeedsService.getMarketplace(params);
        const items = res.items || [];
        setTotal(res.total || 0);
        setFeeds((prev) => (replace ? items : [...prev, ...items]));
        setPage(pageNum);
      } catch {
        toast(t('marketplace.loadError', { defaultValue: 'Failed to load feeds' }), { type: 'error' });
      } finally {
        setLoading(false);
        setLoadingMore(false);
        setRefreshing(false);
      }
    },
    [activeCategory, sortBy, debouncedSearch, t],
  );

  useEffect(() => {
    fetchFeeds({ pageNum: 1, replace: true });
  }, [fetchFeeds]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    fetchFeeds({ pageNum: 1, replace: true });
  }, [fetchFeeds]);

  const handleLoadMore = useCallback(() => {
    if (loadingMore || loading) return;
    if (feeds.length >= total) return;
    fetchFeeds({ pageNum: page + 1, replace: false });
  }, [loadingMore, loading, feeds.length, total, page, fetchFeeds]);

  const handleCategoryPress = useCallback((cat: string) => {
    setActiveCategory(cat);
    setPage(1);
  }, []);

  const handleSortPress = useCallback((id: SortBy) => {
    setSortBy(id);
    setPage(1);
  }, []);

  const handleSubscribeToggle = useCallback(
    async (feedId: string, isSubscribed: boolean) => {
      if (subscribingId) return;
      setSubscribingId(feedId);

      setFeeds((prev) =>
        prev.map((f) => {
          const fid = String(f._id || f.id);
          if (fid !== feedId) return f;
          const delta = isSubscribed ? -1 : 1;
          return {
            ...f,
            isLiked: !isSubscribed,
            likeCount: Math.max(0, (f.likeCount || 0) + delta),
          };
        }),
      );

      try {
        if (isSubscribed) {
          await customFeedsService.unlikeFeed(feedId);
        } else {
          await customFeedsService.likeFeed(feedId);
        }
      } catch {
        setFeeds((prev) =>
          prev.map((f) => {
            const fid = String(f._id || f.id);
            if (fid !== feedId) return f;
            const delta = isSubscribed ? 1 : -1;
            return {
              ...f,
              isLiked: isSubscribed,
              likeCount: Math.max(0, (f.likeCount || 0) + delta),
            };
          }),
        );
        toast(t('marketplace.subscribeError', { defaultValue: 'Action failed' }), { type: 'error' });
      } finally {
        setSubscribingId(null);
      }
    },
    [subscribingId, t],
  );

  const categoryPills = useMemo(
    () => [ALL_CATEGORY, ...categories.map((c) => c.category)],
    [categories],
  );

  const renderItem = useCallback(
    ({ item }: { item: any }) => (
      <MarketplaceFeedCard
        item={item}
        onSubscribeToggle={handleSubscribeToggle}
        subscribingId={subscribingId}
      />
    ),
    [handleSubscribeToggle, subscribingId],
  );

  const keyExtractor = useCallback(
    (item: any) => String(item._id || item.id),
    [],
  );

  const ListHeader = useMemo(
    () => (
      <View>
        {searchVisible && (
          <View className="flex-row items-center gap-2 mx-4 mt-2 mb-1 border border-border rounded-xl px-3 py-[9px] bg-secondary">
            <Ionicons name="search" size={16} color={theme.colors.textSecondary} />
            <TextInput
              value={search}
              onChangeText={handleSearchChange}
              placeholder={t('marketplace.searchPlaceholder', { defaultValue: 'Search feeds...' })}
              placeholderTextColor={theme.colors.textSecondary}
              style={searchInputStyle}
              className="flex-1 text-[15px] text-foreground"
              autoFocus
              returnKeyType="search"
            />
            {search.length > 0 && (
              <TouchableOpacity onPress={() => handleSearchChange('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close-circle" size={16} color={theme.colors.textSecondary} />
              </TouchableOpacity>
            )}
          </View>
        )}

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.pillsContent}
          className="mt-3">
          {categoryPills.map((cat) => {
            const active = cat === activeCategory;
            return (
              <TouchableOpacity
                key={cat}
                style={[
                  styles.pill,
                  active
                    ? { backgroundColor: theme.colors.primary }
                    : { borderWidth: 1, borderColor: theme.colors.border },
                ]}
                onPress={() => handleCategoryPress(cat)}
                activeOpacity={0.7}>
                <Text
                  className={cn(
                    'text-sm font-medium',
                    active ? 'text-white' : 'text-foreground',
                  )}>
                  {cat}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        <View style={[styles.sortRow, { borderBottomColor: theme.colors.border }]}>
          {SORT_OPTIONS_CONFIG.map((opt) => {
            const active = opt.id === sortBy;
            return (
              <TouchableOpacity
                key={opt.id}
                className="flex-1 items-center py-2.5 relative"
                onPress={() => handleSortPress(opt.id)}
                activeOpacity={0.7}>
                <Text
                  className={cn(
                    'text-sm',
                    active ? 'font-bold text-primary' : 'font-medium text-muted-foreground',
                  )}>
                  {t(opt.labelKey)}
                </Text>
                {active && <View style={styles.sortIndicator} className="bg-primary" />}
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    ),
    [
      searchVisible,
      search,
      handleSearchChange,
      categoryPills,
      activeCategory,
      handleCategoryPress,
      sortBy,
      handleSortPress,
      theme,
      t,
    ],
  );

  const ListEmpty = useMemo(() => {
    if (loading) return null;
    return (
      <View className="pt-[60px] px-10 items-center gap-3">
        <Ionicons name="telescope-outline" size={52} color={theme.colors.textSecondary} />
        <Text className="text-lg font-bold text-center text-foreground">
          {t('marketplace.emptyTitle', { defaultValue: 'No feeds found' })}
        </Text>
        <Text className="text-sm leading-5 text-center text-muted-foreground">
          {debouncedSearch
            ? t('marketplace.emptySearchSubtitle', { defaultValue: 'Try a different search term or category' })
            : t('marketplace.emptySubtitle', { defaultValue: 'Be the first to create a feed in this category' })}
        </Text>
      </View>
    );
  }, [loading, debouncedSearch, theme, t]);

  const ListFooter = useMemo(() => {
    if (!loadingMore) return <View className="h-8" />;
    return (
      <View className="py-5 items-center">
        <SpinnerIcon size={20} className="text-primary" />
      </View>
    );
  }, [loadingMore, theme.colors.primary]);

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('marketplace.title', { defaultValue: 'Feed Marketplace' }),
          headerTitleStyle: { justifyContent: 'flex-start', flex: 1 },
          leftComponents: [
            <IconButton variant="icon" key="back" onPress={() => safeBack()}>
              <BackArrowIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
          rightComponents: [
            <IconButton
              variant="icon"
              key="search"
              onPress={() => {
                setSearchVisible((v) => !v);
                if (searchVisible) handleSearchChange('');
              }}>
              <Ionicons
                name={searchVisible ? 'close' : 'search'}
                size={22}
                color={theme.colors.text}
              />
            </IconButton>,
          ],
        }}
        hideBottomBorder
        disableSticky={false}
      />

      {loading && feeds.length === 0 ? (
        <View className="px-4 pt-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <FeedCardSkeleton key={i} />
          ))}
        </View>
      ) : (
        <FlatList
          data={feeds}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          ListHeaderComponent={ListHeader}
          ListEmptyComponent={ListEmpty}
          ListFooterComponent={ListFooter}
          contentContainerStyle={styles.listContent}
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.4}
          onRefresh={handleRefresh}
          refreshing={refreshing}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        />
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  listContent: {
    paddingBottom: 32,
  },
  pillsContent: {
    paddingHorizontal: 16,
    gap: 8,
  },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
  },
  sortRow: {
    flexDirection: 'row',
    marginTop: 12,
    borderBottomWidth: 1,
  },
  sortIndicator: {
    position: 'absolute',
    bottom: 0,
    left: '25%',
    right: '25%',
    height: 2,
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
  },
  subscribeBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    minWidth: 88,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
});

const searchInputStyle: StyleProp<TextStyle> = Platform.select({
  web: { outlineStyle: 'none' } as TextStyle,
  default: {},
});
