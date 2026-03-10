import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  TextInput,
  ScrollView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import Avatar from '@/components/Avatar';
import { useTheme } from '@/hooks/useTheme';
import { customFeedsService } from '@/services/customFeedsService';
import { router } from 'expo-router';
import { toast } from '@/lib/sonner';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { formatCompactNumber } from '@/utils/formatNumber';

const PAGE_LIMIT = 20;

type SortBy = 'trending' | 'top_rated' | 'newest';

const SORT_OPTIONS: { id: SortBy; label: string }[] = [
  { id: 'trending', label: 'Trending' },
  { id: 'top_rated', label: 'Top Rated' },
  { id: 'newest', label: 'Newest' },
];

const ALL_CATEGORY = 'All';

// Star rating display — filled vs outline icons
const StarRating = React.memo(function StarRating({
  rating,
  size = 14,
  color,
}: {
  rating: number;
  size?: number;
  color: string;
}) {
  const stars = useMemo(() => {
    return Array.from({ length: 5 }, (_, i) => {
      const filled = i < Math.round(rating);
      return { key: i, filled };
    });
  }, [rating]);

  return (
    <View style={starStyles.row}>
      {stars.map(({ key, filled }) => (
        <Ionicons
          key={key}
          name={filled ? 'star' : 'star-outline'}
          size={size}
          color={color}
        />
      ))}
    </View>
  );
});

const starStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 1,
  },
});

// Individual feed card
interface FeedCardProps {
  item: any;
  onSubscribeToggle: (id: string, isSubscribed: boolean) => void;
  subscribingId: string | null;
}

