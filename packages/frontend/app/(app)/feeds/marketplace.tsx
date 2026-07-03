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
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  keepPreviousData,
  type InfiniteData,
} from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
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
import { LoadMoreSentinel } from '@/components/common/LoadMoreSentinel';
import type { CustomFeed, CustomFeedListResponse } from '@mention/shared-types';

const PAGE_LIMIT = 20;

const IS_WEB = Platform.OS === 'web';

/**
 * A `CustomFeed` as returned by the `/feeds/marketplace` endpoint, which
 * enriches each item with a resolved owner summary, member avatar URLs, and a
 * derived topic count (see `customFeeds.routes.ts` normalization).
 */
type MarketplaceFeed = CustomFeed & {
  owner?: { username?: string; displayName?: string; avatar?: string };
  memberAvatars?: string[];
  topicCount?: number;
};

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
  item: MarketplaceFeed;
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
  const queryClient = useQueryClient();
  const { isAuthenticated, user } = useAuth();

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
    }, 350);
  }, []);

  // Include the viewer identity in the key so the per-viewer `isLiked`
  // (subscribed) flags refetch when a slow SSO cold-boot session lands, rather
  // than sticking to the anonymous snapshot for the whole staleTime window.
  const authKey = isAuthenticated && user?.id ? user.id : 'anon';

  const marketplaceKey = useMemo(
    () => ['marketplace', sortBy, activeCategory, debouncedSearch, authKey] as const,
    [sortBy, activeCategory, debouncedSearch, authKey],
  );

  const feedsQuery = useInfiniteQuery({
    queryKey: marketplaceKey,
    queryFn: ({ pageParam }) => {
      const params: Parameters<typeof customFeedsService.getMarketplace>[0] = {
        page: pageParam,
        limit: PAGE_LIMIT,
        sortBy,
      };
      if (activeCategory !== ALL_CATEGORY) params.category = activeCategory;
      if (debouncedSearch.trim()) params.search = debouncedSearch.trim();
      return customFeedsService.getMarketplace(params);
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, pageData) => sum + (pageData.items?.length ?? 0), 0);
      return loaded < (lastPage.total ?? 0) ? allPages.length + 1 : undefined;
    },
    // Keep the current results on screen while a new sort/category/search query
    // resolves (mirrors the old "keep old feeds until the replace lands" UX).
    placeholderData: keepPreviousData,
  });

  const {
    data: feedsData,
    isLoading: loading,
    isRefetching,
    isFetchingNextPage: loadingMore,
    hasNextPage: hasMore,
    refetch,
    fetchNextPage,
  } = feedsQuery;

  const feeds = useMemo<MarketplaceFeed[]>(
    () => feedsData?.pages.flatMap((pageData) => pageData.items ?? []) ?? [],
    [feedsData],
  );

  // Pull-to-refresh spins only on a same-key refetch, not while paginating.
  const refreshing = isRefetching && !loadingMore;

  const handleRefresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  const handleLoadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    void fetchNextPage();
  }, [loadingMore, hasMore, fetchNextPage]);

  const handleCategoryPress = useCallback((cat: string) => {
    setActiveCategory(cat);
  }, []);

  const handleSortPress = useCallback((id: SortBy) => {
    setSortBy(id);
  }, []);

  // Categories rarely change — cache for 10 minutes and share across revisits.
  // Public (not viewer-specific) data, so keyed without the viewer identity.
  const categoriesQuery = useQuery({
    queryKey: ['marketplaceCategories'],
    queryFn: () => customFeedsService.getMarketplaceCategories(),
    staleTime: 10 * 60 * 1000,
  });

  const categories = useMemo(
    () => categoriesQuery.data?.categories ?? [],
    [categoriesQuery.data],
  );

  const handleSubscribeToggle = useCallback(
    async (feedId: string, isSubscribed: boolean) => {
      if (subscribingId) return;
      setSubscribingId(feedId);

      // Optimistically flip the subscribed flag + like count in the infinite
      // query cache; `delta` reverses on failure.
      const applyToggle = (nextSubscribed: boolean, delta: number) =>
        queryClient.setQueryData<InfiniteData<CustomFeedListResponse>>(marketplaceKey, (prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            pages: prev.pages.map((pageData) => ({
              ...pageData,
              items: pageData.items.map((f) => {
                if (String(f._id || f.id) !== feedId) return f;
                return {
                  ...f,
                  isLiked: nextSubscribed,
                  likeCount: Math.max(0, (f.likeCount || 0) + delta),
                };
              }),
            })),
          };
        });

      applyToggle(!isSubscribed, isSubscribed ? -1 : 1);

      try {
        if (isSubscribed) {
          await customFeedsService.unlikeFeed(feedId);
        } else {
          await customFeedsService.likeFeed(feedId);
        }
      } catch {
        applyToggle(isSubscribed, isSubscribed ? 1 : -1);
        toast(t('marketplace.subscribeError', { defaultValue: 'Action failed' }), { type: 'error' });
      } finally {
        setSubscribingId(null);
      }
    },
    [subscribingId, t, queryClient, marketplaceKey],
  );

  const categoryPills = useMemo(
    () => [ALL_CATEGORY, ...categories.map((c) => c.category)],
    [categories],
  );

  const renderItem = useCallback(
    ({ item }: { item: MarketplaceFeed }) => (
      <MarketplaceFeedCard
        item={item}
        onSubscribeToggle={handleSubscribeToggle}
        subscribingId={subscribingId}
      />
    ),
    [handleSubscribeToggle, subscribingId],
  );

  const keyExtractor = useCallback(
    (item: MarketplaceFeed) => String(item._id || item.id),
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

  const ListFooter = useMemo(
    () => (
      <View>
        {/* WEB infinite-scroll trigger — Bloom's web lists are window
            virtualizers with no `onEndReached`, so a 1px sentinel fires
            `handleLoadMore` ~600px before it enters the viewport. Inert on
            native, which paginates via the FlatList's `onEndReached`. */}
        <LoadMoreSentinel onLoadMore={handleLoadMore} enabled={hasMore} />
        {loadingMore ? (
          <View className="py-5 items-center">
            <SpinnerIcon size={20} className="text-primary" />
          </View>
        ) : (
          <View className="h-8" />
        )}
      </View>
    ),
    [loadingMore, handleLoadMore, hasMore],
  );

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
      ) : IS_WEB ? (
        // WEB: the document (body) is the scroller — the shell owns scroll, so
        // the marketplace renders in normal flow. A FlatList here would nest a
        // second scroll container inside the ContentPanel and break the sticky
        // side rails, window scroll-restoration and bottom-bar auto-hide.
        // Pagination is driven by the LoadMoreSentinel inside ListFooter. The
        // horizontal category-pills ScrollView inside ListHeader stays — a
        // horizontal scroller does not conflict with the document scroll.
        <View className="pb-8">
          {ListHeader}
          {feeds.length === 0
            ? ListEmpty
            : feeds.map((item) => (
                <MarketplaceFeedCard
                  key={keyExtractor(item)}
                  item={item}
                  onSubscribeToggle={handleSubscribeToggle}
                  subscribingId={subscribingId}
                />
              ))}
          {ListFooter}
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
  web: { outlineWidth: 0 },
  default: {},
});
