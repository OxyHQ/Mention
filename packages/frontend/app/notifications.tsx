import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
    View,
    StyleSheet,
    TouchableOpacity,
    RefreshControl,
    Platform,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { NoUpdatesIllustration } from '../assets/illustrations/NoUpdates';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import { ThemedText } from '../components/ThemedText';
import { ThemedView } from '../components/ThemedView';
import { colors } from '../styles/colors';
import LoadingSpinner from '../components/LoadingSpinner';
import { NotificationItem } from '../components/NotificationItem';
import ErrorBoundary from '../components/ErrorBoundary';
import { notificationService } from '../services/notificationService';
import { useTranslation } from 'react-i18next';
import { useRealtimeNotifications } from '../hooks/useRealtimeNotifications';
import { validateNotifications, TRawNotification } from '../types/validation';
import { useTheme } from '../hooks/useTheme';
import { useLayoutScroll } from '../context/LayoutScrollContext';
import AnimatedTabBar from '../components/common/AnimatedTabBar';
import { Header } from '../components/Header';
import { StatusBar } from 'expo-status-bar';
import { toast } from 'sonner';
import { confirmDialog } from '../utils/alerts';

type NotificationTab = 'all' | 'mentions' | 'follows' | 'likes' | 'posts';

const NotificationsScreen: React.FC = () => {
    const { user, isAuthenticated } = useOxy();
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
                // Invalidate all notification queries first
                queryClient.invalidateQueries({ queryKey: ['notifications'] });
                
                // Use the refetch function from useQuery hook
                await refetch();
                
                toast.success(t('notification.mark_all_read_success') || 'All notifications marked as read');
            } catch (refetchError) {
                console.error('Error refetching notifications:', refetchError);
                // Still show success since the API call succeeded
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
        // If pressing the same tab - scroll to top and refresh
        if (tabId === activeTab) {
            setRefreshKey(prev => prev + 1);
            // Scroll to top
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
            // Different tab - switch
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

    // Ensure unique items by a stable key to prevent overlapping keys in LegendList
    const getItemKey = useCallback((item: any) => {
        return String(
            item?._id || item?.id || item?.notificationId || `${item?.entityId || ''}:${item?.type || ''}:${item?.createdAt || ''}`
        );
    }, []);

    const listItems = useMemo(() => {
        const seen = new Set<string>();
        const out: any[] = [];
        for (const it of filteredNotifications) {
            const k = getItemKey(it);
            if (!seen.has(k)) {
                seen.add(k);
                out.push(it);
            }
        }
        return out;
    }, [filteredNotifications, getItemKey]);

    // Register scrollable with LayoutScrollContext
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

    // Handle scroll events
    const handleScrollEvent = useCallback((event: any) => {
        if (handleScroll) {
            handleScroll(event);
        }
    }, [handleScroll]);

    // Handle wheel events
    const handleWheelEvent = useCallback((event: any) => {
        if (forwardWheelEvent) {
            forwardWheelEvent(event);
        }
    }, [forwardWheelEvent]);

    // Web-specific dataSet for scroll detection
    const dataSetForWeb = useMemo(() => {
        if (Platform.OS !== 'web') return undefined;
        return { layoutscroll: 'true' };
    }, []);

    const renderNotification = ({ item }: { item: any }) => (
        <ErrorBoundary>
            <NotificationItem
                notification={item}
                onMarkAsRead={handleMarkAsRead}
            />
        </ErrorBoundary>
    );

    const renderEmptyState = () => (
        <ThemedView style={styles.emptyContainer}>
            <View style={styles.illustrationWrap}>
                <NoUpdatesIllustration width={200} height={200} />
            </View>
            <ThemedText style={styles.emptyTitle}>{t('notification.empty.title')}</ThemedText>
            <ThemedText style={[styles.emptySubtitle, { color: theme.colors.textSecondary }]}>
                {t('notification.empty.subtitle')}
            </ThemedText>
        </ThemedView>
    );

    const renderErrorState = () => (
        <ThemedView style={styles.errorContainer}>
            <Ionicons
                name="alert-circle-outline"
                size={64}
                color={theme.colors.error}
            />
            <ThemedText style={[styles.errorTitle, { color: theme.colors.error }]}>{t('notification.error.load')}</ThemedText>
            <TouchableOpacity style={[styles.retryButton, { backgroundColor: theme.colors.primary }]} onPress={() => refetch()}>
                <ThemedText style={[styles.retryText, { color: theme.colors.card }]}>{t('notification.retry')}</ThemedText>
            </TouchableOpacity>
        </ThemedView>
    );

    const renderContent = () => {
        if (!isAuthenticated) {
            return (
                <ThemedView style={styles.authContainer}>
                    <ThemedText style={[styles.authText, { color: theme.colors.textSecondary }]}>
                        {t('state.no_session')}
                    </ThemedText>
                </ThemedView>
            );
        }

        if (isLoading && !refreshing) {
            return (
                <ThemedView style={styles.loadingContainer}>
                    <LoadingSpinner />
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
        <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={["top"]}>
            <ThemedView style={{ flex: 1 }}>
                <StatusBar style={theme.isDark ? "light" : "dark"} />

                {/* Header */}
                <Header
                    options={{
                        title: t('Notifications'),
                        rightComponents: [
                            unreadCount > 0 ? (
                                <TouchableOpacity
                                    key="mark-all"
                                    style={styles.headerButton}
                                    onPress={handleMarkAllAsRead}
                                    disabled={markAllAsReadMutation.isPending}
                                >
                                    <ThemedText style={[styles.markAllText, { color: theme.colors.primary }]}>
                                        {t('notification.mark_all_read')}
                                    </ThemedText>
                                </TouchableOpacity>
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
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    authContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 20,
    },
    authText: {
        fontSize: 16,
        textAlign: 'center',
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 40,
        gap: 12,
    },
    illustrationWrap: {
        width: 220,
        height: 220,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyTitle: {
        fontSize: 20,
        fontWeight: '600',
        textAlign: 'center',
    },
    emptySubtitle: {
        fontSize: 16,
        textAlign: 'center',
        lineHeight: 24,
    },
    errorContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 40,
    },
    errorTitle: {
        fontSize: 20,
        fontWeight: '600',
        marginTop: 16,
        marginBottom: 16,
        textAlign: 'center',
    },
    retryButton: {
        paddingHorizontal: 20,
        paddingVertical: 10,
        borderRadius: 8,
        marginTop: 16,
    },
    retryText: {
        fontSize: 16,
        fontWeight: '600',
    },
    markAllButton: {
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
    markAllText: {
        fontSize: 14,
        fontWeight: '500',
    },
    headerButton: {
        padding: 8,
        marginLeft: 8,
    },
});

export default NotificationsScreen;
