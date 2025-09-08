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
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import { ThemedText } from '../components/ThemedText';
import { ThemedView } from '../components/ThemedView';
import { colors } from '../styles/colors';
import LoadingSpinner from '../components/LoadingSpinner';
import { NotificationItem } from '../components/NotificationItem';
import { notificationService } from '../services/notificationService';
import { useTranslation } from 'react-i18next';
import { useRealtimeNotifications } from '../hooks/useRealtimeNotifications';

const NotificationsScreen: React.FC = () => {
    const { user, isAuthenticated } = useOxy();
    const queryClient = useQueryClient();
    const [refreshing, setRefreshing] = useState(false);
    const { t } = useTranslation();
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
        const list = notificationsData?.notifications || [];
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
        <NotificationItem
            notification={item}
            onMarkAsRead={handleMarkAsRead}
        />
    );

    const renderEmptyState = () => (
        <ThemedView style={styles.emptyContainer}>
            <Ionicons
                name="notifications-off-outline"
                size={64}
                color={colors.COLOR_BLACK_LIGHT_4}
            />
            <ThemedText style={styles.emptyTitle}>{t('notification.empty.title')}</ThemedText>
            <ThemedText style={styles.emptySubtitle}>
                {t('notification.empty.subtitle')}
            </ThemedText>
        </ThemedView>
    );

    const renderErrorState = () => (
        <ThemedView style={styles.errorContainer}>
            <Ionicons
                name="alert-circle-outline"
                size={64}
                color={colors.busy}
            />
            <ThemedText style={styles.errorTitle}>{t('notification.error.load')}</ThemedText>
            <TouchableOpacity style={styles.retryButton} onPress={() => refetch()}>
                <ThemedText style={styles.retryText}>{t('notification.retry')}</ThemedText>
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
                        <ThemedText style={styles.authText}>
                            {t('state.no_session')}
                        </ThemedText>
                    </ThemedView>
                </View>
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView edges={['top']}>
            <View style={styles.container}>
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
                                    <ThemedText style={styles.markAllText}>
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
                    <LegendList
                        data={listItems}
                        keyExtractor={(item: any) => getItemKey(item)}
                        renderItem={renderNotification}
                        ListEmptyComponent={renderEmptyState}
                        refreshControl={
                            <RefreshControl
                                refreshing={refreshing}
                                onRefresh={handleRefresh}
                                tintColor={colors.primaryColor}
                            />
                        }
                        contentContainerStyle={
                            (!listItems || listItems.length === 0)
                                ? styles.emptyListContainer
                                : undefined
                        }
                        recycleItems={true}
                        maintainVisibleContentPosition={true}
                    />
                    </>
                )}
            </View>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.COLOR_BLACK_LIGHT_9,
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
        color: colors.COLOR_BLACK_LIGHT_4,
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
    },
    emptyTitle: {
        fontSize: 20,
        fontWeight: '600',
        marginTop: 16,
        marginBottom: 8,
        textAlign: 'center',
    },
    emptySubtitle: {
        fontSize: 16,
        textAlign: 'center',
        color: colors.COLOR_BLACK_LIGHT_4,
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
        color: colors.busy,
    },
    retryButton: {
        paddingHorizontal: 20,
        paddingVertical: 10,
        backgroundColor: colors.primaryColor,
        borderRadius: 8,
        marginTop: 16,
    },
    retryText: {
        color: 'white',
        fontSize: 16,
        fontWeight: '600',
    },
    markAllButton: {
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
    markAllText: {
        fontSize: 14,
        color: colors.primaryColor,
        fontWeight: '500',
    },
    emptyListContainer: {
        flexGrow: 1,
    },
    chipsContainer: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
        backgroundColor: colors.COLOR_BLACK_LIGHT_9,
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
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
    },
    chipActive: {
        backgroundColor: colors.primaryLight,
        borderWidth: 1,
        borderColor: colors.primaryColor,
    },
    chipText: {
        color: colors.COLOR_BLACK_LIGHT_2,
        fontSize: 13,
        fontWeight: '600',
    },
    chipTextActive: {
        color: colors.primaryColor,
    },
});

export default NotificationsScreen;

// Category chips component
const ChipsRow: React.FC<{ 
    category: 'all' | 'mentions' | 'follows' | 'likes' | 'posts'; 
    onChange: (c: 'all' | 'mentions' | 'follows' | 'likes' | 'posts') => void 
}> = ({ category, onChange }) => {
    const tabs: { key: 'all' | 'mentions' | 'follows' | 'likes' | 'posts'; label: string }[] = [
        { key: 'all', label: 'All' },
        { key: 'mentions', label: 'Mentions' },
        { key: 'follows', label: 'Follows' },
        { key: 'likes', label: 'Likes' },
        { key: 'posts', label: 'Posts' },
    ];
    return (
        <View style={styles.chipsContainer}>
            <View style={styles.chipsRow}>
                {tabs.map(tab => {
                    const active = category === tab.key;
                    return (
                        <TouchableOpacity key={tab.key} 
                            style={[styles.chip, active && styles.chipActive]} 
                            onPress={() => onChange(tab.key)}
                        >
                            <ThemedText style={[styles.chipText, active && styles.chipTextActive]}>
                                {tab.label}
                            </ThemedText>
                        </TouchableOpacity>
                    );
                })}
            </View>
        </View>
    );
};
