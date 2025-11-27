import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  TextInput,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { router } from 'expo-router';

import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import { FeedCard, type FeedCardData } from '@/components/FeedCard';
import SEO from '@/components/SEO';

import { getData, storeData } from '@/utils/storage';
import { customFeedsService } from '@/services/customFeedsService';
import { useTheme } from '@/hooks/useTheme';
import { Search } from '@/assets/icons/search-icon';

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

const MyFeedsRow = ({
  icon,
  label,
  onPress,
  chevron = false,
}: {
  icon: React.ReactNode;
  label: string;
  onPress?: () => void;
  chevron?: boolean;
}) => {
  const theme = useTheme();
  return (
    <TouchableOpacity
      style={[styles.myFeedRow, { borderBottomColor: theme.colors.border }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={[styles.myFeedIcon, { backgroundColor: theme.colors.primary }]}>
        {icon}
      </View>
      <ThemedText type="defaultSemiBold" style={styles.myFeedLabel}>
        {label}
      </ThemedText>
      {chevron && (
        <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
      )}
    </TouchableOpacity>
  );
};

const FeedCardWithPin = ({
  item,
  pinned,
  onTogglePin,
}: {
  item: FeedItem;
  pinned: boolean;
  onTogglePin: (id: string) => void;
}) => {
  const theme = useTheme();
  const feedData: FeedCardData = {
    id: String(item._id || item.id),
    uri: item.uri || `custom:${item._id || item.id}`,
    displayName: item.title || 'Untitled Feed',
    description: item.description,
    avatar: item.avatar,
    creator: item.owner
      ? {
          username: item.owner.username || item.owner.handle || '',
          displayName: item.owner.displayName,
          avatar: item.owner.avatar,
        }
      : undefined,
    subscriberCount: (item.memberOxyUserIds || []).length,
    likeCount: item.likeCount || 0,
  };

  const feedId = `custom:${item._id || item.id}`;

  return (
    <View style={[styles.feedCardWrapper]}>
      <FeedCard
        feed={feedData}
        onPress={() => router.push(`/feeds/${item._id || item.id}`)}
        headerRight={
          <TouchableOpacity
            onPress={() => onTogglePin(feedId)}
            style={[
              styles.pinBtn,
              {
                backgroundColor: theme.colors.primary,
              },
            ]}
          >
             <Ionicons
               name={pinned ? 'checkmark' : 'pin'}
               size={14}
               color={theme.colors.card}
             />
            <ThemedText
              style={[
                styles.pinBtnText,
                { color: theme.colors.card },
              ]}
            >
              {pinned ? 'Pinned' : 'Pin Feed'}
            </ThemedText>
          </TouchableOpacity>
        }
      />
    </View>
  );
};

const SectionHeader = ({
  icon,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
}) => {
  const theme = useTheme();
  return (
    <View style={styles.sectionHeaderRow}>
      <View style={[styles.sectionHeaderIcon, { backgroundColor: theme.colors.primary }]}>
        {icon}
      </View>
      <View style={{ flex: 1 }}>
        <ThemedText type="subtitle">{title}</ThemedText>
        {subtitle && (
          <ThemedText style={[styles.sectionSub, { color: theme.colors.textSecondary }]}>
            {subtitle}
          </ThemedText>
        )}
      </View>
    </View>
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

  const pinnedObjects = useMemo(() => {
    const customPinned = myFeeds.filter((f) =>
      pinned.includes(`custom:${f._id || f.id}`)
    );
    return customPinned.map((f) => ({
      id: `custom:${f._id || f.id}`,
      title: f.title,
      emoji: '🧩',
    }));
  }, [pinned, myFeeds]);

  return (
    <>
      <SEO title={t('seo.feeds.title')} description={t('seo.feeds.description')} />
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <Header
          options={{
            title: t('Feeds'),
            rightComponents: [
              <IconButton variant="icon" key="settings" onPress={() => router.push('/settings/feeds')}>
                <Ionicons name="settings-outline" size={24} color={theme.colors.text} />
              </IconButton>,
            ],
          }}
        />

        <ScrollView
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />
          }
          contentContainerStyle={{ paddingBottom: 80 }}
        >
          {/* My Feeds Section */}
          <SectionHeader
            icon={<Ionicons name="sparkles" size={18} color={theme.colors.card} />}
            title="My Feeds"
            subtitle="All the feeds you've saved, right in one place."
          />

          <View
            style={[
              styles.myFeedsBox,
              { backgroundColor: theme.colors.card, borderColor: theme.colors.border },
            ]}
          >
            <MyFeedsRow
              icon={<Ionicons name="swap-vertical" size={18} color={theme.colors.card} />}
              label="Following"
              onPress={() => router.push('/')}
            />
            <MyFeedsRow
              icon={<Ionicons name="people" size={18} color={theme.colors.card} />}
              label="Mutuals"
              onPress={() => router.push('/')}
              chevron
            />
            <MyFeedsRow
              icon={<Ionicons name="compass" size={18} color={theme.colors.card} />}
              label="Discover"
              onPress={() => router.push('/')}
              chevron
            />
            <MyFeedsRow
              icon={<Ionicons name="heart" size={18} color={theme.colors.card} />}
              label="Popular With Friends"
              onPress={() => router.push('/')}
              chevron
            />
            {pinnedObjects.map((f) => (
              <MyFeedsRow
                key={f.id}
                icon={<ThemedText style={{fontSize: 14}}>{f.emoji}</ThemedText>}
                label={f.title || 'Untitled'}
                onPress={() => {
                  const id = f.id.startsWith('custom:')
                    ? f.id.split(':')[1]
                    : undefined;
                  if (id) router.push(`/feeds/${id}`);
                }}
                chevron
              />
            ))}
          </View>

          {/* Discover New Feeds */}
          <View style={styles.spacer} />
          <SectionHeader
            icon={<Ionicons name="search" size={18} color={theme.colors.card} />}
            title="Discover New Feeds"
            subtitle="Choose your own timeline! Feeds built by the community."
          />

          <View style={[styles.searchContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
            <Search size={20} color={theme.colors.textSecondary} />
            <TextInput
              style={[styles.searchInput, { color: theme.colors.text }]}
              placeholder="Search feeds"
              placeholderTextColor={theme.colors.textSecondary}
              value={searchQuery}
              onChangeText={setSearchQuery}
            />
          </View>

          <View style={styles.listContainer}>
            {loading && !refreshing && publicFeeds.length === 0 ? (
              <ActivityIndicator size="large" color={theme.colors.primary} style={{ marginTop: 20 }} />
            ) : (
              publicFeeds.map((item) => (
                <FeedCardWithPin
                  key={String(item._id || item.id)}
                  item={item}
                  pinned={pinned.includes(`custom:${item._id || item.id}`)}
                  onTogglePin={onTogglePin}
                />
              ))
            )}
          </View>

          {/* Your Created Feeds */}
          {myFeeds.length > 0 && (
            <>
              <View style={styles.spacer} />
              <SectionHeader
                icon={<Ionicons name="person-circle" size={18} color={theme.colors.card} />}
                title="Your Feeds"
                subtitle="Custom timelines you created."
              />
              <View style={styles.listContainer}>
                {myFeeds.map((f) => (
                  <FeedCardWithPin
                    key={String(f._id || f.id)}
                    item={f}
                    pinned={pinned.includes(`custom:${f._id || f.id}`)}
                    onTogglePin={onTogglePin}
                  />
                ))}
              </View>
            </>
          )}
        </ScrollView>

        {/* FAB */}
        <TouchableOpacity
          style={[styles.fab, { backgroundColor: theme.colors.primary }]}
          onPress={() => router.push('/feeds/create')}
          activeOpacity={0.8}
        >
          <Ionicons name="pencil" size={24} color={theme.colors.card} />
        </TouchableOpacity>
      </SafeAreaView>
    </>
  );
};

const styles = StyleSheet.create({
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 12,
  },
  sectionHeaderIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  sectionSub: {
    fontSize: 13,
    marginTop: 2,
  },
  myFeedsBox: {
    marginHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  myFeedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  myFeedIcon: {
    width: 28,
    height: 28,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  myFeedLabel: {
    flex: 1,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginVertical: 8,
    paddingHorizontal: 12,
    height: 40,
    borderRadius: 8,
  },
  searchInput: {
    flex: 1,
    marginLeft: 8,
    fontSize: 16,
  },
  listContainer: {
    paddingHorizontal: 16,
    marginTop: 8,
  },
  feedCardWrapper: {
    marginBottom: 16,
  },
  pinBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  pinBtnText: {
    marginLeft: 6,
    fontSize: 12,
    fontWeight: '600',
  },
  spacer: {
    height: 8,
  },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    boxShadow: '0px 2px 4px 0px rgba(0, 0, 0, 0.25)',
  },
});

export default FeedsScreen;
