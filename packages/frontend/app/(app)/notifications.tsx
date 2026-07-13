import React, { useState, useCallback, useMemo } from 'react';
import {
    View,
    TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from '@/lib/SafeAreaViewInterop';
import { Ionicons } from '@expo/vector-icons';
import FontAwesome5 from '@expo/vector-icons/FontAwesome5';
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { OxyAuthPrompt, useAuth } from '@oxyhq/services';
import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/ThemedView';
import { Loading } from '@oxyhq/bloom/loading';
import { NotificationItem } from '@/components/notifications/NotificationItem';
import { ErrorBoundary } from '@oxyhq/bloom/error-boundary';
import { createScopedLogger } from '@/lib/logger';
import { notificationService } from '@/services/notificationService';
import { useTranslation } from 'react-i18next';
import { validateNotifications } from '@/types/validation';
import { normalizeApiError } from '@/utils/apiError';
import { useTheme } from '@oxyhq/bloom/theme';
import { groupNotifications, GroupedNotification, NotificationListItem } from '@/utils/groupNotifications';
import { useUnreadCount, unreadCountKey } from '@/hooks/useUnreadCount';
import {
    notificationsKey,
    findNotification,
    markNotificationsRead,
    markAllNotificationsRead,
    removeNotification,
    bumpUnread,
    type NotificationsInfiniteData,
} from '@/utils/notificationCache';
import { NotificationsList } from '@/components/NotificationsList';
import { NotificationSkeleton } from '@/components/notifications/NotificationSkeleton';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import AnimatedTabBar from '@/components/common/AnimatedTabBar';
import { Header } from '@/components/Header';
import { StatusBar } from 'expo-status-bar';
import { show as toast } from '@oxyhq/bloom/toast';
import { confirmDialog } from '@/utils/alerts';
import SEO from '@/components/SEO';
import { IconButton } from '@/components/ui/Button';
import { Error } from '@/components/Error';
import { EmptyState } from '@/components/common/EmptyState';
import { Bell } from '@/assets/icons/bell-icon';
import { DoneAllIcon } from '@/assets/icons/done-all-icon';
import { Gear } from '@/assets/icons/gear-icon';
import { PanelStickyHeader } from '@/components/shell/PanelChrome';
import { prewarmUsersByIds } from '@/utils/userEnrichment';

const notificationLogger = createScopedLogger('Notifications');

type NotificationTab = 'all' | 'mentions' | 'follows' | 'likes' | 'posts' | 'pokes';

/** Time buckets the list is sectioned into, newest first. */
type TimeBucket = 'today' | 'this_week' | 'earlier';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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
    const queryClient = useQueryClient();
    const router = useRouter();
    const [refreshing, setRefreshing] = useState(false);
    const { t } = useTranslation();
    const theme = useTheme();
    const [activeTab, setActiveTab] = useState<NotificationTab>('all');
    // `scrollToTop` is platform-aware: web scrolls the document, native scrolls
    // the registered FlashList (the NotificationsList registers itself).
    const { scrollToTop } = useLayoutScroll();

    // The realtime socket is mounted app-wide via <RealtimeNotificationsBridge/>
    // (a module singleton). This screen must NOT also call
    // useRealtimeNotifications() — a second mount would double every listener.

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
        queryKey: ['notifications', user?.id],
        queryFn: ({ pageParam }) => notificationService.getNotifications(pageParam),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
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
    const notificationsQueryKey = useMemo(() => notificationsKey(user?.id), [user?.id]);

    // Optimistically patch the cached list + badge in place (no invalidate/
    // refetch flicker). The server echo to `user:<id>` reconciles idempotently.
    const applyReadPatch = useCallback((ids: string[]) => {
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
    }, [queryClient, notificationsQueryKey, user?.id]);

    // Mark notification(s) as read — group rows pass every id in the group.
    const markAsReadMutation = useMutation({
        mutationFn: (ids: string[]) => Promise.all(ids.map((id) => notificationService.markAsRead(id))),
        onMutate: (ids: string[]) => applyReadPatch(ids),
        onError: (error: unknown) => {
            notificationLogger.error('Error marking notification as read', { error });
            toast(t('notification.mark_read_error') || 'Failed to mark notification as read', { type: 'error' });
            // Resync from the server on failure to undo the optimistic patch.
            queryClient.invalidateQueries({ queryKey: ['notifications'] });
        },
    });

    // Optimistically drop the given ids from the cached list + decrement the
    // badge for any that were unread (mirrors `applyReadPatch`). The server echo
    // to `user:<id>` reconciles idempotently; `onError` resyncs.
    const applyRemovePatch = useCallback((ids: string[]) => {
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
    }, [queryClient, notificationsQueryKey, user?.id]);

    // Delete notification(s) — group rows pass every id in the group.
    const deleteMutation = useMutation({
        mutationFn: (ids: string[]) => Promise.all(ids.map((id) => notificationService.deleteNotification(id))),
        onMutate: (ids: string[]) => applyRemovePatch(ids),
        onSuccess: () => {
            toast(t('notification.deleted', { defaultValue: 'Notification deleted' }), { type: 'success' });
        },
        onError: (error: unknown) => {
            notificationLogger.error('Error deleting notification', { error });
            toast(t('notification.delete_error', { defaultValue: 'Failed to delete notification' }), { type: 'error' });
            // Resync from the server on failure to undo the optimistic patch.
            queryClient.invalidateQueries({ queryKey: ['notifications'] });
        },
    });

    // Mark all as read mutation
    const markAllAsReadMutation = useMutation({
        mutationFn: () => notificationService.markAllAsRead(),
        onMutate: () => {
            queryClient.setQueryData<NotificationsInfiniteData>(notificationsQueryKey, (data) =>
                data ? markAllNotificationsRead(data) : data,
            );
            queryClient.setQueryData<number>(unreadCountKey(user?.id), 0);
        },
        onSuccess: () => {
            toast(t('notification.mark_all_read_success') || 'All notifications marked as read', { type: 'success' });
        },
        onError: (error: unknown) => {
            const { status: statusCode, message: errorMessage } = normalizeApiError(error);
            notificationLogger.error('Error marking all notifications as read', { error, statusCode });
            toast(
                t('notification.mark_all_read_error') ||
                `Failed to mark all notifications as read${statusCode ? ` (${statusCode})` : ''}: ${errorMessage}`,
                { type: 'error' }
            );
            queryClient.invalidateQueries({ queryKey: ['notifications'] });
        },
    });

    const handleRefresh = useCallback(async () => {
        setRefreshing(true);
        await refetch();
        setRefreshing(false);
    }, [refetch]);

    const handleMarkAsRead = useCallback((ids: string[]) => {
        markAsReadMutation.mutate(ids);
    }, [markAsReadMutation]);

    const handleDelete = useCallback((ids: string[]) => {
        deleteMutation.mutate(ids);
    }, [deleteMutation]);

    const handleMarkAllAsRead = useCallback(async () => {
        if (unreadCount === 0) {
            toast(t('notification.all_already_read') || 'All notifications are already read', { type: 'info' });
            return;
        }

        const confirmed = await confirmDialog({
            title: t('notification.mark_all_read'),
            message: t('notification.mark_all_read_confirm') || 'Are you sure you want to mark all notifications as read?',
            okText: t('notification.mark_all_read') || 'Mark All as Read',
            cancelText: t('cancel') || 'Cancel',
        });

        if (confirmed) {
            markAllAsReadMutation.mutate();
        }
    }, [markAllAsReadMutation, t, unreadCount]);

    const handleTabPress = useCallback((tabId: string) => {
        const tab = tabId as NotificationTab;
        if (tab === activeTab) {
            refetch();
            // Platform-aware: web scrolls the document, native scrolls the
            // registered list back to the top.
            scrollToTop();
        } else {
            setActiveTab(tab);
        }
    }, [activeTab, refetch, scrollToTop]);

    const validatedNotifications = useMemo(
        () => validateNotifications(allNotifications),
        [allNotifications]
    );

    // Notifications whose actor the backend did NOT populate would each fire their
    // own `getProfileById` from inside NotificationItem — an N+1 across the page.
    // Collect those distinct actor ids and warm the React Query user cache with ONE
    // bulk `getUsersByIds`, so every per-row read hits the warm cache instead.
    const unpopulatedActorIds = useMemo(() => {
        const ids = new Set<string>();
        for (const n of validatedNotifications) {
            if (n.actorId_populated) continue;
            const actorId = n.actorId;
            const id = typeof actorId === 'string'
                ? actorId
                : (actorId && typeof actorId === 'object'
                    ? String((actorId as { _id?: unknown; id?: unknown })._id ?? (actorId as { id?: unknown }).id ?? '')
                    : '');
            // Only resolvable Oxy ids (24-hex) — handles/empty fall back to per-row.
            if (id && /^[a-fA-F0-9]{24}$/.test(id)) ids.add(id);
        }
        return Array.from(ids);
    }, [validatedNotifications]);

    useQuery({
        queryKey: ['notifications', 'actorWarm', unpopulatedActorIds],
        queryFn: () => prewarmUsersByIds(unpopulatedActorIds, (ids) => oxyServices.getUsersByIds(ids), queryClient),
        enabled: canUsePrivateApi && !!oxyServices && unpopulatedActorIds.length > 0,
        staleTime: 5 * 60 * 1000,
    });

    const filteredNotifications = useMemo(() => {
        if (activeTab === 'all') return validatedNotifications;
        const types = TAB_TYPES[activeTab];
        return validatedNotifications.filter((n) => types.includes(n.type));
    }, [validatedNotifications, activeTab]);

    // Per-tab unread tallies, derived from the notifications already loaded (the
    // only per-type data the client has — the server exposes a single aggregate
    // unread total, which the `all` tab uses verbatim).
    const tabUnreadCounts = useMemo<TabUnreadCounts>(() => {
        const counts: TabUnreadCounts = { mentions: 0, follows: 0, likes: 0, posts: 0, pokes: 0 };
        for (const n of validatedNotifications) {
            if (n.read) continue;
            for (const tab of Object.keys(TAB_TYPES) as FilterableTab[]) {
                if (TAB_TYPES[tab].includes(n.type)) counts[tab] += 1;
            }
        }
        return counts;
    }, [validatedNotifications]);

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
        notificationLogger.error('Error caught by boundary', { error, errorInfo });
    }, []);

    const renderNotification = useCallback((item: NotificationListItem) => {
        if (item.kind === 'header') {
            return (
                <View className="bg-background px-3 pb-1 pt-3">
                    <ThemedText className="text-muted-foreground text-[13px] font-semibold uppercase">
                        {item.label}
                    </ThemedText>
                </View>
            );
        }
        return (
            <ErrorBoundary
                title={t("error.boundary.title")}
                message={t("error.boundary.message")}
                retryLabel={t("error.boundary.retry")}
                onError={handleBoundaryError}
            >
                <NotificationItem item={item} onMarkAsRead={handleMarkAsRead} onDelete={handleDelete} />
            </ErrorBoundary>
        );
    }, [t, handleBoundaryError, handleMarkAsRead, handleDelete]);

    const emptyStateConfig = useMemo(() => {
        const iconBg = `${theme.colors.border}33`;
        const iconColor = theme.colors.textSecondary;
        switch (activeTab) {
            case 'mentions':
                return {
                    title: t('notification.empty.mentions.title', { defaultValue: 'No mentions yet' }),
                    subtitle: t('notification.empty.mentions.subtitle', { defaultValue: 'When someone mentions you, it will appear here.' }),
                    icon: <Ionicons name="chatbubble-ellipses-outline" size={36} color={iconColor} />,
                    iconBg,
                };
            case 'follows':
                return {
                    title: t('notification.empty.follows.title', { defaultValue: 'No new followers' }),
                    subtitle: t('notification.empty.follows.subtitle', { defaultValue: 'When someone follows you, it will appear here.' }),
                    icon: <Ionicons name="person-add-outline" size={36} color={iconColor} />,
                    iconBg,
                };
            case 'likes':
                return {
                    title: t('notification.empty.likes.title', { defaultValue: 'No likes yet' }),
                    subtitle: t('notification.empty.likes.subtitle', { defaultValue: 'When someone likes or boosts your content, it will appear here.' }),
                    icon: <Ionicons name="heart-outline" size={36} color={iconColor} />,
                    iconBg,
                };
            case 'posts':
                return {
                    title: t('notification.empty.posts.title', { defaultValue: 'No post updates' }),
                    subtitle: t('notification.empty.posts.subtitle', { defaultValue: 'When people you follow post something new, it will appear here.' }),
                    icon: <Ionicons name="create-outline" size={36} color={iconColor} />,
                    iconBg,
                };
            case 'pokes':
                return {
                    title: t('notification.empty.pokes.title', { defaultValue: 'No pokes yet' }),
                    subtitle: t('notification.empty.pokes.subtitle', { defaultValue: 'When someone pokes you, it will appear here. Poke your followers to get started!' }),
                    icon: <FontAwesome5 name="hand-point-right" size={32} color={iconColor} />,
                    iconBg,
                };
            default:
                return {
                    title: t('notification.empty.title', { defaultValue: "You're all caught up" }),
                    subtitle: t('notification.empty.subtitle', { defaultValue: 'We will let you know when something new happens.' }),
                    icon: <Bell color={iconColor} size={36} />,
                    iconBg,
                };
        }
    }, [activeTab, t, theme]);

    const renderEmptyState = useCallback(() => (
        <EmptyState
            title={emptyStateConfig.title}
            subtitle={emptyStateConfig.subtitle}
            customIcon={
                <View
                    style={{
                        width: 72,
                        height: 72,
                        borderRadius: 36,
                        justifyContent: 'center',
                        alignItems: 'center',
                        backgroundColor: emptyStateConfig.iconBg,
                    }}
                >
                    {emptyStateConfig.icon}
                </View>
            }
        />
    ), [emptyStateConfig]);

    const renderErrorState = () => (
        <Error
            title={t('notification.error.load', { defaultValue: 'Failed to load notifications' })}
            message={t('notification.error.message', { defaultValue: 'Unable to fetch your notifications. Please try again.' })}
            onRetry={() => {
                refetch();
            }}
            hideBackButton={true}
            style={{ flex: 1 }}
        />
    );

    const renderContent = () => {
        // Auth cold-boot: the SSO restore can take several seconds. Show a
        // spinner until auth is resolved, then either prompt to sign in or
        // render the list — gated on `canUsePrivateApi`, never bare
        // `isAuthenticated` (pattern from settings/fediverse.tsx).
        if (!isAuthResolved || isPrivateApiPending) {
            return (
                <ThemedView className="flex-1 justify-center items-center">
                    <Loading className="text-primary" size="large" />
                </ThemedView>
            );
        }

        if (!canUsePrivateApi) {
            return (
                <OxyAuthPrompt
                    label={t('notification.signInRequired', { defaultValue: 'Sign in to see your notifications' })}
                    description={t('notification.signInRequiredDesc', { defaultValue: 'Mentions, follows, likes, and more will appear here once you sign in.' })}
                />
            );
        }

        if (isLoading && !refreshing) {
            return (
                <ThemedView className="flex-1">
                    <NotificationSkeleton />
                </ThemedView>
            );
        }

        if (error) {
            return renderErrorState();
        }

        const pokesHeader = activeTab === 'pokes' ? (
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
                    <FontAwesome5 name="hand-point-right" size={18} color="#fff" solid />
                </View>
                <View style={{ flex: 1 }}>
                    <ThemedText style={{ fontSize: 15, fontWeight: '600' }}>
                        {t('pokes.seeAllPokes', { defaultValue: 'Poke back & discover people' })}
                    </ThemedText>
                    <ThemedText className="text-muted-foreground" style={{ fontSize: 13, marginTop: 1 }}>
                        {t('pokes.seeAllPokesSubtitle', { defaultValue: 'Suggested follows, poke history & more' })}
                    </ThemedText>
                </View>
                <Ionicons name="chevron-forward" size={20} color={theme.colors.textSecondary} />
            </TouchableOpacity>
        ) : null;

        return (
            <NotificationsList
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
            <SEO
                title={t('seo.notifications.title')}
                description={t('seo.notifications.description')}
            />
            <SafeAreaView className="flex-1 bg-background" edges={['top']}>
                <ThemedView className="flex-1">
                    <StatusBar style={theme.isDark ? "light" : "dark"} />

                    {/* Header chrome pinned inside the rounded panel via
                        PanelStickyHeader. The notifications list is document-scroll
                        on web (window virtualizer), so the header/tab bar must pin
                        at PANEL_TOP_INSET (not top:0, where the bleed mask would clip
                        them). `disableSticky` hands sticky ownership to
                        PanelStickyHeader. When the tab bar is shown it stacks as
                        level={1} below the header. */}
                    <PanelStickyHeader level={0}>
                        <Header
                            options={{
                                title: t('Notifications'),
                                showBackButton: false,
                                rightComponents: [
                                    unreadCount > 0 ? (
                                        <IconButton variant="icon"
                                            key="mark-all"
                                            onPress={handleMarkAllAsRead}
                                            disabled={markAllAsReadMutation.isPending}
                                            accessibilityLabel={t('notification.mark_all_read')}
                                        >
                                            <DoneAllIcon
                                                size={22}
                                                color={theme.colors.primary}
                                            />
                                        </IconButton>
                                    ) : null,
                                    <IconButton variant="icon"
                                        key="notification-settings"
                                        onPress={() => router.push('/settings/notifications')}
                                        accessibilityLabel={t('notification.settings', { defaultValue: 'Notification settings' })}
                                    >
                                        <Gear
                                            size={22}
                                            color={theme.colors.text}
                                        />
                                    </IconButton>,
                                ].filter(Boolean),
                            }}
                            hideBottomBorder={canUsePrivateApi}
                            disableSticky
                        />
                    </PanelStickyHeader>

                    {canUsePrivateApi && (
                        <PanelStickyHeader level={1} zIndex={100}>
                            <AnimatedTabBar
                                tabs={[
                                    { id: 'all', label: t('notifications.tabs.all'), count: unreadCount },
                                    { id: 'mentions', label: t('notifications.tabs.mentions'), count: tabUnreadCounts.mentions },
                                    { id: 'follows', label: t('notifications.tabs.follows'), count: tabUnreadCounts.follows },
                                    { id: 'likes', label: t('notifications.tabs.likes'), count: tabUnreadCounts.likes },
                                    { id: 'posts', label: t('notifications.tabs.posts'), count: tabUnreadCounts.posts },
                                    { id: 'pokes', label: t('notifications.tabs.pokes', { defaultValue: 'Pokes' }), count: tabUnreadCounts.pokes },
                                ]}
                                activeTabId={activeTab}
                                onTabPress={handleTabPress}
                                scrollEnabled={true}
                            />
                        </PanelStickyHeader>
                    )}

                    {renderContent()}
                </ThemedView>
            </SafeAreaView>
        </>
    );
};

export default NotificationsScreen;
