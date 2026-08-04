import React, { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services/ui/client';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
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
import { useTheme } from '@oxyhq/bloom/theme';
import { router } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { toast } from '@oxyhq/bloom/toast';
import { useTranslation } from 'react-i18next';
import Ionicons from '@expo/vector-icons/Ionicons';
import { labelerService, type LabelDefinition } from '@/services/labelerService';
import { cn } from '@/lib/utils';
import { logger } from '@oxyhq/core/logger';
import { HIT_SLOP_MD } from '@/styles/hitSlop';

const IS_WEB = Platform.OS === 'web';

/** How long typing settles before it becomes a new query key. */
const SEARCH_DEBOUNCE_MS = 300;

interface Labeler {
  _id: string;
  id?: string;
  name: string;
  description?: string;
  subscriberCount: number;
  labelDefinitions?: LabelDefinition[];
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
      className="rounded-2xl p-4 gap-2 bg-muted"
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
            <Loading className="text-primary" variant="inline" size="small" style={{ flex: undefined }} />
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

  const queryClient = useQueryClient();
  const { user, canUsePrivateApi } = useAuth();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // The typed query is debounced into the KEY, so each distinct search is its
  // own cache entry and returning to a previous one is instant. React Query
  // owns the request lifecycle, so there is no timer cancelling stale loads.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const queryKey = viewerQueryKeys.labelers(user?.id, debouncedSearch);

  const { data: labelers = [], isLoading, isFetching, refetch } = useQuery<Labeler[]>({
    queryKey,
    // `isSubscribed` is viewer-specific, so this is a private read and the key
    // carries the viewer — a session resolving after a cold boot re-keys and
    // refetches instead of keeping the anonymous answer.
    enabled: canUsePrivateApi,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await labelerService.list(debouncedSearch ? { search: debouncedSearch } : undefined);
      return res.items ?? [];
    },
  });

  const [subscribingIds, setSubscribingIds] = useState<Set<string>>(new Set());

  const subscription = useMutation<
    void,
    Error,
    { id: string; currentlySubscribed: boolean },
    { previous: Labeler[] | undefined }
  >({
    mutationFn: async ({ id, currentlySubscribed }) => {
      if (currentlySubscribed) {
        await labelerService.unsubscribe(id);
      } else {
        await labelerService.subscribe(id);
      }
    },
    onMutate: async ({ id, currentlySubscribed }) => {
      setSubscribingIds((prev) => new Set(prev).add(id));
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<Labeler[]>(queryKey);
      queryClient.setQueryData<Labeler[]>(queryKey, (current) =>
        (current ?? []).map((l) =>
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
      return { previous };
    },
    onSuccess: (_result, { currentlySubscribed }) => {
      toast(
        currentlySubscribed
          ? t('labelers.unsubscribed', { defaultValue: 'Unsubscribed' })
          : t('labelers.subscribed', { defaultValue: 'Subscribed' }),
        { type: 'success' },
      );
    },
    onError: (error, _variables, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData<Labeler[]>(queryKey, context.previous);
      }
      logger.warn('Subscribe toggle failed', { error });
      toast(t('labelers.subscribeError', { defaultValue: 'Action failed' }), { type: 'error' });
    },
    onSettled: (_result, _error, { id }) => {
      setSubscribingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const { mutate: toggleSubscription } = subscription;
  const handleSubscribeToggle = useCallback(
    (id: string, currentlySubscribed: boolean) => {
      toggleSubscription({ id, currentlySubscribed });
    },
    [toggleSubscription],
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

      <View className="flex-row items-center gap-2 mx-4 mt-2 mb-1 rounded-xl border border-border px-3 py-2.5 bg-muted">
        <Ionicons name="search" size={16} color={theme.colors.textSecondary} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder={t('labelers.searchPlaceholder', { defaultValue: 'Search labelers\u2026' })}
          placeholderTextColor={theme.colors.textSecondary}
          className="flex-1 text-[15px] text-foreground"
          style={styles.searchInput}
          returnKeyType="search"
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch('')} hitSlop={HIT_SLOP_MD}>
            <Ionicons name="close-circle" size={16} color={theme.colors.textSecondary} />
          </TouchableOpacity>
        )}
      </View>

      {isLoading ? (
        <View className="flex-1 justify-center items-center">
          <Loading className="text-primary" size="large" />
        </View>
      ) : IS_WEB ? (
        // WEB: the document (body) is the scroller — the shell owns scroll, so
        // the list renders in normal flow. A FlatList here would nest a second
        // scroll container inside the ContentPanel and break the sticky side
        // rails, window scroll-restoration and bottom-bar auto-hide. The `gap-2`
        // reproduces the native ItemSeparatorComponent spacing.
        <View className="p-4 pt-2 gap-2">
          {labelers.length === 0
            ? ListEmpty()
            : labelers.map((item) => (
                <LabelerCard
                  key={keyExtractor(item)}
                  labeler={item}
                  onSubscribeToggle={handleSubscribeToggle}
                  subscribing={subscribingIds.has(String(item._id || item.id))}
                />
              ))}
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
              refreshing={isFetching}
              onRefresh={refetch}
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
      web: { outlineWidth: 0 },
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
