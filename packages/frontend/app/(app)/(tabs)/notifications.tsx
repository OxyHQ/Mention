import type React from 'react';
import { useState, useCallback, useMemo } from 'react';
import { View, TouchableOpacity } from 'react-native';
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@/lib/navigation/router';
import { OxyAuthPrompt, useAuth, useAuthStore } from '@oxy.so/services/ui/client';
import { Button } from '@oxy.so/bloom/button';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen } from '@oxy.so/bloom/screen';
import { Text } from '@oxy.so/bloom/typography';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiHand } from '@oxy.so/bloom/icons/RiHand';
import { NotificationItem } from '@/components/notifications/NotificationItem';
import { recoverChunkError } from '@/lib/chunkReload';
import { ErrorBoundary } from '@oxy.so/bloom/error-boundary';
import { createLogger } from '@oxy.so/core/logger';
import { notificationService } from '@/services/notificationService';
import { useTranslation } from 'react-i18next';
import { normalizeApiError } from '@/utils/apiError';
import { useTheme } from '@oxy.so/bloom/theme';
import {
  groupNotifications,
  type GroupedNotification,
  type NotificationListItem,
} from '@/utils/groupNotifications';
import { useUnreadCount } from '@/hooks/useUnreadCount';
import { useOwnedNotificationSurfaces } from '@/hooks/useOwnedNotificationSurfaces';
import {
  NOTIFICATION_OPTIMISTIC_KEY,
  usePendingNotificationOperations,
} from '@/hooks/usePendingNotificationOperations';
import { projectNotificationOptimism } from '@/utils/notificationOptimism';
import { reconcileNotificationCache } from '@/utils/notificationReconciliation';
import { useNotificationFilter, type NotificationTab } from '@/hooks/useNotificationFilter';
import {
  findNotification,
  markNotificationsRead,
  removeNotification,
  bumpUnread,
  type NotificationsInfiniteData,
} from '@/utils/notificationCache';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { getNextNotificationPage } from '@/lib/notificationPagination';
import { NotificationsList } from '@/components/NotificationsList';
import { NotificationSkeleton } from '@/components/notifications/NotificationSkeleton';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { toast } from '@oxy.so/bloom/toast';
import { confirmDialog } from '@/utils/alerts';
import { SEO } from '@/components/SEO';
import { requestSettings } from '@/components/settings/settingsRoutes';
import { Error as ErrorDisplay } from '@/components/Error';
import { EmptyState } from '@/components/common/EmptyState';
import type { EmptyStateStickerName } from '@/lib/stickers';
import { RiCheckDoubleLine } from '@oxy.so/bloom/icons/RiCheckDoubleLine';
import { RiNotification3Fill } from '@oxy.so/bloom/icons/RiNotification3Fill';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { prewarmUsersByIds } from '@/utils/userEnrichment';
import { SYSTEM_NOTIFICATION_ACTOR_ID } from '@mention/shared-types/notification';
import type { NotificationIntent } from '@/types/notificationIntent';

const notificationLogger = createLogger('Notifications');

/** Time buckets the list is sectioned into, newest first. */
type TimeBucket = 'today' | 'this_week' | 'earlier';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
type RowIntent = NotificationIntent & { ids: string[] };

function throwGroupedFailure(outcomes: PromiseSettledResult<void>[]): void {
  const failures = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
  );
  // A viewer mismatch proves only that particular request did not mutate. A
  // different failure may be ambiguous and must still trigger reconciliation.
  const failure =
    failures.find(({ reason }) => normalizeApiError(reason).code !== 'VIEWER_CHANGED') ??
    failures[0];
  if (failure) throw failure.reason;
}

/**
 * Which section a notification falls into, relative to `now`:
 * - `today`    — on or after the local start of today.
 * - `this_week`— within the previous 7 days (excluding today).
 * - `earlier`  — anything older. An unparseable date also lands here, so a bad
 *                timestamp sinks to the bottom section instead of throwing.
 */
