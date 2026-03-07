import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Platform,
  RefreshControl,
} from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Loading } from '@/components/ui/Loading';
import { useTheme } from '@/hooks/useTheme';
import { router } from 'expo-router';
import { toast } from '@/lib/sonner';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { labelerService } from '@/services/labelerService';

interface Labeler {
  _id: string;
  id?: string;
  name: string;
  description?: string;
  subscriberCount: number;
  labelDefinitions?: any[];
  isOfficial?: boolean;
  isSubscribed?: boolean;
}

interface LabelerCardProps {
  labeler: Labeler;
  onSubscribeToggle: (id: string, currentlySubscribed: boolean) => void;
  subscribing: boolean;
}

const LabelerCard = React.memo(({ labeler, onSubscribeToggle, subscribing }: LabelerCardProps) => {
  const theme = useTheme();
  const { t } = useTranslation();

  const id = String(labeler._id || labeler.id);
  const labelCount = labeler.labelDefinitions?.length ?? 0;

  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: theme.colors.backgroundSecondary }]}
      onPress={() => router.push(`/moderation/labelers/${id}`)}
      activeOpacity={0.7}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleRow}>
          <Text style={[styles.cardName, { color: theme.colors.text }]} numberOfLines={1}>
            {labeler.name}
          </Text>
          {labeler.isOfficial && (
            <View style={[styles.officialBadge, { backgroundColor: theme.colors.primary }]}>
              <Ionicons name="shield-checkmark" size={10} color="#fff" />
              <Text style={styles.officialBadgeText}>
                {t('labelers.official', { defaultValue: 'Official' })}
              </Text>
            </View>
          )}
        </View>

        <TouchableOpacity
          style={[
            styles.subscribeBtn,
            labeler.isSubscribed
              ? { borderColor: theme.colors.border, backgroundColor: 'transparent' }
              : { backgroundColor: theme.colors.primary },
          ]}
          onPress={() => onSubscribeToggle(id, !!labeler.isSubscribed)}
          disabled={subscribing}
          activeOpacity={0.7}
        >
          {subscribing ? (
            <Loading variant="inline" size="small" style={{ flex: undefined }} />
          ) : (
            <Text
              style={[
                styles.subscribeBtnText,
                labeler.isSubscribed
                  ? { color: theme.colors.text }
                  : { color: '#fff' },
              ]}
            >
              {labeler.isSubscribed
                ? t('labelers.unsubscribe', { defaultValue: 'Unsubscribe' })
                : t('labelers.subscribe', { defaultValue: 'Subscribe' })}
            </Text>
          )}
        </TouchableOpacity>
      </View>

      {!!labeler.description && (
        <Text
          style={[styles.cardDescription, { color: theme.colors.textSecondary }]}
          numberOfLines={2}
        >
          {labeler.description}
        </Text>
      )}

      <View style={styles.cardMeta}>
        <Text style={[styles.cardMetaText, { color: theme.colors.textSecondary }]}>
          {t('labelers.subscriberCount', {
            count: labeler.subscriberCount,
            defaultValue: '{{count}} subscribers',
          })}
        </Text>
        <Text style={[styles.cardMetaDot, { color: theme.colors.textSecondary }]}>{'\u00B7'}</Text>
        <Text style={[styles.cardMetaText, { color: theme.colors.textSecondary }]}>
          {t('labelers.labelCount', {
            count: labelCount,
            defaultValue: '{{count}} labels',
          })}
        </Text>
      </View>
    </TouchableOpacity>
  );
});

LabelerCard.displayName = 'LabelerCard';

