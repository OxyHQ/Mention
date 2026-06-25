import React, { useState, useCallback, useMemo } from 'react';
import {
    View,
    TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from '@/lib/SafeAreaViewInterop';
import { Ionicons } from '@expo/vector-icons';
import FontAwesome5 from '@expo/vector-icons/FontAwesome5';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useAuth } from '@oxyhq/services';
import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/ThemedView';
import { Loading } from '@oxyhq/bloom/loading';
import { NotificationItem } from '@/components/NotificationItem';
import { ErrorBoundary } from '@oxyhq/bloom/error-boundary';
import { createScopedLogger } from '@/lib/logger';
import { notificationService } from '@/services/notificationService';
import { useTranslation } from 'react-i18next';
import { useRealtimeNotifications } from '@/hooks/useRealtimeNotifications';
import { validateNotifications } from '@/types/validation';
import { normalizeApiError } from '@/utils/apiError';
import { useTheme } from '@oxyhq/bloom/theme';
import { groupNotifications, GroupedNotification } from '@/utils/groupNotifications';
import { GroupedNotificationItem } from '@/components/GroupedNotificationItem';
import { NotificationsList } from '@/components/NotificationsList';
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
import { PanelStickyHeader } from '@/components/shell/PanelChrome';

const notificationLogger = createScopedLogger('Notifications');

type NotificationTab = 'all' | 'mentions' | 'follows' | 'likes' | 'posts' | 'pokes';

const NotificationsScreen: React.FC = () => {
    const { user, isAuthenticated } = useAuth();
    const queryClient = useQueryClient();
    const router = useRouter();
    const [refreshing, setRefreshing] = useState(false);
    const { t } = useTranslation();
    const theme = useTheme();
    const [activeTab, setActiveTab] = useState<NotificationTab>('all');
    // `scrollToTop` is platform-aware: web scrolls the document, native scrolls
    // the registered FlashList (the NotificationsList registers itself).
    const { scrollToTop } = useLayoutScroll();

    // Enable real-time notifications
    useRealtimeNotifications();

    // Fetch notifications
    const {
        data: notificationsData,
        isLoading,
        error,
        refetch
    } = useQuery({
        queryKey: ['notifications', user?.id],
        queryFn: () => notificationService.getNotifications(),
        enabled: isAuthenticated && !!user?.id,
    });

    // Mark notification as read mutation
    const markAsReadMutation = useMutation({
        mutationFn: (notificationId: string) =>
            notificationService.markAsRead(notificationId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['notifications'] });
        },
        onError: (error: unknown) => {
            notificationLogger.error('Error marking notification as read', { error });
            toast(t('notification.mark_read_error') || 'Failed to mark notification as read', { type: 'error' });
        },
    });

    // Mark all as read mutation
    const markAllAsReadMutation = useMutation({
        mutationFn: async () => {
            const result = await notificationService.markAllAsRead();
            return result;
        },
        onSuccess: async () => {
            try {
                queryClient.invalidateQueries({ queryKey: ['notifications'] });
                await refetch();
                toast(t('notification.mark_all_read_success') || 'All notifications marked as read', { type: 'success' });
            } catch (refetchError) {
                notificationLogger.error('Error refetching notifications', { error: refetchError });
                toast(t('notification.mark_all_read_success') || 'All notifications marked as read', { type: 'success' });
            }
        },
        onError: (error: unknown) => {
            const { status: statusCode, message: errorMessage } = normalizeApiError(error);
            notificationLogger.error('Error marking all notifications as read', { error, statusCode });
            toast(
                t('notification.mark_all_read_error') ||
                `Failed to mark all notifications as read${statusCode ? ` (${statusCode})` : ''}: ${errorMessage}`,
                { type: 'error' }
            );
        },
    });

    const handleRefresh = useCallback(async () => {
        setRefreshing(true);
        await refetch();
        setRefreshing(false);
    }, [refetch]);

    const handleMarkAsRead = useCallback((notificationId: string) => {
        markAsReadMutation.mutate(notificationId);
    }, [markAsReadMutation]);

    const unreadCount = notificationsData?.unreadCount || 0;

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
        () => validateNotifications(notificationsData?.notifications ?? []),
        [notificationsData]
    );

    const filteredNotifications = useMemo(() => {
        switch (activeTab) {
            case 'mentions':
                return validatedNotifications.filter((n) => n.type === 'mention' || n.type === 'reply');
            case 'follows':
                return validatedNotifications.filter((n) => n.type === 'follow');
            case 'likes':
                return validatedNotifications.filter((n) => n.type === 'like' || n.type === 'boost' || n.type === 'quote');
            case 'posts':
                return validatedNotifications.filter((n) => n.type === 'post');
            case 'pokes':
                return validatedNotifications.filter((n) => n.type === 'poke');
            default:
                return validatedNotifications;
        }
    }, [validatedNotifications, activeTab]);

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

    const handleBoundaryError = useCallback((error: Error, errorInfo: React.ErrorInfo) => {
        notificationLogger.error('Error caught by boundary', { error, errorInfo });
    }, []);

    const renderNotification = useCallback((item: GroupedNotification) => (
        <ErrorBoundary
            title={t("error.boundary.title")}
            message={t("error.boundary.message")}
            retryLabel={t("error.boundary.retry")}
            onError={handleBoundaryError}
        >
            {item.isGroup ? (
                <GroupedNotificationItem
                    group={item}
                    onMarkAsRead={handleMarkAsRead}
                />
            ) : (
                <NotificationItem
                    notification={item.leadNotification}
                    onMarkAsRead={handleMarkAsRead}
                />
            )}
        </ErrorBoundary>
    ), [t, handleBoundaryError, handleMarkAsRead]);

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
        if (!isAuthenticated) {
            return (
                <ThemedView className="flex-1 justify-center items-center px-5">
                    <ThemedText className="text-base text-center text-muted-foreground">
                        {t('state.no_session')}
                    </ThemedText>
                </ThemedView>
            );
        }

        if (isLoading && !refreshing) {
            return (
                <ThemedView className="flex-1 justify-center items-center">
                    <Loading className="text-primary" size="large" />
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
                items={listItems}
                renderRow={renderNotification}
                header={pokesHeader}
                emptyState={renderEmptyState()}
                tabKey={activeTab}
                refreshing={refreshing}
                onRefresh={handleRefresh}
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
                                            <Ionicons
                                                name="checkmark-done-outline"
                                                size={22}
                                                color={theme.colors.primary}
                                            />
                                        </IconButton>
                                    ) : null,
                                ].filter(Boolean),
                            }}
                            hideBottomBorder={isAuthenticated}
                            disableSticky
                        />
                    </PanelStickyHeader>

                    {isAuthenticated && (
                        <PanelStickyHeader level={1} zIndex={100}>
                            <AnimatedTabBar
                                tabs={[
                                    { id: 'all', label: t('notifications.tabs.all') },
                                    { id: 'mentions', label: t('notifications.tabs.mentions') },
                                    { id: 'follows', label: t('notifications.tabs.follows') },
                                    { id: 'likes', label: t('notifications.tabs.likes') },
                                    { id: 'posts', label: t('notifications.tabs.posts') },
                                    { id: 'pokes', label: t('notifications.tabs.pokes', { defaultValue: 'Pokes' }) },
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