const FeedCard = React.memo(function FeedCard({
  item,
  onSubscribeToggle,
  subscribingId,
}: FeedCardProps) {
  const theme = useTheme();
  const feedId = String(item._id || item.id);
  const isSubscribing = subscribingId === feedId;

  const handlePress = useCallback(() => {
    router.push(`/feeds/${feedId}` as any);
  }, [feedId]);

  const handleSubscribe = useCallback(() => {
    onSubscribeToggle(feedId, item.isLiked || false);
  }, [feedId, item.isLiked, onSubscribeToggle]);

  const subscriberCount = item.subscriberCount || 0;
  const averageRating = item.averageRating || 0;
  const reviewCount = item.ratingsCount || 0;
  const ownerName = item.owner?.displayName || item.owner?.username || '';
  const ownerAvatar = item.owner?.avatar;

  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: theme.colors.backgroundSecondary }]}
      onPress={handlePress}
      activeOpacity={0.75}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleArea}>
          <Text style={[styles.cardTitle, { color: theme.colors.text }]} numberOfLines={1}>
            {item.title}
          </Text>
          {item.category ? (
            <View style={[styles.categoryBadge, { backgroundColor: `${theme.colors.primary}20` }]}>
              <Text style={[styles.categoryBadgeText, { color: theme.colors.primary }]}>
                {item.category}
              </Text>
            </View>
          ) : null}
        </View>
        <TouchableOpacity
          style={[
            styles.subscribeBtn,
            item.isLiked
              ? { borderColor: theme.colors.border, backgroundColor: 'transparent' }
              : { backgroundColor: theme.colors.primary },
          ]}
          onPress={handleSubscribe}
          disabled={isSubscribing}
          activeOpacity={0.7}
        >
          {isSubscribing ? (
            <ActivityIndicator size="small" color={item.isLiked ? theme.colors.text : '#fff'} />
          ) : (
            <Text
              style={[
                styles.subscribeBtnText,
                { color: item.isLiked ? theme.colors.text : '#fff' },
              ]}
            >
              {item.isLiked ? 'Subscribed' : 'Subscribe'}
            </Text>
          )}
        </TouchableOpacity>
      </View>

      {item.description ? (
        <Text
          style={[styles.cardDescription, { color: theme.colors.textSecondary }]}
          numberOfLines={2}
        >
          {item.description}
        </Text>
      ) : null}

      <View style={styles.cardMeta}>
        {averageRating > 0 ? (
          <View style={styles.ratingRow}>
            <StarRating rating={averageRating} color={theme.colors.primary} />
            <Text style={[styles.ratingText, { color: theme.colors.textSecondary }]}>
              {averageRating.toFixed(1)}
              {reviewCount > 0 ? ` (${formatCompactNumber(reviewCount)})` : ''}
            </Text>
          </View>
        ) : null}

        {subscriberCount > 0 ? (
          <View style={styles.subscriberRow}>
            <Ionicons name="people-outline" size={13} color={theme.colors.textSecondary} />
            <Text style={[styles.subscriberText, { color: theme.colors.textSecondary }]}>
              {formatCompactNumber(subscriberCount)}
            </Text>
          </View>
        ) : null}
      </View>

      {ownerName ? (
        <View style={styles.ownerRow}>
          <Avatar source={ownerAvatar} size={18} label={ownerName} />
          <Text style={[styles.ownerText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
            {ownerName}
          </Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
});

export default function FeedMarketplaceScreen() {
  const theme = useTheme();
  const { t } = useTranslation();

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

  // Load categories once on mount
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
        toast.error(t('marketplace.loadError', { defaultValue: 'Failed to load feeds' }));
      } finally {
        setLoading(false);
        setLoadingMore(false);
        setRefreshing(false);
      }
    },
    [activeCategory, sortBy, debouncedSearch, t],
  );

  // Re-fetch when filters change
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

      // Optimistic update
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
        // Revert on failure
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
        toast.error(t('marketplace.subscribeError', { defaultValue: 'Action failed' }));
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
      <FeedCard
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
        {/* Search bar */}
        {searchVisible && (
          <View style={[styles.searchBar, { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }]}>
            <Ionicons name="search" size={16} color={theme.colors.textSecondary} />
            <TextInput
              value={search}
              onChangeText={handleSearchChange}
              placeholder={t('marketplace.searchPlaceholder', { defaultValue: 'Search feeds...' })}
              placeholderTextColor={theme.colors.textSecondary}
              style={[styles.searchInput, { color: theme.colors.text }]}
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

        {/* Category pills */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.pillsContent}
          style={styles.pillsScroll}
        >
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
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.pillText,
                    { color: active ? '#fff' : theme.colors.text },
                  ]}
                >
                  {cat}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {/* Sort tabs */}
        <View style={[styles.sortRow, { borderBottomColor: theme.colors.border }]}>
          {SORT_OPTIONS.map((opt) => {
            const active = opt.id === sortBy;
            return (
              <TouchableOpacity
                key={opt.id}
                style={styles.sortTab}
                onPress={() => handleSortPress(opt.id)}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.sortTabText,
                    { color: active ? theme.colors.primary : theme.colors.textSecondary },
                    active && styles.sortTabTextActive,
                  ]}
                >
                  {opt.label}
                </Text>
                {active && (
                  <View style={[styles.sortIndicator, { backgroundColor: theme.colors.primary }]} />
                )}
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
      <View style={styles.emptyState}>
        <Ionicons name="telescope-outline" size={52} color={theme.colors.textSecondary} />
        <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>
          {t('marketplace.emptyTitle', { defaultValue: 'No feeds found' })}
        </Text>
        <Text style={[styles.emptySubtitle, { color: theme.colors.textSecondary }]}>
          {debouncedSearch
            ? t('marketplace.emptySearchSubtitle', { defaultValue: 'Try a different search term or category' })
            : t('marketplace.emptySubtitle', { defaultValue: 'Be the first to create a feed in this category' })}
        </Text>
      </View>
    );
  }, [loading, debouncedSearch, theme, t]);

  const ListFooter = useMemo(() => {
    if (!loadingMore) return <View style={{ height: 32 }} />;
    return (
      <View style={styles.footerLoader}>
        <ActivityIndicator size="small" color={theme.colors.primary} />
      </View>
    );
  }, [loadingMore, theme.colors.primary]);

  return (
    <ThemedView style={styles.container}>
      <Header
        options={{
          title: t('marketplace.title', { defaultValue: 'Feed Marketplace' }),
          headerTitleStyle: { justifyContent: 'flex-start', flex: 1 },
          leftComponents: [
            <IconButton variant="icon" key="back" onPress={() => router.back()}>
              <BackArrowIcon size={20} color={theme.colors.text} />
            </IconButton>,
          ],
          rightComponents: [
            <IconButton
              variant="icon"
              key="search"
              onPress={() => {
                setSearchVisible((v) => !v);
                if (searchVisible) handleSearchChange('');
              }}
            >
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
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
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
  container: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listContent: {
    paddingBottom: 32,
  },
  // Search bar
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    ...Platform.select({
      web: { outlineStyle: 'none' as any },
    }),
  },
  // Category pills
  pillsScroll: {
    marginTop: 12,
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
  pillText: {
    fontSize: 14,
    fontWeight: '500',
  },
  // Sort tabs
  sortRow: {
    flexDirection: 'row',
    marginTop: 12,
    borderBottomWidth: 1,
  },
  sortTab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    position: 'relative',
  },
  sortTabText: {
    fontSize: 14,
    fontWeight: '500',
  },
  sortTabTextActive: {
    fontWeight: '700',
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
  // Feed cards
  card: {
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 16,
    padding: 16,
    gap: 8,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  cardTitleArea: {
    flex: 1,
    gap: 5,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 20,
  },
  categoryBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  categoryBadgeText: {
    fontSize: 12,
    fontWeight: '600',
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
  subscribeBtnText: {
    fontSize: 13,
    fontWeight: '700',
  },
  cardDescription: {
    fontSize: 14,
    lineHeight: 20,
  },
  cardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  ratingText: {
    fontSize: 13,
  },
  subscriberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  subscriberText: {
    fontSize: 13,
  },
  ownerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  ownerText: {
    fontSize: 13,
  },
  // Empty state
  emptyState: {
    paddingTop: 60,
    paddingHorizontal: 40,
    alignItems: 'center',
    gap: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  // Footer loader
  footerLoader: {
    paddingVertical: 20,
    alignItems: 'center',
  },
});
