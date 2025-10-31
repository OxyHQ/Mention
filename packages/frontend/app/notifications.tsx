import React, { useState, useCallback, useMemo } from 'react';
import {
    View,
    StyleSheet,
    TouchableOpacity,
    RefreshControl,
    Alert,
} from 'react-native';
import LegendList from '../components/LegendList';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
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

const NotificationsScreen: React.FC = () => {
    const { user, isAuthenticated } = useOxy();
    const queryClient = useQueryClient();
    const [refreshing, setRefreshing] = useState(false);
    const { t } = useTranslation();
    const theme = useTheme();
    const [category, setCategory] = useState<'all' | 'mentions' | 'follows' | 'likes' | 'posts'>('all');

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
        onError: (error) => {
            console.error('Error marking notification as read:', error);
            Alert.alert('Error', 'Failed to mark notification as read');
        },
    });

    // Mark all as read mutation
    const markAllAsReadMutation = useMutation({
        mutationFn: () => notificationService.markAllAsRead(),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['notifications'] });
        },
        onError: (error) => {
            console.error('Error marking all notifications as read:', error);
            Alert.alert('Error', 'Failed to mark all notifications as read');
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

    const handleMarkAllAsRead = useCallback(() => {
        Alert.alert(
            t('notification.mark_all_read'),
            t('notification.mark_all_read'),
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: t('notification.mark_all_read'),
                    onPress: () => markAllAsReadMutation.mutate()
                },
            ]
        );
    }, [markAllAsReadMutation, t]);

    const unreadCount = notificationsData?.unreadCount || 0;

    const filteredNotifications = useMemo(() => {
        const raw: any[] = notificationsData?.notifications || [];
        const list: TRawNotification[] = validateNotifications(raw);
        switch (category) {
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
    }, [notificationsData, category]);

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

    if (!isAuthenticated) {
        return (
            <SafeAreaView edges={['top']}>
                <View style={styles.container}>
                    <Stack.Screen
                        options={{
                            title: 'Notifications',
                            headerShown: true,
                        }}
                    />
                    <ThemedView style={styles.authContainer}>
                        <ThemedText style={[styles.authText, { color: theme.colors.textSecondary }]}>
                            {t('state.no_session')}
                        </ThemedText>
                    </ThemedView>
                </View>
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView edges={['top']}>
            <ThemedView style={styles.container}>
                <Stack.Screen
                    options={{
                        title: t('Notifications'),
                        headerRight: () => (
                            unreadCount > 0 ? (
                                <TouchableOpacity
                                    style={styles.markAllButton}
                                    onPress={handleMarkAllAsRead}
                                    disabled={markAllAsReadMutation.isPending}
                                >
                                    <ThemedText style={[styles.markAllText, { color: theme.colors.primary }]}>
                                        {t('notification.mark_all_read')}
                                    </ThemedText>
                                </TouchableOpacity>
                            ) : null
                        ),
                    }}
                />

                {isLoading && !refreshing ? (
                    <ThemedView style={styles.loadingContainer}>
                        <LoadingSpinner />
                    </ThemedView>
                ) : error ? (
                    renderErrorState()
                ) : (
                    <>
                        <ChipsRow
                            category={category}
                            onChange={setCategory}
                        />
                        {(!listItems || listItems.length === 0) ? (
                            renderEmptyState()
                        ) : (
                            <LegendList
                                data={listItems}
                                keyExtractor={(item: any) => getItemKey(item)}
                                renderItem={renderNotification}
                                refreshControl={
                                    <RefreshControl
                                        refreshing={refreshing}
                                        onRefresh={handleRefresh}
                                        tintColor={theme.colors.primary}
                                    />
                                }
                                removeClippedSubviews={false}
                                maxToRenderPerBatch={10}
                                windowSize={10}
                                initialNumToRender={10}
                                recycleItems={true}
                                maintainVisibleContentPosition={true}
                            />
                        )}
                    </>
                )}
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
    emptyListContainer: {
        flexGrow: 1,
    },
    chipsContainer: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderBottomWidth: 1,
    },
    chipsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    chip: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 16,
    },
    chipActive: {
        borderWidth: 1,
    },
    chipText: {
        fontSize: 13,
        fontWeight: '600',
    },
    chipTextActive: {
    },
});

export default NotificationsScreen;

// Category chips component
const ChipsRow: React.FC<{
    category: 'all' | 'mentions' | 'follows' | 'likes' | 'posts';
    onChange: (c: 'all' | 'mentions' | 'follows' | 'likes' | 'posts') => void
}> = ({ category, onChange }) => {
    const { t } = useTranslation();
    const theme = useTheme();
    const tabs: { key: 'all' | 'mentions' | 'follows' | 'likes' | 'posts'; label: string }[] = [
        { key: 'all', label: t('notifications.tabs.all') },
        { key: 'mentions', label: t('notifications.tabs.mentions') },
        { key: 'follows', label: t('notifications.tabs.follows') },
        { key: 'likes', label: t('notifications.tabs.likes') },
        { key: 'posts', label: t('notifications.tabs.posts') },
    ];
    return (
        <View style={[styles.chipsContainer, { borderBottomColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }]}>
            <View style={styles.chipsRow}>
                {tabs.map(tab => {
                    const active = category === tab.key;
                    return (
                        <TouchableOpacity key={tab.key}
                            style={[
                                styles.chip,
                                { backgroundColor: theme.isDark ? 'rgba(255,255,255,0.1)' : '#E1E8ED' },
                                active && { backgroundColor: `${theme.colors.primary}15`, borderWidth: 1, borderColor: theme.colors.primary }
                            ]}
                            onPress={() => onChange(tab.key)}
                        >
                            <ThemedText style={[styles.chipText, active && { color: theme.colors.primary }]}>
                                {tab.label}
                            </ThemedText>
                        </TouchableOpacity>
                    );
                })}
            </View>
        </View>
    );
};
