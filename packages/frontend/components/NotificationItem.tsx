import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { ThemedText } from './ThemedText';
import { colors } from '../styles/colors';
import { useTranslation } from 'react-i18next';
import { useNotificationTransformer, RawNotification } from '../utils/notificationTransformer';
import { useOxy } from '@oxyhq/services';

interface NotificationItemProps {
    notification: RawNotification;
    onMarkAsRead: (notificationId: string) => void;
}

export const NotificationItem: React.FC<NotificationItemProps> = ({
    notification,
    onMarkAsRead,
}) => {
    const router = useRouter();
    const { t } = useTranslation();
    const { transformSingleNotification } = useNotificationTransformer();
    const { oxyServices } = useOxy();

    // Transform the raw notification data
    const transformedNotification = transformSingleNotification(notification);

    // Module-local cache of actorId -> display name to avoid repeated calls
    const actorCacheRef = useRef<Map<string, { name: string; avatar?: string }>>(new Map());

    const initialName = useMemo(() => {
        const n = transformedNotification.actorName || '';
        // If initial name looks like an Oxy ID (24-hex) or equals raw actorId, we'll try to resolve it
        const looksLikeId = typeof notification.actorId === 'string' && /^[a-fA-F0-9]{24}$/.test(notification.actorId);
        if (!n || n === notification.actorId || looksLikeId) return '';
        return n;
    }, [notification.actorId, transformedNotification.actorName]);

    const [actorName, setActorName] = useState<string>(initialName);

    useEffect(() => {
        let cancelled = false;
        const id = typeof notification.actorId === 'string' ? notification.actorId : notification.actorId?._id;
        if (!id || actorName) return; // nothing to resolve

        // Check cache first
        const cached = actorCacheRef.current!.get(id);
        if (cached) {
            setActorName(cached.name);
            return;
        }

        const resolve = async () => {
            try {
                if (!oxyServices) return;
                let profile: any = null;

                // Try common method names safely
                const svc: any = oxyServices as any;
                if (typeof svc.getProfileById === 'function') {
                    profile = await svc.getProfileById(id);
                } else if (typeof svc.getProfile === 'function') {
                    profile = await svc.getProfile(id);
                } else if (typeof svc.getUserById === 'function') {
                    profile = await svc.getUserById(id);
                } else if (typeof svc.getUser === 'function') {
                    profile = await svc.getUser(id);
                } else {
                    // No by-id lookup available; give up quietly
                    return;
                }

                const displayName = profile?.name?.full || profile?.name || profile?.username || id;
                if (!cancelled && displayName) {
                    actorCacheRef.current!.set(id, { name: displayName, avatar: profile?.avatar });
                    setActorName(displayName);
                }
            } catch {
                // Fallback: keep id or existing
            }
        };

        resolve();
        return () => { cancelled = true; };
    }, [actorName, notification.actorId, oxyServices]);

    const buildTitle = useCallback((type: string, name: string) => {
        const display = name || transformedNotification.actorName || 'Someone';
        switch (type) {
            case 'like':
                return t('notification.like', { actorName: display });
            case 'reply':
                return t('notification.reply', { actorName: display });
            case 'mention':
                return t('notification.mention', { actorName: display });
            case 'follow':
                return t('notification.follow', { actorName: display });
            case 'repost':
                return t('notification.repost', { actorName: display });
            case 'quote':
                return t('notification.quote', { actorName: display });
            case 'welcome':
                return t('notification.welcome.title');
            default:
                return t('notification.like', { actorName: display });
        }
    }, [t, transformedNotification.actorName]);

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

        if (diffInSeconds < 60) return t('notification.now');
        if (diffInSeconds < 3600) return t('notification.minutes_ago', { count: Math.floor(diffInSeconds / 60) });
        if (diffInSeconds < 86400) return t('notification.hours_ago', { count: Math.floor(diffInSeconds / 3600) });
        if (diffInSeconds < 604800) return t('notification.days_ago', { count: Math.floor(diffInSeconds / 86400) });
        return date.toLocaleDateString();
    };

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
                    {buildTitle(notification.type, actorName)}
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
