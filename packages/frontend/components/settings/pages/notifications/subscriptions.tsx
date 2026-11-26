import { ListSkeleton } from '@/components/loading/ContentSkeleton';
/**
 * Activity notification subscriptions — the accounts the viewer asked to be
 * notified about ("notify me when this account posts").
 *
 * Portions adapted from bluesky-social/social-app, MIT © 2023–2026 Bluesky
 * Social PBC (`ActivityNotificationSettings.tsx`, commit 92ec563f9): the screen's
 * layout — an explanatory settings header above the list, the empty state that
 * teaches the bell affordance instead of just saying "nothing here", and the
 * per-row toggle — is theirs. The primitives are Mention's (Bloom
 * `GroupedSection`/`GroupedSectionItem`, `ProfileCard`, `useTranslation`, React Query).
 */

import type { PostSubscriptionItem, PostSubscriptionListResponse } from '@mention/shared-types';
import { toast } from '@oxy.so/bloom/toast';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { nextUnvisitedCursor } from '@oxy.so/utils/paging';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { currentAccountId, subscribeAccount } from '@/lib/accountScope';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/common/EmptyState';
import { Error as ErrorComponent } from '@/components/Error';
import { ProfileCard, ProfileCardSkeletonList } from '@/components/ProfileCard';
import { SEO } from '@/components/SEO';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { subscriptionService } from '@/services/subscriptionService';
import { notifyFeedRankingChanged } from '@/stores/feedRankingInvalidation';
import { normalizeApiError } from '@/utils/apiError';
import { RiNotification3Fill } from '@oxy.so/bloom/icons/RiNotification3Fill';

