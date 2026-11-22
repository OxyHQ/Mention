import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { useDebouncedValue } from '@oxy.so/bloom/hooks';
import React, { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { StyleSheet, TouchableOpacity, RefreshControl, type ViewStyle } from 'react-native';
import { ScreenScrollView } from '@oxy.so/bloom/screen';
import { RiShieldCheckLine } from '@oxy.so/bloom/icons/RiShieldCheckLine';
import { useColorTokens, useTheme } from '@oxy.so/bloom/theme';
import { useRouter } from '@/lib/navigation/router';
import { toast } from '@oxy.so/bloom/toast';
import { useTranslation } from 'react-i18next';
import { labelerService, type LabelDefinition } from '@/services/labelerService';
import { logger } from '@oxy.so/core/logger';
import { EmptyState } from '@/components/common/EmptyState';

import {
  Embed,
  HStack,
  Header,
  Icon,
  Loading,
  RawText,
  Search as LSearch,
  VStack,
  defineTokens,
  toElement,
} from '@oxy.so/bloom-language';
import { screen } from '@oxy.so/bloom-language/router';
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

/** The "Official" badge: a shield and the word, white on the primary fill (rounded on the web only, as the app's `rounded-md` drew it). */
function officialBadge(label: string) {
  return HStack(
    Icon(RiShieldCheckLine).size('10').foreground(appColors.color.hexfff),
    RawText(label).foreground('white').font('2xs').weight('bold'),
  )
    .padding('horizontal', '6')
    .padding('vertical', '2xs')
    .background('primary')
    .when('web', (v) => v.corner('14'))
    .align('center')
    .spacing('3');
}

/** The card's box, as its classes drew it; its fill is the muted token. */
const CARD_STYLE: ViewStyle = { borderRadius: 16, padding: 16, gap: 8 };

const LabelerCard = React.memo(({ labeler, onSubscribeToggle, subscribing }: LabelerCardProps) => {
  const router = useRouter();
  const theme = useTheme();
  const colorTokens = useColorTokens();
  const { t } = useTranslation();

  const id = String(labeler._id || labeler.id);
  const labelCount = labeler.labelDefinitions?.length ?? 0;

  return toElement(
    Embed((render) => (
      <TouchableOpacity
        style={[CARD_STYLE, { backgroundColor: colorTokens.muted }]}
        onPress={() => router.push(`/moderation/labelers/${id}`)}
        activeOpacity={0.7}
      >
        {render(
          HStack(
            HStack(
              RawText(labeler.name)
                .font('16')
                .leading('normal')
                .weight('bold')
                .foreground('foreground')
                .lines(1),
              labeler.isOfficial
                ? officialBadge(t('labelers.official', { defaultValue: 'Official' }))
                : null,
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
                {render(
                  subscribing
                    ? Loading().style('inline').size('sm')
                    : RawText(
                        labeler.isSubscribed
                          ? t('labelers.unsubscribe', { defaultValue: 'Unsubscribe' })
                          : t('labelers.subscribe', { defaultValue: 'Subscribe' }),
                      )
                        .font('sm')
                        .weight('semibold')
                        .foreground(labeler.isSubscribed ? 'foreground' : 'white'),
                )}
              </TouchableOpacity>,
            ),
          )
            .align('start')
            .justify('between')
            .spacing('md'),
        )}
        {labeler.description
          ? render(
              RawText(labeler.description).font('14').leading('20px').foreground('muted').lines(2),
            )
          : null}
        {render(
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
    )),
  );
});

LabelerCard.displayName = 'LabelerCard';

export default screen(function LabelersScreen() {
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

  // The pull's spinner is tinted on iOS only (`tintColor`), so the scroller stays Bloom's.
  return Embed(
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
        toElement(
          VStack(
            labelers.map((item) => {
              const id = String(item._id || item.id);
              return Embed(
                <LabelerCard
                  labeler={item}
                  onSubscribeToggle={handleSubscribeToggle}
                  subscribing={subscribingIds.has(id)}
                />,
              ).id(id);
            }),
          )
            .padding('horizontal', 'lg')
            .padding('top', 'sm')
            .padding('bottom', 'lg')
            .spacing('sm'),
        )
      )}
    </ScreenScrollView>,
  ).header(
    Header(t('labelers.title', { defaultValue: 'Content Labels' }))
      .backLabel(t('common.back', { defaultValue: 'Back' }))
      .inPage(),
  );
});

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
