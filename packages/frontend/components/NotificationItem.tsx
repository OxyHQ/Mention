import React, { useCallback } from 'react';
import { View, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { ThemedText } from './ThemedText';
import { colors } from '../styles/colors';
import { Notification } from '@mention/shared-types';

// Extended interface for backend notification structure
interface BackendNotification {
    _id: string;
    recipientId: string;
    actorId: string;
    type: string;
    entityId: string;
    entityType: string;
    read: boolean;
    createdAt: string;
    updatedAt: string;
    actorId_populated?: {
        _id: string;
        username: string;
        name: string;
        avatar?: string;
    };
}

interface NotificationItemProps {
    notification: BackendNotification;
    onMarkAsRead: (notificationId: string) => void;
}

export const NotificationItem: React.FC<NotificationItemProps> = ({
    notification,
    onMarkAsRead,
}) => {
    const router = useRouter();

    const getNotificationIcon = (type: string): string => {
        switch (type) {
            case 'like':
                return 'heart';
            case 'reply':
                return 'chatbubble';
            case 'mention':
                return 'at';
            case 'follow':
                return 'person-add';
            case 'repost':
                return 'repeat';
            case 'quote':
                return 'quote';
            case 'welcome':
                return 'notifications';
            default:
                return 'notifications';
        }
    };

    const getNotificationColor = (type: string): string => {
        switch (type) {
            case 'like':
                return colors.online;
            case 'reply':
                return colors.away;
            case 'mention':
                return colors.primaryColor;
            case 'follow':
                return colors.primaryColor;
            default:
                return colors.primaryColor;
        }
    };

    const getNotificationMessage = (type: string, actorName?: string): string => {
        const name = actorName || 'Someone';
        switch (type) {
            case 'like':
                return `${name} liked your post`;
            case 'reply':
                return `${name} replied to your post`;
            case 'mention':
                return `${name} mentioned you`;
            case 'follow':
                return `${name} started following you`;
            case 'repost':
                return `${name} reposted your post`;
            case 'quote':
                return `${name} quoted your post`;
            case 'welcome':
                return 'Welcome to Mention!';
            default:
                return 'You have a new notification';
        }
    };

    const handlePress = useCallback(() => {
        // Mark as read if not already read
        if (!notification.read) {
            onMarkAsRead(notification._id);
        }

        // Navigate based on notification type and entity
        if (notification.entityType === 'post' || notification.entityType === 'reply') {
            router.push(`/p/${notification.entityId}`);
        } else if (notification.entityType === 'profile') {
            router.push(`/${notification.actorId}`);
        }
    }, [notification, onMarkAsRead, router]);

    const handleLongPress = useCallback(() => {
        Alert.alert(
            'Notification Options',
            'What would you like to do?',
            [
                {
                    text: 'Mark as Read',
                    onPress: () => onMarkAsRead(notification._id),
                    style: 'default'
                },
                {
                    text: 'Cancel',
                    style: 'cancel'
                }
            ]
        );
    }, [notification._id, onMarkAsRead]);

    const formatTimeAgo = (dateString: string): string => {
        const now = new Date();
        const date = new Date(dateString);
        const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

        if (diffInSeconds < 60) return 'now';
        if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m`;
        if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h`;
        if (diffInSeconds < 604800) return `${Math.floor(diffInSeconds / 86400)}d`;
        return date.toLocaleDateString();
    };

    const actorName = notification.actorId_populated?.name ||
        notification.actorId_populated?.username ||
        'Someone';

    return (
        <TouchableOpacity
            style={[
                styles.container,
                !notification.read && styles.unreadContainer
            ]}
            onPress={handlePress}
            onLongPress={handleLongPress}
        >
            <View style={styles.iconContainer}>
                <Ionicons
                    name={getNotificationIcon(notification.type) as any}
                    size={20}
                    color={getNotificationColor(notification.type)}
                />
            </View>

            <View style={styles.contentContainer}>
                <ThemedText
                    style={[
                        styles.message,
                        !notification.read && styles.unreadText
                    ]}
                    numberOfLines={2}
                >
                    {getNotificationMessage(notification.type, actorName)}
                </ThemedText>

                <ThemedText style={styles.timestamp}>
                    {formatTimeAgo(notification.createdAt)}
                </ThemedText>
            </View>

            {!notification.read && (
                <View style={styles.unreadIndicator} />
            )}
        </TouchableOpacity>
    );
};

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
        backgroundColor: 'transparent',
    },
    unreadContainer: {
        backgroundColor: colors.primaryLight_1,
    },
    iconContainer: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: 12,
    },
    contentContainer: {
        flex: 1,
    },
    title: {
        fontSize: 14,
        fontWeight: '600',
        marginBottom: 2,
        color: colors.COLOR_BLACK_LIGHT_2,
    },
    unreadText: {
        color: colors.COLOR_BLACK,
        fontWeight: '700',
    },
    message: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
        lineHeight: 18,
        marginBottom: 4,
    },
    timestamp: {
        fontSize: 12,
        color: colors.COLOR_BLACK_LIGHT_5,
    },
    unreadIndicator: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: colors.primaryColor,
        alignSelf: 'center',
    },
});