import {
  Button as LButton,
  Embed,
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
  Icon,
  SettingsSection as LSettingsSection,
  Text,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

const PAGE_LIMIT = 50;
const SKELETON_ROWS = 6;

type SubscriptionPages = InfiniteData<PostSubscriptionListResponse>;
type UnsubscribeAction = { authorId: string; viewerId: string | undefined };

export default function ActivitySubscriptionsScreen() {
  const { t } = useTranslation();

  const queryClient = useQueryClient();
  const { user, canUsePrivateApi, isPrivateApiPending } = useAuth();

  const subscriptionsKey = viewerQueryKeys.subscriptions(user?.id);

  const { data, isLoading, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: subscriptionsKey,
      queryFn: ({ pageParam }) => subscriptionService.list(pageParam, PAGE_LIMIT),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage, _pages, _pageParam, pageParams) =>
        nextUnvisitedCursor(lastPage.nextCursor, pageParams),
      enabled: canUsePrivateApi,
    });

  const subscriptions = useMemo(
    () => data?.pages.flatMap((page) => page.subscriptions) ?? [],
    [data],
  );

  const unsubscribeMutation = useMutation({
    mutationFn: async ({ authorId, viewerId }: UnsubscribeAction) => {
      // onMutate can await cancellation while the account changes. Read the
      // SDK runtime at dispatch, rather than the render that created this action.
      const controller = new AbortController();
      const cancelIfViewerChanged = () => {
        if (!viewerId || currentAccountId() !== viewerId) controller.abort();
      };
      const stopWatching = subscribeAccount(cancelIfViewerChanged);
      try {
        cancelIfViewerChanged();
        if (controller.signal.aborted) throw new Error(t('subscription.error'));
        // Also cancel an SDK auth preflight or queued request if the account
        // changes after dispatch. Already completed writes remain viewer-scoped.
        return await subscriptionService.unsubscribe(authorId, { signal: controller.signal });
      } finally {
        stopWatching();
      }
    },
    // Optimistically drop the row from every loaded page so the list responds
    // instantly. `onError` restores the exact snapshot rather than re-inserting,
    // which would put the row back in the wrong position.
    onMutate: async ({ authorId, viewerId }: UnsubscribeAction) => {
      const queryKey = viewerQueryKeys.subscriptions(viewerId);
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<SubscriptionPages>(queryKey);
      queryClient.setQueryData<SubscriptionPages>(queryKey, (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          pages: prev.pages.map((page) => ({
            ...page,
            subscriptions: page.subscriptions.filter((item) => item.author.id !== authorId),
          })),
        };
      });
      return { previous, viewerId, queryKey };
    },
    onError: (mutationError, _authorId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
      toast(normalizeApiError(mutationError).message || t('subscription.error'), { type: 'error' });
    },
    onSuccess: (_data, _authorId, context) => {
      notifyFeedRankingChanged(context?.viewerId, true);
      toast(t('subscription.unsubscribed'), { type: 'success' });
    },
    // Re-sync with the server either way: a success may have shifted the cursor
    // boundary, and a failed rollback still needs the authoritative list.
    onSettled: (_data, _error, _authorId, context) => {
      queryClient.invalidateQueries({ queryKey: context?.queryKey ?? subscriptionsKey });
    },
  });

  const { mutate: unsubscribe, isPending: isUnsubscribing } = unsubscribeMutation;

  const handleLoadMore = useCallback(() => {
    if (isFetchingNextPage || !hasNextPage) return;
    void fetchNextPage();
  }, [isFetchingNextPage, hasNextPage, fetchNextPage]);

  const renderRow = useCallback(
    (item: PostSubscriptionItem) => {
      const handle = getNormalizedUserHandle(item.author) ?? '';
      const label = handle
        ? t('subscription.list.turnOffFor', {
            handle,
            defaultValue: 'Turn off notifications for @{{handle}}',
          })
        : t('subscription.list.turnOff', {
            defaultValue: 'Turn off notifications',
          });

      return (
        <ProfileCard
          key={item.author.id}
          profile={item.author}
          accessory={toElement(
            LButton(Icon(RiNotification3Fill))
              .shape('circle')
              .style('subtle')
              .tint('neutral')
              .onPress(() => unsubscribe({ authorId: item.author.id, viewerId: user?.id }))
              .disabled(isUnsubscribing)
              .label(label),
          )}
        />
      );
    },
    [t, unsubscribe, isUnsubscribing, user?.id],
  );

  const listHeader = useMemo(
    () =>
      toElement(
        LSettingsSection(
          undefined,
          LGroupedSection(
            LGroupedSectionItem(
              t('subscription.list.intro.title', {
                defaultValue: 'Activity from others',
              }),
            )
              .wrapControl()
              .description(
                t('subscription.list.intro.description', {
                  defaultValue: 'Get notified when these accounts post.',
                }),
              )
              .trailing(Embed(<></>)),
          ),
        ),
      ),
    [t],
  );

  const listEmpty = useMemo(
    () =>
      toElement(
        VStack(
          Embed(
            <EmptyState
              title={t('subscription.list.empty.title', {
                defaultValue: 'No activity notifications',
              })}
              subtitle={t('subscription.list.empty.subtitle', {
                defaultValue:
                  "Open someone's profile and tap the bell to get notified whenever they post.",
              })}
              sticker="subscriptions"
            />,
          ),
        ).padding('vertical', '2xl'),
      ),
    [t],
  );

  const listFooter = useMemo(
    () =>
      // The shared modal owns scrolling; the explicit action below loads more.
      isFetchingNextPage ? (
        <ListSkeleton count={2} />
      ) : (
        toElement(VStack().frame({ height: '3xl' }))
      ),
    [isFetchingNextPage],
  );

  const renderContent = () => {
    if (isPrivateApiPending) {
      return <ListSkeleton />;
    }

    if (!canUsePrivateApi) {
      return (
        <OxyAuthPrompt
          label={t('subscription.list.signInRequired', {
            defaultValue: 'Sign in to manage activity notifications',
          })}
          description={t('subscription.list.signInRequiredDesc', {
            defaultValue: 'Choose which accounts notify you when they post.',
          })}
        />
      );
    }

    if (error && subscriptions.length === 0) {
      return (
        <ErrorComponent
          title={t('subscription.list.error.title', {
            defaultValue: 'Failed to load your subscriptions',
          })}
          message={t('subscription.list.error.message', {
            defaultValue: "We couldn't load the accounts you're notified about. Please try again.",
          })}
          onRetry={() => {
            void refetch();
          }}
          hideBackButton
          style={{ flex: 1 }}
        />
      );
    }

    if (isLoading && subscriptions.length === 0) {
      return toElement(
        VStack(Embed(listHeader), Embed(<ProfileCardSkeletonList count={SKELETON_ROWS} />)),
      );
    }

    return toElement(
      VStack(
        Embed(listHeader),
        Embed(subscriptions.length === 0 ? listEmpty : subscriptions.map(renderRow)),
        Embed(listFooter),
        Embed(
          hasNextPage &&
            toElement(
              LButton(Text(t('common.loadMore', { defaultValue: 'Load more' })))
                .style('subtle')
                .tint('neutral')
                .loading(isFetchingNextPage)
                .onPress(handleLoadMore),
            ),
        ),
      ),
    );
  };

  return (
    <>
      <SEO
        title={t('subscription.list.seo.title', {
          defaultValue: 'Activity notifications',
        })}
        description={t('subscription.list.seo.description', {
          defaultValue: 'Manage the accounts that notify you when they post.',
        })}
      />
      {toElement(VStack(Embed(renderContent())).spacing('lg'))}
    </>
  );
}
