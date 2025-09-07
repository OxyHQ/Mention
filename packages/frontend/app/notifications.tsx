import React, { useState, useCallback } from 'react';
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

const NotificationsScreen: React.FC = () => {
    const { user, isAuthenticated } = useOxy();
    const queryClient = useQueryClient();
    const [refreshing, setRefreshing] = useState(false);

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
            'Mark All as Read',
            'Are you sure you want to mark all notifications as read?',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Mark All',
                    onPress: () => markAllAsReadMutation.mutate()
                },
            ]
        );
    }, [markAllAsReadMutation]);

    const unreadCount = notificationsData?.unreadCount || 0;

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
            <ThemedText style={styles.emptyTitle}>No notifications yet</ThemedText>
            <ThemedText style={styles.emptySubtitle}>
                When someone interacts with your posts, you&apos;ll see them here.
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
            <ThemedText style={styles.errorTitle}>Unable to load notifications</ThemedText>
            <TouchableOpacity style={styles.retryButton} onPress={() => refetch()}>
                <ThemedText style={styles.retryText}>Try Again</ThemedText>
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
                            Please sign in to view notifications
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
                        title: 'Notifications',
                        headerShown: true,
                        headerRight: () => (
                            unreadCount > 0 ? (
                                <TouchableOpacity
                                    style={styles.markAllButton}
                                    onPress={handleMarkAllAsRead}
                                    disabled={markAllAsReadMutation.isPending}
                                >
                                    <ThemedText style={styles.markAllText}>
                                        Mark all read
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
                    <LegendList
                        data={notificationsData?.notifications || []}
                        keyExtractor={(item: any) => (item.id || item._id || item._id_str || item._id?.toString() || item.username || JSON.stringify(item)).toString()}
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
                            (!notificationsData?.notifications ||
                                notificationsData.notifications.length === 0)
                                ? styles.emptyListContainer
                                : undefined
                        }
                        recycleItems={true}
                        maintainVisibleContentPosition={true}
                    />
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
});

export default NotificationsScreen;
