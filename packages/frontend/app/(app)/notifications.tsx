import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
    View,
    RefreshControl,
    Platform,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/ThemedView';
import { Loading } from '@/components/ui/Loading';
import { NotificationItem } from '@/components/NotificationItem';
import ErrorBoundary from '@/components/ErrorBoundary';
import { notificationService } from '@/services/notificationService';
import { useTranslation } from 'react-i18next';
import { useRealtimeNotifications } from '@/hooks/useRealtimeNotifications';
import { validateNotifications, TRawNotification } from '@/types/validation';
import { useTheme } from '@/hooks/useTheme';
import { groupNotifications, GroupedNotification } from '@/utils/groupNotifications';
import { GroupedNotificationItem } from '@/components/GroupedNotificationItem';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import AnimatedTabBar from '@/components/common/AnimatedTabBar';
import { Header } from '@/components/Header';
import { StatusBar } from 'expo-status-bar';
import { toast } from 'sonner';
import { confirmDialog } from '@/utils/alerts';
import SEO from '@/components/SEO';
import { IconButton } from '@/components/ui/Button';
import { Error } from '@/components/Error';
import { EmptyState } from '@/components/common/EmptyState';
import { Bell } from '@/assets/icons/bell-icon';

type NotificationTab = 'all' | 'mentions' | 'follows' | 'likes' | 'posts';

const NotificationsScreen: React.FC = () => {
    const { user, isAuthenticated } = useAuth();
    const queryClient = useQueryClient();
    const [refreshing, setRefreshing] = useState(false);
    const { t } = useTranslation();
    const theme = useTheme();
    const [activeTab, setActiveTab] = useState<NotificationTab>('all');
    const [refreshKey, setRefreshKey] = useState(0);
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
            console.error('Error marking notification as read:', error);
            toast.error(t('notification.mark_read_error') || 'Failed to mark notification as read');
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
                toast.success(t('notification.mark_all_read_success') || 'All notifications marked as read');
            } catch (refetchError) {
                console.error('Error refetching notifications:', refetchError);
                toast.success(t('notification.mark_all_read_success') || 'All notifications marked as read');
            }
        },
        onError: (error: any) => {
            console.error('Error marking all notifications as read:', error);
            console.error('Full error object:', JSON.stringify(error, null, 2));
            const errorMessage = error?.response?.data?.message || error?.message || 'Unknown error';
            const statusCode = error?.response?.status;
            toast.error(
                t('notification.mark_all_read_error') ||
                `Failed to mark all notifications as read${statusCode ? ` (${statusCode})` : ''}: ${errorMessage}`
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
            toast.info(t('notification.all_already_read') || 'All notifications are already read');
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

    const handleTabPress = useCallback((tabId: NotificationTab) => {
        if (tabId === activeTab) {
            setRefreshKey(prev => prev + 1);
            if (listRef.current) {
                try {
                    if (typeof listRef.current.scrollToOffset === 'function') {
                        listRef.current.scrollToOffset({ offset: 0, animated: true });
                    } else if (typeof listRef.current.scrollTo === 'function') {
                        listRef.current.scrollTo({ y: 0, animated: true });
                    }
                } catch (error) {
                    // Ignore scroll errors
                }
            }
        } else {
            setActiveTab(tabId);
            setRefreshKey(prev => prev + 1);
        }
    }, [activeTab]);

    const filteredNotifications = useMemo(() => {
        const raw: any[] = notificationsData?.notifications || [];
        const list: TRawNotification[] = validateNotifications(raw);
        switch (activeTab) {
            case 'mentions':
                return list.filter((n: any) => n.type === 'mention' || n.type === 'reply');
            case 'follows':
                return list.filter((n: any) => n.type === 'follow');
            case 'likes':
                return list.filter((n: any) => n.type === 'like' || n.type === 'repost' || n.type === 'quote');
            case 'posts':
                return list.filter((n: any) => n.type === 'post');
            default:
                return list;
        }
    }, [notificationsData, activeTab]);

    const groupedNotifications = useMemo(() => {
        return groupNotifications(filteredNotifications);
    }, [filteredNotifications]);

    const getItemKey = useCallback((item: GroupedNotification) => {
        return item.key;
    }, []);

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

    const renderNotification = ({ item }: { item: GroupedNotification }) => (
        <ErrorBoundary>
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

    const renderEmptyState = useCallback(() => (
        <EmptyState
            title={t('notification.empty.title', { defaultValue: "You're all caught up" })}
            subtitle={t('notification.empty.subtitle', { defaultValue: 'We will let you know when something new happens.' })}
            customIcon={
                <View
                    style={{
                        width: 72,
                        height: 72,
                        borderRadius: 36,
                        justifyContent: 'center',
                        alignItems: 'center',
                        backgroundColor: theme.colors.surfaceSecondary ?? `${theme.colors.border}33`,
                    }}
                >
                    <Bell color={theme.colors.textSecondary} size={36} />
                </View>
            }
        />
    ), [t, theme]);

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
                    <Loading size="large" />
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
                    keyExtractor={(item: any) => getItemKey(item)}
                    renderItem={renderNotification}
                    estimatedItemSize={100}
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
                    drawDistance={500}
                    key={`notifications-${activeTab}-${refreshKey}`}
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

                    {/* Header */}
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

                    {/* Tab Navigation */}
                    {isAuthenticated && (
                        <AnimatedTabBar
                            tabs={[
                                { id: 'all', label: t('notifications.tabs.all') },
                                { id: 'mentions', label: t('notifications.tabs.mentions') },
                                { id: 'follows', label: t('notifications.tabs.follows') },
                                { id: 'likes', label: t('notifications.tabs.likes') },
                                { id: 'posts', label: t('notifications.tabs.posts') },
                            ]}
                            activeTabId={activeTab}
                            onTabPress={handleTabPress}
                            scrollEnabled={true}
                        />
                    )}

                    {/* Content */}
                    {renderContent()}
                </ThemedView>
            </SafeAreaView>
        </>
    );
};

export default NotificationsScreen;