function timeBucketOf(createdAt: string, now: Date): TimeBucket {
  const time = new Date(createdAt).getTime();
  if (Number.isNaN(time)) return 'earlier';
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (time >= startOfToday) return 'today';
  if (time >= startOfToday - WEEK_MS) return 'this_week';
  return 'earlier';
}

/**
 * The notification types each tab surfaces — the SINGLE tab→types mapping, read
 * by both the list filter and the per-tab unread tallies so the two can never
 * disagree. The `all` tab has no entry: it matches every type.
 */
type FilterableTab = Exclude<NotificationTab, 'all'>;

const TAB_TYPES: Record<FilterableTab, readonly string[]> = {
  mentions: ['mention', 'reply'],
  follows: ['follow'],
  likes: ['like', 'boost', 'quote'],
  posts: ['post'],
  pokes: ['poke'],
};

/** Per-tab unread tallies. The `all` tab uses the authoritative server total. */
type TabUnreadCounts = Record<FilterableTab, number>;

const NotificationsScreen: React.FC = () => {
  const { user, oxyServices, isAuthResolved, canUsePrivateApi, isPrivateApiPending } = useAuth();
  const isCurrentIntent = useCallback(
    (intent: NotificationIntent) =>
      canUsePrivateApi &&
      user?.id === intent.viewerId &&
      useAuthStore.getState().user?.id === intent.viewerId &&
      oxyServices.session.isAuthenticated &&
      oxyServices.http.getSessionEpoch() === intent.epoch,
    [canUsePrivateApi, user?.id, oxyServices],
  );
  const captureIntent = useCallback((): NotificationIntent | null => {
    if (!user?.id) return null;
    const intent = { viewerId: user.id, epoch: oxyServices.http.getSessionEpoch() };
    return isCurrentIntent(intent) ? intent : null;
  }, [user?.id, oxyServices, isCurrentIntent]);
  const subscribeSession = useCallback(
    (listener: () => void) => {
      const unsubscribeUser = useAuthStore.subscribe(listener);
      try {
        const unsubscribeToken = oxyServices.session.onChange(listener);
        return () => {
          unsubscribeUser();
          unsubscribeToken();
        };
      } catch (error) {
        unsubscribeUser();
        throw error;
      }
    },
    [oxyServices],
  );
  const ownNotificationSurface = useOwnedNotificationSurfaces(isCurrentIntent, subscribeSession);
  const queryClient = useQueryClient();
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const { t } = useTranslation();
  const theme = useTheme();
  const { activeTab, selectTab: handleTabPress } = useNotificationFilter();

  // The realtime socket is mounted app-wide via <RealtimeNotificationsBridge/>
  // (a module singleton). This screen must NOT also call
  // useRealtimeNotifications() — a second mount would double every listener.

  const { operations, epoch: projectionEpoch } = usePendingNotificationOperations(
    user?.id,
    oxyServices,
  );
  const selectProjectedNotifications = useCallback(
    (data: NotificationsInfiniteData) =>
      projectNotificationOptimism(data, 0, operations, {
        viewerId: user?.id,
        epoch: projectionEpoch,
      }).data ?? data,
    [operations, user?.id, projectionEpoch],
  );

  // Fetch notifications — cursor-paginated. Gated on `canUsePrivateApi` (not
  // just `isAuthenticated`) so the private `/notifications` read never fires
  // while the SSO cold-boot is still resolving (which would 401-loop).
  const {
    data: notificationsData,
    isLoading,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: viewerQueryKeys.notifications(user?.id),
    queryFn: ({ pageParam, signal }) => {
      if (!user?.id) throw new Error('Notification viewer is unavailable');
      return notificationService.getNotificationsForViewer(user.id, pageParam, 20, signal);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: getNextNotificationPage,
    select: selectProjectedNotifications,
    enabled: canUsePrivateApi && !!user?.id,
  });

  const allNotifications = useMemo(
    () => notificationsData?.pages.flatMap((page) => page.notifications) ?? [],
    [notificationsData],
  );

  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Live unread count (drives both the header "mark all" affordance and the
  // bell badges elsewhere) — the single source of truth, kept in lockstep with
  // the list via the shared cache reducers below.
  const unreadCount = useUnreadCount();
  const notificationsQueryKey = useMemo(() => viewerQueryKeys.notifications(user?.id), [user?.id]);
  const reconcileOrMarkStale = useCallback(
    async (original: NotificationIntent) => {
      const current = captureIntent();
      if (current?.viewerId === original.viewerId) {
        const outcome = await reconcileNotificationCache(queryClient, current, isCurrentIntent, {
          getPage: (viewerId, cursor, limit) =>
            notificationService.getNotificationsForViewer(viewerId, cursor, limit),
        });
        if (outcome.status === 'applied' || outcome.status === 'absent') return;
      }
      // A later event or session owns the current data. Keep it; the next
      // active read will use the guarded endpoint rather than the old route.
      await queryClient.invalidateQueries({
        queryKey: viewerQueryKeys.notificationsRoot(original.viewerId),
        refetchType: 'none',
      });
    },
    [captureIntent, isCurrentIntent, queryClient],
  );

  const cancelObsoleteReads = useCallback(() => {
    // Keep realtime data received since a fetch began: the default revert:true
    // would restore the pre-fetch snapshot and erase it on cancellation.
    void queryClient.cancelQueries(
      { queryKey: notificationsQueryKey, exact: true },
      { revert: false },
    );
    void queryClient.cancelQueries(
      { queryKey: viewerQueryKeys.unreadNotifications(user?.id), exact: true },
      { revert: false },
    );
  }, [queryClient, notificationsQueryKey, user?.id]);

  // Only confirmed writes update the authoritative cache; pending intent is projected.
  const applyReadPatch = useCallback(
    (ids: string[]) => {
      const prev = queryClient.getQueryData<NotificationsInfiniteData>(notificationsQueryKey);
      let delta = 0;
      if (prev) {
        for (const id of ids) {
          const found = findNotification(prev, id);
          if (found && !found.read) delta -= 1;
        }
      }
      queryClient.setQueryData<NotificationsInfiniteData>(notificationsQueryKey, (data) =>
        data ? markNotificationsRead(data, ids) : data,
      );
      if (delta !== 0) bumpUnread(queryClient, user?.id, delta);
    },
    [queryClient, notificationsQueryKey, user?.id],
  );

  // Mark notification(s) as read — group rows pass every id in the group.
  const { mutate: markAsRead } = useMutation({
    mutationKey: NOTIFICATION_OPTIMISTIC_KEY,
    mutationFn: async (intent: RowIntent) => {
      if (!isCurrentIntent(intent)) throw new Error('Notification session changed');
      const outcomes = await Promise.allSettled(
        [...new Set(intent.ids)].map(async (id) => {
          await notificationService.markAsRead(id, intent.viewerId);
          if (isCurrentIntent(intent)) {
            cancelObsoleteReads();
            if (isCurrentIntent(intent)) applyReadPatch([id]);
            else await reconcileOrMarkStale(intent);
          } else await reconcileOrMarkStale(intent);
        }),
      );
      throwGroupedFailure(outcomes);
    },
    onMutate: (intent: RowIntent) => {
      if (!isCurrentIntent(intent)) return undefined;
      cancelObsoleteReads();
      return isCurrentIntent(intent)
        ? { ...intent, kind: 'read' as const, ids: [...intent.ids] }
        : undefined;
    },
    onError: async (error: unknown, intent) => {
      const current = isCurrentIntent(intent);
      if (normalizeApiError(error).code === 'VIEWER_CHANGED' && current) return;
      if (current) {
        notificationLogger.error('Error marking notification as read', error);
        toast(t('notification.mark_read_error') || 'Failed to mark notification as read', {
          type: 'error',
        });
      }
      await reconcileOrMarkStale(intent);
    },
  });

  // Optimistically drop the given ids from the cached list + decrement the
  // badge for any that were unread (mirrors `applyReadPatch`). The server echo
  // to `user:<id>` reconciles idempotently; `onError` resyncs.
  const applyRemovePatch = useCallback(
    (ids: string[]) => {
      const prev = queryClient.getQueryData<NotificationsInfiniteData>(notificationsQueryKey);
      let delta = 0;
      if (prev) {
        for (const id of ids) {
          const found = findNotification(prev, id);
          if (found && !found.read) delta -= 1;
        }
      }
      queryClient.setQueryData<NotificationsInfiniteData>(notificationsQueryKey, (data) => {
        if (!data) return data;
        let next = data;
        for (const id of ids) next = removeNotification(next, id);
        return next;
      });
      if (delta !== 0) bumpUnread(queryClient, user?.id, delta);
    },
    [queryClient, notificationsQueryKey, user?.id],
  );

  // Delete notification(s) — group rows pass every id in the group.
  const { mutate: deleteNotification } = useMutation({
    mutationKey: NOTIFICATION_OPTIMISTIC_KEY,
    mutationFn: async (intent: RowIntent) => {
      if (!isCurrentIntent(intent)) throw new Error('Notification session changed');
      const outcomes = await Promise.allSettled(
        [...new Set(intent.ids)].map(async (id) => {
          await notificationService.deleteNotification(id, intent.viewerId);
          if (isCurrentIntent(intent)) {
            cancelObsoleteReads();
            if (isCurrentIntent(intent)) applyRemovePatch([id]);
            else await reconcileOrMarkStale(intent);
          } else await reconcileOrMarkStale(intent);
        }),
      );
      throwGroupedFailure(outcomes);
    },
    onMutate: (intent: RowIntent) => {
      if (!isCurrentIntent(intent)) return undefined;
      cancelObsoleteReads();
      return isCurrentIntent(intent)
        ? { ...intent, kind: 'delete' as const, ids: [...intent.ids] }
        : undefined;
    },
    onSuccess: (_data, intent) => {
      if (!isCurrentIntent(intent)) return;
      toast(t('notification.deleted', { defaultValue: 'Notification deleted' }), {
        type: 'success',
      });
    },
    onError: async (error: unknown, intent) => {
      const current = isCurrentIntent(intent);
      if (normalizeApiError(error).code === 'VIEWER_CHANGED' && current) return;
      if (current) {
        notificationLogger.error('Error deleting notification', error);
        toast(t('notification.delete_error', { defaultValue: 'Failed to delete notification' }), {
          type: 'error',
        });
      }
      await reconcileOrMarkStale(intent);
    },
  });

  const markAllAsReadMutation = useMutation({
    mutationKey: NOTIFICATION_OPTIMISTIC_KEY,
    mutationFn: (intent: NotificationIntent) => {
      if (!isCurrentIntent(intent)) throw new Error('Notification session changed');
      return notificationService.markAllAsRead(intent.viewerId);
    },
    onMutate: (intent: NotificationIntent) => {
      if (!isCurrentIntent(intent)) return undefined;
      cancelObsoleteReads();
      if (!isCurrentIntent(intent)) return undefined;
      const data = queryClient.getQueryData<NotificationsInfiniteData>(notificationsQueryKey);
      return {
        ...intent,
        kind: 'read-all' as const,
        ids: data?.pages.flatMap((page) => page.notifications.map((item) => item._id)) ?? [],
      };
    },
    onSuccess: async (_data, intent, operation) => {
      if (isCurrentIntent(intent) && operation) {
        cancelObsoleteReads();
        if (isCurrentIntent(intent)) applyReadPatch(operation.ids);
      }
      await reconcileOrMarkStale(intent);
      if (isCurrentIntent(intent)) {
        toast(t('notification.mark_all_read_success') || 'All notifications marked as read', {
          type: 'success',
        });
      }
    },
    onError: async (error: unknown, intent) => {
      const current = isCurrentIntent(intent);
      if (normalizeApiError(error).code === 'VIEWER_CHANGED' && current) return;
      if (current) {
        const { status: statusCode, message: errorMessage } = normalizeApiError(error);
        notificationLogger.error('Error marking all notifications as read', error, { statusCode });
        toast(
          t('notification.mark_all_read_error') ||
            `Failed to mark all notifications as read${statusCode ? ` (${statusCode})` : ''}: ${errorMessage}`,
          { type: 'error' },
        );
      }
      await reconcileOrMarkStale(intent);
    },
  });

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  const handleMarkAsRead = useCallback(
    (ids: string[], openedIntent?: NotificationIntent) => {
      const intent = openedIntent ?? captureIntent();
      if (intent && isCurrentIntent(intent)) markAsRead({ ...intent, ids });
    },
    [captureIntent, isCurrentIntent, markAsRead],
  );

  const handleDelete = useCallback(
    (ids: string[], openedIntent?: NotificationIntent) => {
      const intent = openedIntent ?? captureIntent();
      if (intent && isCurrentIntent(intent)) deleteNotification({ ...intent, ids });
    },
    [captureIntent, isCurrentIntent, deleteNotification],
  );

  const handleMarkAllAsRead = useCallback(async () => {
    const intent = captureIntent();
    if (!intent) return;
    if (unreadCount === 0) {
      toast(t('notification.all_already_read') || 'All notifications are already read', {
        type: 'info',
      });
      return;
    }

    const confirmed = await ownNotificationSurface(intent, (signal) =>
      confirmDialog({
        title: t('notification.mark_all_read'),
        message:
          t('notification.mark_all_read_confirm') ||
          'Are you sure you want to mark all notifications as read?',
        okText: t('notification.mark_all_read') || 'Mark All as Read',
        cancelText: t('cancel') || 'Cancel',
        signal,
      }),
    );
    if (confirmed && isCurrentIntent(intent)) {
      markAllAsReadMutation.mutate(intent);
    }
  }, [
    captureIntent,
    isCurrentIntent,
    markAllAsReadMutation,
    ownNotificationSurface,
    t,
    unreadCount,
  ]);

  // Notifications whose actor the backend did NOT populate would each fire their
  // own `getProfileById` from inside NotificationItem — an N+1 across the page.
  // Collect those distinct actor ids and warm the React Query user cache with ONE
  // bulk `getUsersByIds`, so every per-row read hits the warm cache instead.
  const unpopulatedActorIds = useMemo(() => {
    const ids = new Set<string>();
    for (const n of allNotifications) {
      if (n.actorId_populated) continue;
      const actorId = n.actorId;
      const id =
        typeof actorId === 'string'
          ? actorId
          : actorId && typeof actorId === 'object'
            ? String(
                (actorId as { _id?: unknown; id?: unknown })._id ??
                  (actorId as { id?: unknown }).id ??
                  '',
              )
            : '';
      // Apart from the synthetic system actor, a non-empty `actorId` is an Oxy
      // account id. The id-SHAPE test that stood here
      // is what dropped every account created after Oxy's ids became uuid
      // v7 out of this batch, leaving those rows to per-row resolution.
      if (id && id !== SYSTEM_NOTIFICATION_ACTOR_ID) ids.add(id);
    }
    return Array.from(ids);
  }, [allNotifications]);

  useQuery({
    queryKey: viewerQueryKeys.notificationActors(user?.id, unpopulatedActorIds),
    queryFn: () => prewarmUsersByIds(unpopulatedActorIds, (ids) => oxyServices.users.getMany(ids)),
    enabled: canUsePrivateApi && !!oxyServices && unpopulatedActorIds.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  const filteredNotifications = useMemo(() => {
    if (activeTab === 'all') return allNotifications;
    const types = TAB_TYPES[activeTab];
    return allNotifications.filter((n) => types.includes(n.type));
  }, [allNotifications, activeTab]);

  // Per-tab unread tallies, derived from the notifications already loaded (the
  // only per-type data the client has — the server exposes a single aggregate
  // unread total, which the `all` tab uses verbatim).
  const tabUnreadCounts = useMemo<TabUnreadCounts>(() => {
    const counts: TabUnreadCounts = { mentions: 0, follows: 0, likes: 0, posts: 0, pokes: 0 };
    for (const n of allNotifications) {
      if (n.read) continue;
      for (const tab of Object.keys(TAB_TYPES) as FilterableTab[]) {
        if (TAB_TYPES[tab].includes(n.type)) counts[tab] += 1;
      }
    }
    return counts;
  }, [allNotifications]);

  const groupedNotifications = useMemo(() => {
    return groupNotifications(filteredNotifications);
  }, [filteredNotifications]);

  const listItems = useMemo(() => {
    const seen = new Set<string>();
    const out: GroupedNotification[] = [];
    for (const it of groupedNotifications) {
      const k = it.key;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(it);
      }
    }
    return out;
  }, [groupedNotifications]);

  // Section the (already newest-first) rows into Today / This week / Earlier by
  // inserting a header item at each bucket boundary. A header is only emitted
  // when its bucket actually has a row, so an empty bucket leaves no orphan
  // heading. Grouping/dedup above is untouched — this is a presentation layer.
  const sectionedItems = useMemo<NotificationListItem[]>(() => {
    const sectionLabels: Record<TimeBucket, string> = {
      today: t('notification.section.today', { defaultValue: 'Today' }),
      this_week: t('notification.section.this_week', { defaultValue: 'This week' }),
      earlier: t('notification.section.earlier', { defaultValue: 'Earlier' }),
    };
    const now = new Date();
    const out: NotificationListItem[] = [];
    let currentBucket: TimeBucket | null = null;
    for (const item of listItems) {
      const bucket = timeBucketOf(item.createdAt, now);
      if (bucket !== currentBucket) {
        currentBucket = bucket;
        out.push({ kind: 'header', key: `section:${bucket}`, label: sectionLabels[bucket] });
      }
      out.push({ kind: 'row', ...item });
    }
    return out;
  }, [listItems, t]);

  const handleBoundaryError = useCallback((error: Error, errorInfo: React.ErrorInfo) => {
    recoverChunkError(error);
    notificationLogger.error('Error caught by boundary', error, { errorInfo });
  }, []);

  const renderNotification = useCallback(
    (item: NotificationListItem) => {
      if (item.kind === 'header') {
        return (
          <View className="px-3 pb-1 pt-3">
            <Text className="text-muted-foreground text-[13px] font-semibold uppercase leading-6">
              {item.label}
            </Text>
          </View>
        );
      }
      return (
        <ErrorBoundary
          title={t('error.boundary.title')}
          message={t('error.boundary.message')}
          retryLabel={t('error.boundary.retry')}
          onError={handleBoundaryError}
        >
          <NotificationItem
            item={item}
            onMarkAsRead={handleMarkAsRead}
            onDelete={handleDelete}
            captureIntent={captureIntent}
            isCurrentIntent={isCurrentIntent}
          />
        </ErrorBoundary>
      );
    },
    [t, handleBoundaryError, handleMarkAsRead, handleDelete, captureIntent, isCurrentIntent],
  );

  const emptyStateConfig = useMemo((): {
    title: string;
    subtitle: string;
    sticker: EmptyStateStickerName;
  } => {
    switch (activeTab) {
      case 'mentions':
        return {
          title: t('notification.empty.mentions.title', { defaultValue: 'No mentions yet' }),
          subtitle: t('notification.empty.mentions.subtitle', {
            defaultValue: 'When someone mentions you, it will appear here.',
          }),
          sticker: 'notificationsMentions',
        };
      case 'follows':
        return {
          title: t('notification.empty.follows.title', { defaultValue: 'No new followers' }),
          subtitle: t('notification.empty.follows.subtitle', {
            defaultValue: 'When someone follows you, it will appear here.',
          }),
          sticker: 'notificationsFollows',
        };
      case 'likes':
        return {
          title: t('notification.empty.likes.title', { defaultValue: 'No likes yet' }),
          subtitle: t('notification.empty.likes.subtitle', {
            defaultValue: 'When someone likes or boosts your content, it will appear here.',
          }),
          sticker: 'notificationsLikes',
        };
      case 'posts':
        return {
          title: t('notification.empty.posts.title', { defaultValue: 'No post updates' }),
          subtitle: t('notification.empty.posts.subtitle', {
            defaultValue: 'When people you follow post something new, it will appear here.',
          }),
          sticker: 'notificationsPosts',
        };
      case 'pokes':
        return {
          title: t('notification.empty.pokes.title', { defaultValue: 'No pokes yet' }),
          subtitle: t('notification.empty.pokes.subtitle', {
            defaultValue:
              'When someone pokes you, it will appear here. Poke your followers to get started!',
          }),
          sticker: 'notificationsPokes',
        };
      default:
        return {
          title: t('notification.empty.title', { defaultValue: "You're all caught up" }),
          subtitle: t('notification.empty.subtitle', {
            defaultValue: 'We will let you know when something new happens.',
          }),
          sticker: 'notificationsAll',
        };
    }
  }, [activeTab, t]);

  const renderEmptyState = useCallback(
    () => (
      <EmptyState
        title={emptyStateConfig.title}
        subtitle={emptyStateConfig.subtitle}
        sticker={emptyStateConfig.sticker}
      />
    ),
    [emptyStateConfig],
  );

  const renderErrorState = () => (
    <ErrorDisplay
      title={t('notification.error.load', { defaultValue: 'Failed to load notifications' })}
      message={t('notification.error.message', {
        defaultValue: 'Unable to fetch your notifications. Please try again.',
      })}
      onRetry={() => {
        refetch();
      }}
      hideBackButton={true}
      style={{ flex: 1 }}
    />
  );

  const renderContent = () => {
    // Auth cold-boot: the SSO restore can take several seconds. Show a
    // skeleton until auth is resolved, then either prompt to sign in or
    // render the list — gated on `canUsePrivateApi`, never bare
    // `isAuthenticated` (pattern from settings/fediverse/index.tsx).
    if (!isAuthResolved || isPrivateApiPending) {
      return <NotificationSkeleton />;
    }

    if (!canUsePrivateApi) {
      return (
        <OxyAuthPrompt
          label={t('notification.signInRequired', {
            defaultValue: 'Sign in to see your notifications',
          })}
          description={t('notification.signInRequiredDesc', {
            defaultValue: 'Mentions, follows, likes, and more will appear here once you sign in.',
          })}
        />
      );
    }

    if (isLoading && !refreshing) {
      return (
        <View className="flex-1">
          <NotificationSkeleton />
        </View>
      );
    }

    if (error && !notificationsData) {
      return renderErrorState();
    }

    const pokesHeader =
      activeTab === 'pokes' ? (
        <TouchableOpacity
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 16,
            paddingVertical: 14,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.border,
            gap: 12,
          }}
          onPress={() => router.push('/notifications/pokes')}
          activeOpacity={0.7}
        >
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              backgroundColor: theme.colors.primary,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <RiHand width={18} height={18} fill="#fff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text className="leading-6 text-foreground" style={{ fontSize: 15, fontWeight: '600' }}>
              {t('pokes.seeAllPokes', { defaultValue: 'Poke back & discover people' })}
            </Text>
            <Text
              className="leading-6 text-muted-foreground"
              style={{ fontSize: 13, marginTop: 1 }}
            >
              {t('pokes.seeAllPokesSubtitle', {
                defaultValue: 'Suggested follows, poke history & more',
              })}
            </Text>
          </View>
          <RiArrowRightSLine size="md" fill={theme.colors.textSecondary} />
        </TouchableOpacity>
      ) : null;

    return (
      <NotificationsList
        restorationKey={JSON.stringify([...viewerQueryKeys.notifications(user?.id), activeTab])}
        items={sectionedItems}
        renderRow={renderNotification}
        header={pokesHeader}
        emptyState={renderEmptyState()}
        tabKey={activeTab}
        refreshing={refreshing}
        onRefresh={handleRefresh}
        onEndReached={handleLoadMore}
        hasMore={!!hasNextPage}
        isFetchingMore={isFetchingNextPage}
      />
    );
  };

  return (
    <>
      <SEO title={t('seo.notifications.title')} description={t('seo.notifications.description')} />
      <Screen
        reselect={{ refresh: handleRefresh }}
        scroll="auto"
        header={
          <PageHeader
            title={t('Notifications')}
            presentation="floating"
            actions={
              <>
                {unreadCount > 0 ? (
                  <Button
                    appearance="subtle"
                    tone="neutral"
                    iconOnly
                    icon={<RiCheckDoubleLine width={20} height={20} fill={theme.colors.primary} />}
                    onPress={handleMarkAllAsRead}
                    disabled={markAllAsReadMutation.isPending}
                    accessibilityLabel={t('notification.mark_all_read')}
                  />
                ) : null}
                <Button
                  appearance="subtle"
                  tone="neutral"
                  iconOnly
                  icon={<RiNotification3Fill width={20} height={20} fill={theme.colors.text} />}
                  onPress={() => requestSettings('/settings/notifications/subscriptions')}
                  accessibilityLabel={t('subscription.list.title', {
                    defaultValue: 'Activity notifications',
                  })}
                />
                <Button
                  appearance="subtle"
                  tone="neutral"
                  iconOnly
                  icon={<RiSettings3Line width={20} height={20} fill={theme.colors.text} />}
                  onPress={() => requestSettings('/settings/notifications')}
                  accessibilityLabel={t('notification.settings', {
                    defaultValue: 'Notification settings',
                  })}
                />
              </>
            }
          />
        }
      >
        {canUsePrivateApi && (
          <Tabs
            value={activeTab}
            onValueChange={handleTabPress}
            pressOpenTab="reselect"
            variant="underline"
          >
            {[
              { id: 'all', label: t('notifications.tabs.all'), count: unreadCount },
              {
                id: 'mentions',
                label: t('notifications.tabs.mentions'),
                count: tabUnreadCounts.mentions,
              },
              {
                id: 'follows',
                label: t('notifications.tabs.follows'),
                count: tabUnreadCounts.follows,
              },
              {
                id: 'likes',
                label: t('notifications.tabs.likes'),
                count: tabUnreadCounts.likes,
              },
              {
                id: 'posts',
                label: t('notifications.tabs.posts'),
                count: tabUnreadCounts.posts,
              },
              {
                id: 'pokes',
                label: t('notifications.tabs.pokes', { defaultValue: 'Pokes' }),
                count: tabUnreadCounts.pokes,
              },
            ].map((tab: { id: string; label: string; count?: number }) => (
              <TabsTrigger key={tab.id} value={tab.id} label={tab.label} count={tab.count} />
            ))}
          </Tabs>
        )}

        {renderContent()}
      </Screen>
    </>
  );
};

export default NotificationsScreen;
