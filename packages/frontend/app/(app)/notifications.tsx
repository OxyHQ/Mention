import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
    View,
    RefreshControl,
    Platform,
    TouchableOpacity,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { SafeAreaView } from 'react-native-safe-area-context';
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
import { validateNotifications, TRawNotification } from '@/types/validation';
import { useTheme } from '@oxyhq/bloom/theme';
import { groupNotifications, GroupedNotification } from '@/utils/groupNotifications';
import { GroupedNotificationItem } from '@/components/GroupedNotificationItem';
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
    const listRef = useRef<any>(null);
    const unregisterScrollableRef = useRef<(() => void) | null>(null);
    const { handleScroll, scrollEventThrottle, registerScrollable, forwardWheelEvent } = useLayoutScroll();

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
        onError: (error: any) => {
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
        onError: (error: any) => {
            notificationLogger.error('Error marking all notifications as read', { error, statusCode: error?.response?.status });
            const errorMessage = error?.response?.data?.message || error?.message || 'Unknown error';
            const statusCode = error?.response?.status;
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
            if (listRef.current) {
                try {
                    if (typeof listRef.current.scrollToOffset === 'function') {
                        listRef.current.scrollToOffset({ offset: 0, animated: true });
                    } else if (typeof listRef.current.scrollTo === 'function') {
                        listRef.current.scrollTo({ y: 0, animated: true });
                    }
                } catch { /* scroll errors are non-critical */ }
            }
        } else {
            setActiveTab(tab);
        }
    }, [activeTab, refetch]);

    const validatedNotifications = useMemo(() => {
        const raw: any[] = notificationsData?.notifications || [];
        return validateNotifications(raw);
    }, [notificationsData]);

    const filteredNotifications = useMemo(() => {
        switch (activeTab) {
            case 'mentions':
                return validatedNotifications.filter((n: any) => n.type === 'mention' || n.type === 'reply');
            case 'follows':
                return validatedNotifications.filter((n: any) => n.type === 'follow');
            case 'likes':
                return validatedNotifications.filter((n: any) => n.type === 'like' || n.type === 'repost' || n.type === 'quote');
            case 'posts':
                return validatedNotifications.filter((n: any) => n.type === 'post');
            case 'pokes':
                return validatedNotifications.filter((n: any) => n.type === 'poke');
            default:
                return validatedNotifications;
        }
    }, [validatedNotifications, activeTab]);

    const groupedNotifications = useMemo(() => {
        return groupNotifications(filteredNotifications);
    }, [filteredNotifications]);

    const getItemKey = useCallback((item: GroupedNotification) => item.key, []);

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

    const clearScrollableRegistration = useCallback(() => {
        if (unregisterScrollableRef.current) {
            unregisterScrollableRef.current();
            unregisterScrollableRef.current = null;
        }
    }, []);

    const assignListRef = useCallback((node: any) => {
        listRef.current = node;
        clearScrollableRegistration();
        if (node) {
            unregisterScrollableRef.current = registerScrollable(node);
        }
    }, [clearScrollableRegistration, registerScrollable]);

    useEffect(() => {
        if (listRef.current && !unregisterScrollableRef.current) {
            unregisterScrollableRef.current = registerScrollable(listRef.current);
        }
    }, [registerScrollable]);

    useEffect(() => () => {
        clearScrollableRegistration();
    }, [clearScrollableRegistration]);

    const handleScrollEvent = useCallback((event: any) => {
        if (handleScroll) {
            handleScroll(event);
        }
    }, [handleScroll]);

    const handleWheelEvent = useCallback((event: any) => {
        if (forwardWheelEvent) {
            forwardWheelEvent(event);
        }
    }, [forwardWheelEvent]);

    const dataSetForWeb = useMemo(() => {
        if (Platform.OS !== 'web') return undefined;
        return { layoutscroll: 'true' };
    }, []);

    const handleBoundaryError = useCallback((error: Error, errorInfo: React.ErrorInfo) => {
        notificationLogger.error('Error caught by boundary', { error, errorInfo });
    }, []);

    const renderNotification = ({ item }: { item: GroupedNotification }) => (
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
    );

    const emptyStateConfig = useMemo(() => {
        const iconBg = theme.colors.surfaceSecondary ?? `${theme.colors.border}33`;
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
                    subtitle: t('notification.empty.likes.subtitle', { defaultValue: 'When someone likes or reposts your content, it will appear here.' }),
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
            onRetry={() => refetch()}
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

        return (
            <View
                style={{ flex: 1, minHeight: 0 }}
                {...(Platform.OS === 'web' && dataSetForWeb ? { 'data-layoutscroll': 'true' } : {})}
            >
                <FlashList
                    ref={assignListRef}
                    data={listItems}
                    keyExtractor={getItemKey}
                    renderItem={renderNotification}
                    estimatedItemSize={120}
                    getItemType={(item) => item.type}
                    overrideItemLayout={(_, __, layout) => {
                        layout.size = 120;
                    }}
                    ListHeaderComponent={activeTab === 'pokes' ? (
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
                            onPress={() => router.push('/notifications/pokes' as any)}
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
                    ) : undefined}
                    ListEmptyComponent={renderEmptyState}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={handleRefresh}
                            colors={[theme.colors.primary]}
                            tintColor={theme.colors.primary}
                        />
                    }
                    showsVerticalScrollIndicator={false}
                    onScroll={handleScrollEvent}
                    scrollEventThrottle={scrollEventThrottle}
                    onWheel={Platform.OS === 'web' ? handleWheelEvent : undefined}
                    contentContainerStyle={{
                        backgroundColor: theme.colors.background,
                    }}
                    style={{
                        flex: 1,
                        backgroundColor: theme.colors.background,
                    }}
                    drawDistance={400}
                    key={`notifications-${activeTab}`}
                />
            </View>
        );
    };

    return (
        <>
            <SEO
                title={t('seo.notifications.title')}
                description={t('seo.notifications.description')}
            />
            <SafeAreaView className="flex-1 bg-background" edges={["top"]}>
                <ThemedView className="flex-1">
                    <StatusBar style={theme.isDark ? "light" : "dark"} />

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
                    />

                    {isAuthenticated && (
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
                    )}

                    {renderContent()}
                </ThemedView>
            </SafeAreaView>
        </>
    );
};

export default NotificationsScreen;