const LabelersScreen: React.FC = () => {
  const theme = useTheme();
  const { t } = useTranslation();

  const [labelers, setLabelers] = useState<Labeler[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [subscribingIds, setSubscribingIds] = useState<Set<string>>(new Set());

  const loadLabelers = useCallback(async (searchQuery?: string) => {
    try {
      const res = await labelerService.list(searchQuery ? { search: searchQuery } : undefined);
      setLabelers(res.items ?? []);
    } catch (e) {
      console.warn('Failed to load labelers', e);
      toast.error(t('labelers.loadError', { defaultValue: 'Failed to load labelers' }));
    }
  }, [t]);

  useEffect(() => {
    loadLabelers().finally(() => setLoading(false));
  }, [loadLabelers]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadLabelers(search);
    setRefreshing(false);
  }, [loadLabelers, search]);

  const searchTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSearch = useCallback(
    (q: string) => {
      setSearch(q);
      if (searchTimer.current) clearTimeout(searchTimer.current);
      searchTimer.current = setTimeout(() => {
        loadLabelers(q.trim() || undefined);
      }, 300);
    },
    [loadLabelers],
  );

  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);

  const handleSubscribeToggle = useCallback(
    async (id: string, currentlySubscribed: boolean) => {
      setSubscribingIds((prev) => new Set(prev).add(id));

      // Optimistic update
      setLabelers((prev) =>
        prev.map((l) =>
          String(l._id || l.id) === id
            ? {
                ...l,
                isSubscribed: !currentlySubscribed,
                subscriberCount: currentlySubscribed
                  ? l.subscriberCount - 1
                  : l.subscriberCount + 1,
              }
            : l,
        ),
      );

      try {
        if (currentlySubscribed) {
          await labelerService.unsubscribe(id);
          toast.success(t('labelers.unsubscribed', { defaultValue: 'Unsubscribed' }));
        } else {
          await labelerService.subscribe(id);
          toast.success(t('labelers.subscribed', { defaultValue: 'Subscribed' }));
        }
      } catch (e) {
        console.warn('Subscribe toggle failed', e);
        // Revert optimistic update
        setLabelers((prev) =>
          prev.map((l) =>
            String(l._id || l.id) === id
              ? {
                  ...l,
                  isSubscribed: currentlySubscribed,
                  subscriberCount: currentlySubscribed
                    ? l.subscriberCount + 1
                    : l.subscriberCount - 1,
                }
              : l,
          ),
        );
        toast.error(t('labelers.subscribeError', { defaultValue: 'Action failed' }));
      } finally {
        setSubscribingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [t],
  );

  const renderItem = useCallback(
    ({ item }: { item: Labeler }) => (
      <LabelerCard
        labeler={item}
        onSubscribeToggle={handleSubscribeToggle}
        subscribing={subscribingIds.has(String(item._id || item.id))}
      />
    ),
    [handleSubscribeToggle, subscribingIds],
  );

  const keyExtractor = useCallback(
    (item: Labeler) => String(item._id || item.id),
    [],
  );

  const ListEmpty = useCallback(
    () => (
      <View style={styles.emptyState}>
        <Ionicons name="shield-outline" size={48} color={theme.colors.textSecondary} />
        <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>
          {t('labelers.emptyTitle', { defaultValue: 'No labelers found' })}
        </Text>
        <Text style={[styles.emptySubtitle, { color: theme.colors.textSecondary }]}>
          {t('labelers.emptySubtitle', {
            defaultValue: 'Try adjusting your search or check back later.',
          })}
        </Text>
      </View>
    ),
    [theme, t],
  );

  return (
    <ThemedView style={styles.container}>
      <Header
        options={{
          title: t('labelers.title', { defaultValue: 'Content Labels' }),
          leftComponents: [
            <IconButton variant="icon" key="back" onPress={() => router.back()}>
              <BackArrowIcon size={20} color={theme.colors.text} />
            </IconButton>,
          ],
        }}
        hideBottomBorder
        disableSticky
      />

      <View
        style={[
          styles.searchBar,
          { backgroundColor: theme.colors.backgroundSecondary, borderColor: theme.colors.border },
        ]}
      >
        <Ionicons name="search" size={16} color={theme.colors.textSecondary} />
        <TextInput
          value={search}
          onChangeText={handleSearch}
          placeholder={t('labelers.searchPlaceholder', { defaultValue: 'Search labelers…' })}
          placeholderTextColor={theme.colors.textSecondary}
          style={[styles.searchInput, { color: theme.colors.text }]}
          returnKeyType="search"
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => handleSearch('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close-circle" size={16} color={theme.colors.textSecondary} />
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View style={styles.loadingContainer}>
          <Loading size="large" />
        </View>
      ) : (
        <FlatList
          data={labelers}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={ListEmpty}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={theme.colors.primary}
            />
          }
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        />
      )}
    </ThemedView>
  );
};

export default LabelersScreen;

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    ...Platform.select({
      web: { outlineStyle: 'none' as any },
    }),
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  listContent: {
    padding: 16,
    paddingTop: 8,
  },
  // Card
  card: {
    borderRadius: 16,
    padding: 16,
    gap: 8,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  cardTitleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  cardName: {
    fontSize: 16,
    fontWeight: '700',
  },
  officialBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  officialBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  subscribeBtn: {
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 6,
    minWidth: 90,
    alignItems: 'center',
    justifyContent: 'center',
  },
  subscribeBtnText: {
    fontSize: 13,
    fontWeight: '600',
  },
  cardDescription: {
    fontSize: 14,
    lineHeight: 20,
  },
  cardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  cardMetaText: {
    fontSize: 13,
  },
  cardMetaDot: {
    fontSize: 13,
  },
  // Empty state
  emptyState: {
    alignItems: 'center',
    paddingTop: 60,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  emptySubtitle: {
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
});
