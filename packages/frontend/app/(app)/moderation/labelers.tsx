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
import { Loading } from '@oxyhq/bloom/loading';
import { useTheme } from '@/hooks/useTheme';
import { router } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { toast } from '@/lib/sonner';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { labelerService } from '@/services/labelerService';
import { cn } from '@/lib/utils';

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
      className="rounded-2xl p-4 gap-2 bg-secondary"
      onPress={() => router.push(`/moderation/labelers/${id}`)}
      activeOpacity={0.7}
    >
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 flex-row items-center gap-2 flex-wrap">
          <Text className="text-base font-bold text-foreground" numberOfLines={1}>
            {labeler.name}
          </Text>
          {labeler.isOfficial && (
            <View className="flex-row items-center gap-[3px] px-1.5 py-0.5 rounded-md bg-primary">
              <Ionicons name="shield-checkmark" size={10} color="#fff" />
              <Text className="text-white text-[10px] font-bold">
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
              className={cn(
                "text-[13px] font-semibold",
                labeler.isSubscribed ? "text-foreground" : "text-white"
              )}
            >
              {labeler.isSubscribed
                ? t('labelers.unsubscribe', { defaultValue: 'Unsubscribe' })
                : t('labelers.subscribe', { defaultValue: 'Subscribe' })}
            </Text>
          )}
        </TouchableOpacity>
      </View>

      {!!labeler.description && (
        <Text className="text-sm leading-5 text-muted-foreground" numberOfLines={2}>
          {labeler.description}
        </Text>
      )}

      <View className="flex-row items-center gap-1.5">
        <Text className="text-[13px] text-muted-foreground">
          {t('labelers.subscriberCount', {
            count: labeler.subscriberCount,
            defaultValue: '{{count}} subscribers',
          })}
        </Text>
        <Text className="text-[13px] text-muted-foreground">{'\u00B7'}</Text>
        <Text className="text-[13px] text-muted-foreground">
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
  const safeBack = useSafeBack();

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
      <View className="items-center pt-[60px] gap-3">
        <Ionicons name="shield-outline" size={48} color={theme.colors.textSecondary} />
        <Text className="text-[17px] font-semibold text-foreground">
          {t('labelers.emptyTitle', { defaultValue: 'No labelers found' })}
        </Text>
        <Text className="text-sm text-center px-8 text-muted-foreground">
          {t('labelers.emptySubtitle', {
            defaultValue: 'Try adjusting your search or check back later.',
          })}
        </Text>
      </View>
    ),
    [theme, t],
  );

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('labelers.title', { defaultValue: 'Content Labels' }),
          leftComponents: [
            <IconButton variant="icon" key="back" onPress={() => safeBack()}>
              <BackArrowIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
        }}
        hideBottomBorder
        disableSticky
      />

      <View className="flex-row items-center gap-2 mx-4 mt-2 mb-1 rounded-xl border border-border px-3 py-2.5 bg-secondary">
        <Ionicons name="search" size={16} color={theme.colors.textSecondary} />
        <TextInput
          value={search}
          onChangeText={handleSearch}
          placeholder={t('labelers.searchPlaceholder', { defaultValue: 'Search labelers\u2026' })}
          placeholderTextColor={theme.colors.textSecondary}
          className="flex-1 text-[15px] text-foreground"
          style={styles.searchInput}
          returnKeyType="search"
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => handleSearch('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close-circle" size={16} color={theme.colors.textSecondary} />
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View className="flex-1 justify-center items-center">
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
          ItemSeparatorComponent={() => <View className="h-2" />}
        />
      )}
    </ThemedView>
  );
};

export default LabelersScreen;

const styles = StyleSheet.create({
  searchInput: {
    ...Platform.select({
      web: { outlineStyle: 'none' as any },
    }),
  },
  listContent: {
    padding: 16,
    paddingTop: 8,
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
});
