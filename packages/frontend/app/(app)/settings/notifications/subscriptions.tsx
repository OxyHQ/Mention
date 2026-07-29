/**
 * Activity notification subscriptions — the accounts the viewer asked to be
 * notified about ("notify me when this account posts").
 *
 * Portions adapted from bluesky-social/social-app, MIT © 2023–2026 Bluesky
 * Social PBC (`ActivityNotificationSettings.tsx`, commit 92ec563f9): the screen's
 * layout — an explanatory settings header above the list, the empty state that
 * teaches the bell affordance instead of just saying "nothing here", and the
 * per-row toggle — is theirs. The primitives are Mention's (Bloom
 * `SettingsList*`, `ProfileCard`, `useTranslation`, React Query).
 */

import React, { useCallback, useMemo } from 'react';
import { FlatList, Platform, View } from 'react-native';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { OxyAuthPrompt, useAuth } from '@oxyhq/services/ui/client';
import { getNormalizedUserHandle } from '@oxyhq/core';
import { Loading, SpinnerIcon } from '@oxyhq/bloom/loading';
import { toast } from '@oxyhq/bloom/toast';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import type { PostSubscriptionItem, PostSubscriptionListResponse } from '@mention/shared-types';

import { Header } from '@/components/Header';
import { SEO } from '@/components/SEO';
import { ThemedView } from '@/components/ThemedView';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { BellActive } from '@/assets/icons/bell-icon';
import { RowIcon } from '@/components/settings/RowIcon';
import { EmptyState } from '@/components/common/EmptyState';
import { Error as ErrorComponent } from '@/components/Error';
import { LoadMoreSentinel } from '@/components/common/LoadMoreSentinel';
import { ProfileCard, ProfileCardSkeletonList } from '@/components/ProfileCard';
import { useSafeBack } from '@/hooks/useSafeBack';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { subscriptionService } from '@/services/subscriptionService';
import { normalizeApiError } from '@/utils/apiError';

const IS_WEB = Platform.OS === 'web';
const PAGE_LIMIT = 50;
const SKELETON_ROWS = 6;

type SubscriptionPages = InfiniteData<PostSubscriptionListResponse>;

