import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { useDebouncedValue } from '@oxy.so/bloom/hooks';
import React, { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { View, Text, StyleSheet, TouchableOpacity, RefreshControl } from 'react-native';
import { Loading } from '@oxy.so/bloom/loading';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { RiShieldCheckLine } from '@oxy.so/bloom/icons/RiShieldCheckLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { useRouter } from '@/lib/navigation/router';
import { toast } from '@oxy.so/bloom/toast';
import { useTranslation } from 'react-i18next';
import { labelerService, type LabelDefinition } from '@/services/labelerService';
import { cn } from '@/lib/utils';
import { logger } from '@oxy.so/core/logger';
import { EmptyState } from '@/components/common/EmptyState';

import {
  Embed,
  HStack,
  Header,
  Icon,
  RawText,
  Search as LSearch,
  VStack,
  defineTokens,
  toElement,
} from '@oxy.so/bloom-language';
const appColors = defineTokens({ color: { hexfff: '#fff' } });

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
  const router = useRouter();
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
      {toElement(
        HStack(
          HStack(
            RawText(labeler.name)
              .font('16')
              .leading('normal')
              .weight('bold')
              .foreground('foreground')
              .lines(1),
            Embed(
              labeler.isOfficial && (
                <View className="flex-row items-center gap-[3px] px-1.5 py-0.5 rounded-md bg-primary">
                  {toElement(Icon(RiShieldCheckLine).size('10').foreground(appColors.color.hexfff))}
                  {toElement(
                    RawText(t('labelers.official', { defaultValue: 'Official' }))
                      .foreground('white')
                      .font('2xs')
                      .weight('bold'),
                  )}
                </View>
              ),
            ),
          )
            .flex('1')
            .align('center')
            .spacing('sm')
            .wrap(),
          Embed(
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
                <Loading
                  className="text-primary"
                  variant="inline"
                  size="sm"
                  style={{ flex: undefined }}
                />
              ) : (
                <Text
                  className={cn(
                    'text-[13px] font-semibold',
                    labeler.isSubscribed ? 'text-foreground' : 'text-white',
                  )}
                >
                  {labeler.isSubscribed
                    ? t('labelers.unsubscribe', { defaultValue: 'Unsubscribe' })
                    : t('labelers.subscribe', { defaultValue: 'Subscribe' })}
                </Text>
              )}
            </TouchableOpacity>,
          ),
        )
          .align('start')
          .justify('between')
          .spacing('md'),
      )}
      {!!labeler.description &&
        toElement(
          RawText(labeler.description).font('14').leading('20px').foreground('muted').lines(2),
        )}
      {toElement(
        HStack(
          RawText(
            t('labelers.subscriberCount', {
              count: labeler.subscriberCount,
              defaultValue: '{{count}} subscribers',
            }),
          )
            .font('sm')
            .foreground('muted'),
          RawText('·').font('sm').foreground('muted'),
          RawText(
            t('labelers.labelCount', {
              count: labelCount,
              defaultValue: '{{count}} labels',
            }),
          )
            .font('sm')
            .foreground('muted'),
        )
          .align('center')
          .spacing('6'),
      )}
    </TouchableOpacity>
  );
});

LabelerCard.displayName = 'LabelerCard';

const LabelersScreen: React.FC = () => {
  const theme = useTheme();
  const { t } = useTranslation();

  const queryClient = useQueryClient();
  const { user, canUsePrivateApi } = useAuth();
  const [search, setSearch] = useState('');

  // The typed query is debounced into the KEY, so each distinct search is its
  // own cache entry and returning to a previous one is instant. React Query
  // owns the request lifecycle, so there is no timer cancelling stale loads.
  const debouncedSearch = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS);

  const queryKey = viewerQueryKeys.labelers(user?.id, debouncedSearch);

  const {
    data: labelers = [],
    isLoading,
    isFetching,
    refetch,
  } = useQuery<Labeler[]>({
    queryKey,
    // `isSubscribed` is viewer-specific, so this is a private read and the key
    // carries the viewer — a session resolving after a cold boot re-keys and
    // refetches instead of keeping the anonymous answer.
    enabled: canUsePrivateApi,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await labelerService.list(
        debouncedSearch ? { search: debouncedSearch } : undefined,
      );
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

  return (
    <Screen
      header={toElement(
        Header(t('labelers.title', { defaultValue: 'Content Labels' }))
          .backLabel(t('common.back', { defaultValue: 'Back' }))
          .inPage(),
      )}
    >
      <ScreenScrollView
        refreshControl={
          <RefreshControl
            refreshing={isFetching}
            onRefresh={() => {
              void refetch();
            }}
            tintColor={theme.colors.primary}
          />
        }
      >
        {toElement(
          VStack(
            LSearch([search, setSearch])
              .label(t('labelers.searchPlaceholder', { defaultValue: 'Search labelers\u2026' }))
              .onClearText(() => setSearch('')),
          )
            .margin('horizontal', 'lg')
            .margin('top', 'sm')
            .margin('bottom', 'xs'),
        )}

        {isLoading ? (
          <ListSkeleton />
        ) : labelers.length === 0 ? (
          <EmptyState
            sticker="labelers"
            title={t('labelers.emptyTitle', { defaultValue: 'No labelers found' })}
            subtitle={t('labelers.emptySubtitle', {
              defaultValue: 'Try adjusting your search or check back later.',
            })}
            containerStyle={{ paddingTop: 60 }}
          />
        ) : (
          <View className="p-4 pt-2 gap-2">
            {labelers.map((item) => {
              const id = String(item._id || item.id);
              return (
                <LabelerCard
                  key={id}
                  labeler={item}
                  onSubscribeToggle={handleSubscribeToggle}
                  subscribing={subscribingIds.has(id)}
                />
              );
            })}
          </View>
        )}
      </ScreenScrollView>
    </Screen>
  );
};

export default LabelersScreen;

const styles = StyleSheet.create({
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
