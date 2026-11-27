import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { SupervisedFeatureGate } from '@/components/SupervisedFeatureGate';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, ScrollView, Platform, type ViewStyle } from 'react-native';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  keepPreviousData,
  type InfiniteData,
} from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import { useColorTokens, useTheme } from '@oxy.so/bloom/theme';
import { customFeedsService, type MarketplaceFeed } from '@/services/customFeedsService';
import { toast } from '@oxy.so/bloom/toast';
import { useTranslation } from 'react-i18next';
import { formatCompactNumber } from '@/utils/formatNumber';
import { Rating } from '@oxy.so/bloom/rating';
import { EmptyState } from '@/components/common/EmptyState';
import { FeedCard, FeedCardSkeleton, type FeedCardData } from '@/components/FeedCard';
import { FeedSubscribeButton } from '@/components/FeedSubscribeButton';
import type { CustomFeedListResponse } from '@mention/shared-types';
import { publicQueryKeys, viewerQueryKeys } from '@/lib/viewerQueryKeys';

import {
  Button as LButton,
  Embed,
  HStack,
  Header,
  Icon,
  RawText,
  ScrollView as LScrollView,
  Search as LSearch,
  VStack,
  VirtualList,
  toElement,
  Embed as LEmbed,
  defineTokens,
} from '@oxy.so/bloom-language';

import { screen as Lscreen } from '@oxy.so/bloom-language/router';

const PAGE_LIMIT = 20;

const IS_WEB = Platform.OS === 'web';

type SortBy = 'trending' | 'top_rated' | 'newest';

const SORT_OPTIONS_CONFIG: { id: SortBy; labelKey: string }[] = [
  { id: 'trending', labelKey: 'feeds.marketplace.trending' },
  { id: 'top_rated', labelKey: 'feeds.marketplace.topRated' },
  { id: 'newest', labelKey: 'feeds.marketplace.newest' },
];

const ALL_CATEGORY = 'All';

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
          displayName: item.owner.name?.displayName,
          kind: item.owner.kind,
          character: item.owner.character,
          color: item.owner.color,
          avatar: item.owner.avatar ?? undefined,
        }
      : undefined,
    likeCount: item.likeCount,
    memberCount: item.memberCount,
    topicCount: item.topicCount,
    memberAvatars: item.memberAvatars,
    memberProfiles: item.memberProfiles,
  };

  return toElement(
    VStack(
      Embed(
        <FeedCard
          feed={feedData}
          showDescription
          showLikes={false}
          headerRight={
            <FeedSubscribeButton
              isSubscribed={item.isLiked || false}
              isSubscribing={isSubscribing}
              onPress={handleSubscribe}
            />
          }
        />,
      ),
      /* Extra marketplace metadata below the card */ averageRating > 0 || subscriberCount > 0
        ? HStack(
            Embed(
              averageRating > 0 && (
                <Rating
                  variant="stars"
                  size="sm"
                  value={averageRating.toFixed(1)}
                  fillValue={averageRating}
                  count={reviewCount > 0 ? formatCompactNumber(reviewCount) : undefined}
                  starColor={theme.colors.primary}
                />
              ),
            ),
            subscriberCount > 0
              ? HStack(
                  Icon(RiGroupLine).size('13').foreground('muted'),
                  RawText(formatCompactNumber(subscriberCount)).font('sm').foreground('muted'),
                )
                  .align('center')
                  .spacing('3')
              : null,
          )
            .padding('horizontal', 'lg')
            .padding('bottom', 'sm')
            .align('center')
            .spacing('md')
            .margin('top', '-xs')
        : null,
    )
      .margin('horizontal', 'lg')
      .margin('top', 'md'),
  );
});

