/**
 * Activity notification subscriptions — the accounts the viewer asked to be
 * notified about ("notify me when this account posts").
 *
 * Portions adapted from bluesky-social/social-app, MIT © 2023–2026 Bluesky
 * Social PBC (`ActivityNotificationSettings.tsx`, commit 92ec563f9): the screen's
 * layout — an explanatory settings header above the list, the empty state that
 * teaches the bell affordance instead of just saying "nothing here", and the
 * per-row toggle — is theirs. The primitives are Mention's (Bloom
 * `SettingsCard`/`SettingsRow`, `ProfileCard`, `useTranslation`, React Query).
 */

import type {
  PostSubscriptionItem,
  PostSubscriptionListResponse,
} from "@mention/shared-types";
import { Loading, SpinnerIcon } from "@oxy.so/bloom/loading";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@oxy.so/bloom/settings-modal";
import { toast } from "@oxy.so/bloom/toast";
import { getNormalizedUserHandle } from "@oxy.so/core";
import { OxyAuthPrompt, useAuth } from "@oxy.so/services/ui/client";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";

import { EmptyState } from "@/components/common/EmptyState";
import { LoadMoreSentinel } from "@/components/common/LoadMoreSentinel";
import { Error as ErrorComponent } from "@/components/Error";
import { ProfileCard, ProfileCardSkeletonList } from "@/components/ProfileCard";
import { SEO } from "@/components/SEO";
import { viewerQueryKeys } from "@/lib/viewerQueryKeys";
import { subscriptionService } from "@/services/subscriptionService";
import { normalizeApiError } from "@/utils/apiError";
import { Button } from "@oxy.so/bloom/button";
import { RiNotification3Fill } from '@oxy.so/bloom/icons/RiNotification3Fill';

const PAGE_LIMIT = 50;
const SKELETON_ROWS = 6;

type SubscriptionPages = InfiniteData<PostSubscriptionListResponse>;

export default function ActivitySubscriptionsScreen() {
  const { t } = useTranslation();

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
      const previous =
        queryClient.getQueryData<SubscriptionPages>(subscriptionsKey);
      queryClient.setQueryData<SubscriptionPages>(subscriptionsKey, (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          pages: prev.pages.map((page) => ({
            ...page,
            subscriptions: page.subscriptions.filter(
              (item) => item.author.id !== authorId,
            ),
          })),
        };
      });
      return { previous };
    },
    onError: (mutationError, _authorId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(subscriptionsKey, context.previous);
      }
      toast(
        normalizeApiError(mutationError).message || t("subscription.error"),
        { type: "error" },
      );
    },
    onSuccess: () => {
      toast(t("subscription.unsubscribed"), { type: "success" });
    },
    // Re-sync with the server either way: a success may have shifted the cursor
    // boundary, and a failed rollback still needs the authoritative list.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: subscriptionsKey });
    },
  });

  const { mutate: unsubscribe, isPending: isUnsubscribing } =
    unsubscribeMutation;

  const handleLoadMore = useCallback(() => {
    if (isFetchingNextPage || !hasNextPage) return;
    void fetchNextPage();
  }, [isFetchingNextPage, hasNextPage, fetchNextPage]);

  const renderRow = useCallback(
    (item: PostSubscriptionItem) => {
      const handle = getNormalizedUserHandle(item.author) ?? "";
      const label = handle
        ? t("subscription.list.turnOffFor", {
            handle,
            defaultValue: "Turn off notifications for @{{handle}}",
          })
        : t("subscription.list.turnOff", {
            defaultValue: "Turn off notifications",
          });

      return (
        <ProfileCard
          key={item.author.id}
          profile={item.author}
          accessory={
            <Button
              appearance="subtle"
              tone="neutral"
              iconOnly
              leadingIcon={RiNotification3Fill}
              onPress={() => unsubscribe(item.author.id)}
              disabled={isUnsubscribing}
              accessibilityLabel={label}
            />
          }
        />
      );
    },
    [t, unsubscribe, isUnsubscribing],
  );

  const listHeader = useMemo(
    () => (
      <SettingsSection>
        <SettingsCard>
          <SettingsRow
            label={t("subscription.list.intro.title", {
              defaultValue: "Activity from others",
            })}
            description={t("subscription.list.intro.description", {
              defaultValue: "Get notified when these accounts post.",
            })}
          ></SettingsRow>
        </SettingsCard>
      </SettingsSection>
    ),
    [t],
  );

  const listEmpty = useMemo(
    () => (
      <View className="py-6">
        <EmptyState
          title={t("subscription.list.empty.title", {
            defaultValue: "No activity notifications",
          })}
          subtitle={t("subscription.list.empty.subtitle", {
            defaultValue:
              "Open someone's profile and tap the bell to get notified whenever they post.",
          })}
          icon={{ name: "notifications-outline", size: 48 }}
        />
      </View>
    ),
    [t],
  );

  const listFooter = useMemo(
    () => (
      <View>
        {/* The shared modal owns scrolling; the explicit action also supports native. */}
        <LoadMoreSentinel
          onLoadMore={handleLoadMore}
          enabled={Boolean(hasNextPage)}
        />
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
          label={t("subscription.list.signInRequired", {
            defaultValue: "Sign in to manage activity notifications",
          })}
          description={t("subscription.list.signInRequiredDesc", {
            defaultValue: "Choose which accounts notify you when they post.",
          })}
        />
      );
    }

    if (error && subscriptions.length === 0) {
      return (
        <ErrorComponent
          title={t("subscription.list.error.title", {
            defaultValue: "Failed to load your subscriptions",
          })}
          message={t("subscription.list.error.message", {
            defaultValue:
              "We couldn't load the accounts you're notified about. Please try again.",
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

    return (
      <View>
        {listHeader}
        {subscriptions.length === 0 ? listEmpty : subscriptions.map(renderRow)}
        {listFooter}
        {hasNextPage && (
          <Button
            appearance="subtle"
            tone="neutral"
            loading={isFetchingNextPage}
            onPress={handleLoadMore}
          >
            {t("common.loadMore", { defaultValue: "Load more" })}
          </Button>
        )}
      </View>
    );
  };

  return (
    <>
      <SEO
        title={t("subscription.list.seo.title", {
          defaultValue: "Activity notifications",
        })}
        description={t("subscription.list.seo.description", {
          defaultValue: "Manage the accounts that notify you when they post.",
        })}
      />
      <View className="gap-4">{renderContent()}</View>
    </>
  );
}