export default function ActivitySubscriptionsScreen() {
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const queryClient = useQueryClient();
  const { user, canUsePrivateApi, isPrivateApiPending } = useAuth();

  const subscriptionsKey = viewerQueryKeys.subscriptions(user?.id);

  const {
    data,
    isLoading,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: subscriptionsKey,
    queryFn: ({ pageParam }) => subscriptionService.list(pageParam, PAGE_LIMIT),
    initialPageParam: undefined as string | undefined,
    // The absence of `nextCursor` is the end of the list.
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: canUsePrivateApi,
  });

  const subscriptions = useMemo(
    () => data?.pages.flatMap((page) => page.subscriptions) ?? [],
    [data],
  );

  const unsubscribeMutation = useMutation({
    mutationFn: (authorId: string) => subscriptionService.unsubscribe(authorId),
    // Optimistically drop the row from every loaded page so the list responds
    // instantly. `onError` restores the exact snapshot rather than re-inserting,
    // which would put the row back in the wrong position.
    onMutate: async (authorId: string) => {
      await queryClient.cancelQueries({ queryKey: subscriptionsKey });
      const previous = queryClient.getQueryData<SubscriptionPages>(subscriptionsKey);
      queryClient.setQueryData<SubscriptionPages>(subscriptionsKey, (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          pages: prev.pages.map((page) => ({
            ...page,
            subscriptions: page.subscriptions.filter((item) => item.author.id !== authorId),
          })),
        };
      });
      return { previous };
    },
    onError: (mutationError, _authorId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(subscriptionsKey, context.previous);
      }
      toast(normalizeApiError(mutationError).message || t('subscription.error'), { type: 'error' });
    },
    onSuccess: () => {
      toast(t('subscription.unsubscribed'), { type: 'success' });
    },
    // Re-sync with the server either way: a success may have shifted the cursor
    // boundary, and a failed rollback still needs the authoritative list.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: subscriptionsKey });
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
        : t('subscription.list.turnOff', { defaultValue: 'Turn off notifications' });

      return (
        <ProfileCard
          key={item.author.id}
          profile={item.author}
          accessory={
            <IconButton
              variant="icon"
              onPress={() => unsubscribe(item.author.id)}
              disabled={isUnsubscribing}
              accessibilityLabel={label}>
              <BellActive size={20} className="text-primary" />
            </IconButton>
          }
        />
      );
    },
    [t, unsubscribe, isUnsubscribing],
  );

  const listHeader = useMemo(
    () => (
      <SettingsListGroup>
        <SettingsListItem
          icon={<RowIcon name="notifications" />}
          title={t('subscription.list.intro.title', { defaultValue: 'Activity from others' })}
          description={t('subscription.list.intro.description', {
            defaultValue: 'Get notified when these accounts post.',
          })}
          showChevron={false}
        />
      </SettingsListGroup>
    ),
    [t],
  );

  const listEmpty = useMemo(
    () => (
      <View className="py-6">
        <EmptyState
          title={t('subscription.list.empty.title', { defaultValue: 'No activity notifications' })}
          subtitle={t('subscription.list.empty.subtitle', {
            defaultValue:
              "Open someone's profile and tap the bell to get notified whenever they post.",
          })}
          icon={{ name: 'notifications-outline', size: 48 }}
        />
      </View>
    ),
    [t],
  );

  const listFooter = useMemo(
    () => (
      <View>
        {/* WEB paginates from this 1px sentinel (the document is the scroller, so
            there is no `onEndReached`); NATIVE uses the FlatList's own. */}
        <LoadMoreSentinel onLoadMore={handleLoadMore} enabled={Boolean(hasNextPage)} />
        {isFetchingNextPage ? (
          <View className="py-5 items-center">
            <SpinnerIcon size={20} className="text-primary" />
          </View>
        ) : (
          <View className="h-8" />
        )}
      </View>
    ),
    [handleLoadMore, hasNextPage, isFetchingNextPage],
  );

  const header = (
    <Header
      options={{
        title: t('subscription.list.title', { defaultValue: 'Activity notifications' }),
        leftComponents: [
          <IconButton variant="icon" key="back" onPress={() => safeBack()}>
            <BackArrowIcon size={20} className="text-foreground" />
          </IconButton>,
        ],
      }}
      hideBottomBorder
      disableSticky
    />
  );

  const renderContent = () => {
    if (isPrivateApiPending) {
      return (
        <View className="flex-1 justify-center items-center">
          <Loading className="text-primary" size="large" />
        </View>
      );
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
      return (
        <View>
          {listHeader}
          <ProfileCardSkeletonList count={SKELETON_ROWS} />
        </View>
      );
    }

    // WEB: the shared panel/document owns the scroll, so a FlatList here would
    // nest a second scroll container and break the sticky rails. NATIVE keeps
    // the FlatList as the screen's scroller.
    return IS_WEB ? (
      <View>
        {listHeader}
        {subscriptions.length === 0 ? listEmpty : subscriptions.map(renderRow)}
        {listFooter}
      </View>
    ) : (
      <FlatList
        data={subscriptions}
        keyExtractor={(item) => item.author.id}
        renderItem={({ item }) => renderRow(item)}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={listEmpty}
        ListFooterComponent={listFooter}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.4}
        showsVerticalScrollIndicator={false}
      />
    );
  };

  return (
    <>
      <SEO
        title={t('subscription.list.seo.title', { defaultValue: 'Activity notifications' })}
        description={t('subscription.list.seo.description', {
          defaultValue: 'Manage the accounts that notify you when they post.',
        })}
      />
      <ThemedView className="flex-1">
        {header}
        {renderContent()}
      </ThemedView>
    </>
  );
}