const FeedMarketplaceScreen = Lscreen(function FeedMarketplaceScreen() {
  const colors = useColorTokens();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { user } = useAuth();

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
  const marketplaceKey = useMemo(
    () =>
      viewerQueryKeys.customFeedMarketplace(user?.id, {
        sortBy,
        category: activeCategory,
        search: debouncedSearch,
      }),
    [sortBy, activeCategory, debouncedSearch, user?.id],
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
    queryKey: publicQueryKeys.marketplaceCategories(),
    queryFn: () => customFeedsService.getMarketplaceCategories(),
    staleTime: 10 * 60 * 1000,
  });

  const categories = useMemo(() => categoriesQuery.data?.categories ?? [], [categoriesQuery.data]);

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
        toast(t('marketplace.subscribeError', { defaultValue: 'Action failed' }), {
          type: 'error',
        });
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

  const keyExtractor = useCallback((item: MarketplaceFeed) => String(item._id || item.id), []);

  const ListHeader = useMemo(
    () =>
      toElement(
        VStack(
          Embed(
            searchVisible &&
              toElement(
                VStack(
                  LSearch([search, handleSearchChange])
                    .label(t('marketplace.searchPlaceholder', { defaultValue: 'Search feeds...' }))
                    .onClearText(() => handleSearchChange(''))
                    .autoFocus(),
                )
                  .margin('horizontal', 'lg')
                  .margin('top', 'sm')
                  .margin('bottom', 'xs'),
              ),
          ),
          Embed(
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.pillsContent}
              style={classStyles.pills}
            >
              {categoryPills.map((cat) => {
                const active = cat === activeCategory;
                return toElement(
                  VStack(
                    RawText(cat)
                      .font('14')
                      .leading('20px')
                      .weight('medium')
                      .foreground(active ? 'white' : 'foreground'),
                  )
                    .padding('horizontal', '14')
                    .padding('vertical', marketTokens.space.pillY)
                    .when(active, (v) => v.background('primary'))
                    .when(!active, (v) => v.border('border', 'thin'))
                    .corner('xl')
                    .onPress(() => handleCategoryPress(cat))
                    .pressFade('70'),
                  cat,
                );
              })}
            </ScrollView>,
          ),
          HStack(
            Embed(
              SORT_OPTIONS_CONFIG.map((opt) => {
                const active = opt.id === sortBy;
                return toElement(
                  VStack(
                    RawText(t(opt.labelKey))
                      .font('14')
                      .leading('20px')
                      .weight(active ? 'bold' : 'medium')
                      .foreground(active ? 'primary' : 'muted'),
                    active
                      ? Embed(
                          toElement(
                            VStack()
                              .frame({ height: '2xs' })
                              .background('primary')
                              .corner('xs', 'top-left')
                              .corner('xs', 'top-right')
                              .position({ bottom: 'none', left: '25%', right: '25%' }),
                          ),
                        )
                      : null,
                  )
                    .flex('1')
                    .align('center')
                    .padding('vertical', '10')
                    .onPress(() => handleSortPress(opt.id))
                    .pressFade('70'),
                  opt.id,
                );
              }),
            ),
          )
            .margin('top', 'md')
            .border('border', 'thin', 'bottom'),
        ),
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
      colors.primary,
      t,
    ],
  );

  const ListEmpty = useMemo(() => {
    if (loading) return undefined;
    return (
      <EmptyState
        title={t('marketplace.emptyTitle', { defaultValue: 'No feeds found' })}
        subtitle={
          debouncedSearch
            ? t('marketplace.emptySearchSubtitle', {
                defaultValue: 'Try a different search term or category',
              })
            : t('marketplace.emptySubtitle', {
                defaultValue: 'Be the first to create a feed in this category',
              })
        }
        sticker="feedStore"
      />
    );
  }, [loading, debouncedSearch, t]);

  const ListFooter = useMemo(
    () => (loadingMore ? <ListSkeleton count={2} /> : toElement(VStack().frame({ height: '3xl' }))),
    [loadingMore],
  );

  return LEmbed(
    loading && feeds.length === 0
      ? toElement(
          LScrollView(
            Embed(Array.from({ length: 4 }).map((_, i) => <FeedCardSkeleton key={i} />)),
          ).contentView((v) => v.padding('horizontal', 'lg').padding('top', 'lg').spacing('md')),
        )
      : IS_WEB
        ? toElement(
            LScrollView(
              Embed(ListHeader),
              Embed(
                feeds.length === 0
                  ? ListEmpty
                  : feeds.map((item) => (
                      <MarketplaceFeedCard
                        key={keyExtractor(item)}
                        item={item}
                        onSubscribeToggle={handleSubscribeToggle}
                        subscribingId={subscribingId}
                      />
                    )),
              ),
              Embed(ListFooter),
            )
              .contentView((v) => v.padding('bottom', '3xl'))
              .onEndReached(handleLoadMore)
              .keyboardTaps('handled'),
          )
        : toElement(
            VirtualList(feeds, renderItem)
              .screen()
              .itemKey(keyExtractor)
              .headerContent(Embed(ListHeader))
              .emptyState(Embed(ListEmpty))
              .footerContent(Embed(ListFooter))
              .contentMargins('bottom', '3xl')
              .onEndReached(handleLoadMore, 0.4)
              .refreshable({ refreshing, onRefresh: handleRefresh })
              .scrollbar('never')
              .keyboardTaps('handled')
              .scrollDismissesKeyboard('immediately'),
          ),
  ).header(
    LEmbed(
      toElement(
        Header(t('marketplace.title', { defaultValue: 'Feed Marketplace' }))
          .backLabel(t('common.back', { defaultValue: 'Back' }))
          .toolbar(
            LButton(Icon(searchVisible ? RiCloseLine : RiSearchLine))
              .style('subtle')
              .tint('neutral')
              .shape('circle')
              .onPress(() => {
                setSearchVisible((v) => !v);
                if (searchVisible) handleSearchChange('');
              })
              .label(
                searchVisible
                  ? t('common.close', { defaultValue: 'Close' })
                  : t('search.title', { defaultValue: 'Search' }),
              ),
          )
          .inPage(),
      ),
    ),
  );
});

// The category pills' scroller stays React Native (a horizontal ScrollView); this draws
// what its class drew.
const classStyles = {
  pills: { marginTop: 12 },
} satisfies Record<string, ViewStyle>;

/** A category pill's 7pt vertical padding, off the space scale. */
const marketTokens = defineTokens({ space: { pillY: 7 } });

const styles = StyleSheet.create({
  pillsContent: {
    paddingHorizontal: 16,
    gap: 8,
  },
});

export default function AvailableFeedMarketplaceScreen() {
  return (
    <SupervisedFeatureGate>
      <FeedMarketplaceScreen />
    </SupervisedFeatureGate>
  );
}
