import React, { useEffect, useMemo, useState, useCallback } from 'react';
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
import { Loading } from '@/components/ui/Loading';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { router } from 'expo-router';

import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { ThemedView } from '@/components/ThemedView';
import Avatar from '@/components/Avatar';
import SEO from '@/components/SEO';

import { getData, storeData } from '@/utils/storage';
import { customFeedsService } from '@/services/customFeedsService';
import { useTheme } from '@/hooks/useTheme';
import { Search } from '@/assets/icons/search-icon';
import { formatCompactNumber } from '@/utils/formatNumber';

const PINNED_KEY = 'mention.pinnedFeeds';

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

// Simple row for quick-access feeds
const QuickFeedRow = ({
  icon,
  iconColor,
  label,
  onPress,
}: {
  icon: string;
  iconColor: string;
  label: string;
  onPress?: () => void;
}) => {
  const theme = useTheme();
  return (
    <TouchableOpacity
      style={[styles.quickRow, { borderBottomColor: theme.colors.border }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Ionicons name={icon as any} size={20} color={iconColor} />
      <Text style={[styles.quickRowLabel, { color: theme.colors.text }]}>{label}</Text>
      <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />
    </TouchableOpacity>
  );
};

// Compact feed card row
const FeedRow = ({
  item,
  pinned,
  onTogglePin,
  t,
}: {
  item: FeedItem;
  pinned: boolean;
  onTogglePin: (id: string) => void;
  t: (key: string) => string;
}) => {
  const theme = useTheme();
  const feedId = `custom:${item._id || item.id}`;
  const memberCount = (item.memberOxyUserIds || []).length;

  return (
    <TouchableOpacity
      style={[styles.feedRow, { borderBottomColor: theme.colors.border }]}
      onPress={() => router.push(`/feeds/${item._id || item.id}`)}
      activeOpacity={0.7}
    >
      <Avatar source={item.avatar || undefined} size={36} />
      <View style={styles.feedRowMeta}>
        <Text style={[styles.feedRowTitle, { color: theme.colors.text }]} numberOfLines={1}>
          {item.title || 'Untitled Feed'}
        </Text>
        <Text style={[styles.feedRowSub, { color: theme.colors.textSecondary }]} numberOfLines={1}>
          {item.owner ? `@${item.owner.username || item.owner.handle}` : ''}
          {memberCount > 0 ? ` · ${formatCompactNumber(memberCount)} members` : ''}
          {(item.likeCount || 0) > 0 ? ` · ${formatCompactNumber(item.likeCount!)} likes` : ''}
        </Text>
        {item.description ? (
          <Text style={[styles.feedRowDesc, { color: theme.colors.textSecondary }]} numberOfLines={2}>
            {item.description}
          </Text>
        ) : null}
      </View>
      <TouchableOpacity
        onPress={() => onTogglePin(feedId)}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        style={[
          styles.pinBtn,
          pinned
            ? { backgroundColor: theme.colors.backgroundSecondary }
            : { backgroundColor: theme.colors.primary },
        ]}
      >
        <Ionicons
          name={pinned ? 'checkmark' : 'add'}
          size={14}
          color={pinned ? theme.colors.text : '#fff'}
        />
      </TouchableOpacity>
    </TouchableOpacity>
  );
};

const FeedsScreen: React.FC = () => {
  const { t } = useTranslation();
  const theme = useTheme();
  const [pinned, setPinned] = useState<string[]>([]);
  const [myFeeds, setMyFeeds] = useState<FeedItem[]>([]);
  const [publicFeeds, setPublicFeeds] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const loadFeeds = useCallback(async () => {
    try {
      setLoading(true);
      const [mine, pub, storedPinned] = await Promise.all([
        customFeedsService.list({ mine: true }),
        customFeedsService.list({ publicOnly: true }),
        getData<string[]>(PINNED_KEY),
      ]);

      setPinned(storedPinned || []);
      setMyFeeds(mine.items || []);

      const mineIds = new Set((mine.items || []).map((f: any) => String(f._id || f.id)));
      setPublicFeeds(
        (pub.items || []).filter((f: any) => !mineIds.has(String(f._id || f.id)))
      );
    } catch (e) {
      console.warn('Failed loading feeds', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadFeeds();
  }, [loadFeeds]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadFeeds();
  }, [loadFeeds]);

  const onTogglePin = useCallback(async (id: string) => {
    setPinned((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      storeData(PINNED_KEY, next).catch(() => {});
      return next;
    });
  }, []);

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

  return (
    <>
      <SEO title={t('seo.feeds.title')} description={t('seo.feeds.description')} />
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <Header
          options={{
            title: t('Feeds'),
            rightComponents: [
              <IconButton variant="icon" key="settings" onPress={() => router.push('/settings/feeds')}>
                <Ionicons name="settings-outline" size={22} color={theme.colors.text} />
              </IconButton>,
            ],
          }}
          hideBottomBorder
        />

        <ScrollView
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />
          }
          contentContainerStyle={styles.scrollContent}
        >
          {/* Quick access feeds */}
          <QuickFeedRow icon="swap-vertical" iconColor={theme.colors.primary} label={t('feeds.following')} onPress={() => router.push('/')} />
          <QuickFeedRow icon="people" iconColor={theme.colors.primary} label={t('feeds.mutuals')} onPress={() => router.push('/')} />
          <QuickFeedRow icon="compass" iconColor="#10B981" label={t('feeds.discover')} onPress={() => router.push('/')} />
          <QuickFeedRow icon="heart" iconColor="#FF3040" label={t('feeds.popularWithFriends')} onPress={() => router.push('/')} />

          {/* Pinned custom feeds in quick list */}
          {myFeeds
            .filter((f) => pinned.includes(`custom:${f._id || f.id}`))
            .map((f) => (
              <QuickFeedRow
                key={f._id || f.id}
                icon="pin"
                iconColor={theme.colors.primary}
                label={f.title || 'Untitled'}
                onPress={() => router.push(`/feeds/${f._id || f.id}`)}
              />
            ))}

          {/* Discover feeds */}
          <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
            {t('feeds.discoverNew.title')}
          </Text>

          <View style={[styles.searchBar, { backgroundColor: theme.colors.backgroundSecondary }]}>
            <Search size={18} color={theme.colors.textSecondary} />
            <TextInput
              style={[styles.searchInput, { color: theme.colors.text }]}
              placeholder={t('feeds.searchPlaceholder')}
              placeholderTextColor={theme.colors.textSecondary}
              value={searchQuery}
              onChangeText={setSearchQuery}
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close-circle" size={18} color={theme.colors.textSecondary} />
              </TouchableOpacity>
            )}
          </View>

          {loading && !refreshing && publicFeeds.length === 0 ? (
            <Loading size="large" style={{ flex: undefined, marginTop: 24 }} />
          ) : (
            filteredPublic.map((item) => (
              <FeedRow
                key={String(item._id || item.id)}
                item={item}
                pinned={pinned.includes(`custom:${item._id || item.id}`)}
                onTogglePin={onTogglePin}
                t={t}
              />
            ))
          )}

          {/* Your feeds */}
          {myFeeds.length > 0 && (
            <>
              <Text style={[styles.sectionTitle, styles.sectionTitleSpaced, { color: theme.colors.text }]}>
                {t('feeds.yourFeeds.title')}
              </Text>
              {myFeeds.map((f) => (
                <FeedRow
                  key={String(f._id || f.id)}
                  item={f}
                  pinned={pinned.includes(`custom:${f._id || f.id}`)}
                  onTogglePin={onTogglePin}
                  t={t}
                />
              ))}
            </>
          )}

          <View style={{ height: 80 }} />
        </ScrollView>

        {/* FAB */}
        <TouchableOpacity
          style={[styles.fab, { backgroundColor: theme.colors.primary }]}
          onPress={() => router.push('/feeds/create')}
          activeOpacity={0.8}
        >
          <Ionicons name="add" size={28} color="#fff" />
        </TouchableOpacity>
      </SafeAreaView>
    </>
  );
};

const styles = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: 16,
  },
  // Quick access rows
  quickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 14,
  },
  quickRowLabel: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
  },
  // Section
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    marginTop: 24,
    marginBottom: 4,
  },
  sectionTitleSpaced: {
    marginTop: 28,
  },
  // Search
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    height: 38,
    borderRadius: 10,
    marginTop: 8,
    marginBottom: 4,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    ...Platform.select({
      web: { outlineStyle: 'none' as any },
    }),
  },
  // Feed rows
  feedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  feedRowMeta: {
    flex: 1,
    gap: 2,
  },
  feedRowTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  feedRowSub: {
    fontSize: 13,
  },
  feedRowDesc: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
  },
  pinBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // FAB
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    ...Platform.select({
      web: { boxShadow: '0 2px 8px rgba(0,0,0,0.15)' },
      default: {},
    }),
  },
});

export default FeedsScreen;
