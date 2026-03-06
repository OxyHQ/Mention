import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { ThemedText } from './ThemedText';
import { colors } from '../styles/colors';
import { useTranslation } from 'react-i18next';
import { useNotificationTransformer, RawNotification } from '../utils/notificationTransformer';
import { useAuth } from '@oxyhq/services';
import PostItem from './Feed/PostItem';
import { usePostsStore } from '../stores/postsStore';
import { ZEmbeddedPost } from '../types/validation';
import { useUsersStore } from '@/stores/usersStore';
import { useTheme } from '@/hooks/useTheme';

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
    const { oxyServices } = useAuth();
    const theme = useTheme();

    // Transform the raw notification data
    const transformedNotification = transformSingleNotification(notification);

    // Prime the users cache with any populated actor object present on the notification
    useEffect(() => {
        try {
            const populated = (notification as any)?.actorId_populated;
            const id = typeof notification.actorId === 'string' ? notification.actorId : (notification.actorId as any)?._id;
            if (populated && (id || populated.id || populated._id)) {
                const merged = { id: String(id || populated.id || populated._id), ...(populated as any) };
                useUsersStore.getState().upsertUser(merged);
            }
        } catch { }
    }, [notification]);

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
        const id = typeof notification.actorId === 'string' ? notification.actorId : (notification.actorId as any)?._id;
        if (!id || actorName) return; // nothing to resolve

        // Try the shared users cache first for immediate value
        try {
            const cachedUser = useUsersStore.getState().getCachedById(String(id));
            if (cachedUser?.name || cachedUser?.username) {
                const displayName = (cachedUser as any)?.name?.full || (cachedUser as any)?.name || cachedUser.username || String(id);
                setActorName(String(displayName));
                actorCacheRef.current!.set(String(id), { name: String(displayName), avatar: (cachedUser as any)?.avatar });
                return;
            }
        } catch { }

        // Otherwise ensure by ID via oxy services, then populate cache
        const resolve = async () => {
            try {
                if (!oxyServices) return;
                const svc: any = oxyServices as any;
                const loader = (actorId: string) => {
                    if (typeof svc.getProfileById === 'function') return svc.getProfileById(actorId);
                    if (typeof svc.getProfile === 'function') return svc.getProfile(actorId);
                    if (typeof svc.getUserById === 'function') return svc.getUserById(actorId);
                    if (typeof svc.getUser === 'function') return svc.getUser(actorId);
                    return Promise.resolve(null);
                };
                const ensured = await useUsersStore.getState().ensureById(String(id), loader);
                const profile: any = ensured || null;
                const displayName = profile?.name?.full || profile?.name || profile?.username || String(id);
                if (!cancelled && displayName) {
                    actorCacheRef.current!.set(String(id), { name: String(displayName), avatar: profile?.avatar });
                    setActorName(String(displayName));
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
            case 'post':
                // Use i18n key when available with a sensible default
                return t('notification.post', { actorName: display, defaultValue: `${display} posted a new update` });
            case 'poke':
                return t('notification.poke', { actorName: display });
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
                return 'chatbubble-ellipses';
            case 'follow':
                return 'person-add';
            case 'repost':
                return 'repeat';
            case 'quote':
                return 'chatbox-ellipses';
            case 'post':
                return 'create';
            case 'poke':
                return 'hand-left';
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
            case 'post':
                return colors.primaryColor;
            case 'poke':
                return colors.away;
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
            const id = typeof notification.actorId === 'string' ? notification.actorId : (notification.actorId as any)?._id;
            let uname = '';
            try {
                if (id) uname = useUsersStore.getState().usersById[String(id)]?.data?.username || '';
            } catch { }
            const path = uname ? `/@${uname}` : `/${id}`;
            router.push(path);
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

    // For 'post' notifications, use PostItem component for rich UI
    if (notification.type === 'post') {
        return <PostNotificationItem
            notification={notification}
            actorName={actorName}
            onMarkAsRead={onMarkAsRead}
            handlePress={handlePress}
        />;
    }

    return (
        <TouchableOpacity
            style={[
                styles.container,
                { borderBottomColor: theme.colors.border },
                !notification.read && [styles.unreadContainer, { backgroundColor: `${theme.colors.primary}08` }]
            ]}
            onPress={handlePress}
            onLongPress={handleLongPress}
        >
            <View style={[styles.iconContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
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
                        { color: theme.colors.textSecondary },
                        !notification.read && [styles.unreadText, { color: theme.colors.text }]
                    ]}
                    numberOfLines={2}
                >
                    {buildTitle(notification.type, actorName)}
                </ThemedText>

                <ThemedText style={[styles.timestamp, { color: theme.colors.textTertiary }]}>
                    {formatTimeAgo(notification.createdAt)}
                </ThemedText>
            </View>

            {!notification.read && (
                <View style={[styles.unreadIndicator, { backgroundColor: theme.colors.primary }]} />
            )}
        </TouchableOpacity>
    );
};

// Component for post notifications using PostItem
const PostNotificationItem: React.FC<{
    notification: RawNotification;
    actorName: string;
    onMarkAsRead: (id: string) => void;
    handlePress: () => void;
}> = ({ notification, actorName, onMarkAsRead, handlePress }) => {
    const { t } = useTranslation();
    const { getPostById } = usePostsStore();
    const theme = useTheme();
    const embedded = (notification as any).post ? ZEmbeddedPost.safeParse((notification as any).post) : null;
    const [post, setPost] = useState<any>(embedded?.success ? embedded.data : null);
    const [loading, setLoading] = useState(!(notification as any).post);

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

    useEffect(() => {
        if ((notification as any).post) return; // Backend provided embedded post
        const loadPost = async () => {
            try {
                if (notification.entityId && notification.entityType === 'post') {
                    const postData = await getPostById(notification.entityId);
                    setPost(postData);
                }
            } catch (error) {
                console.error('Error loading post for notification:', error);
            } finally {
                setLoading(false);
            }
        };

        loadPost();
    }, [notification, notification.entityId, notification.entityType, getPostById]);

    const handleNotificationPress = useCallback(() => {
        if (!notification.read) {
            onMarkAsRead(notification._id);
        }
        handlePress();
    }, [notification.read, notification._id, onMarkAsRead, handlePress]);

    if (loading) {
        return (
            <View style={[
                styles.container,
                { borderBottomColor: theme.colors.border },
                !notification.read && [styles.unreadContainer, { backgroundColor: `${theme.colors.primary}08` }]
            ]}>
                <View style={[styles.iconContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
                    <Ionicons name="create" size={20} color={theme.colors.primary} />
                </View>
                <View style={styles.contentContainer}>
                    <ThemedText style={[styles.message, { color: theme.colors.textSecondary }]}>Loading post...</ThemedText>
                </View>
            </View>
        );
    }

    if (!post) {
        return (
            <TouchableOpacity
                style={[
                    styles.container,
                    { borderBottomColor: theme.colors.border },
                    !notification.read && [styles.unreadContainer, { backgroundColor: `${theme.colors.primary}08` }]
                ]}
                onPress={handleNotificationPress}
            >
                <View style={[styles.iconContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
                    <Ionicons name="create" size={20} color={theme.colors.primary} />
                </View>
                <View style={styles.contentContainer}>
                    <ThemedText style={[
                        styles.message,
                        { color: theme.colors.textSecondary },
                        !notification.read && [styles.unreadText, { color: theme.colors.text }]
                    ]}>
                        {t('notification.post', { actorName, defaultValue: `${actorName} posted a new update` })}
                    </ThemedText>
                    <ThemedText style={[styles.timestamp, { color: theme.colors.textTertiary }]}>
                        {formatTimeAgo(notification.createdAt)}
                    </ThemedText>
                </View>
                {!notification.read && <View style={[styles.unreadIndicator, { backgroundColor: theme.colors.primary }]} />}
            </TouchableOpacity>
        );
    }

    return (
        <TouchableOpacity
            style={[
                styles.postNotificationContainer,
                { borderBottomColor: theme.colors.border },
                !notification.read && [styles.unreadContainer, { backgroundColor: `${theme.colors.primary}08` }]
            ]}
            onPress={handleNotificationPress}
            activeOpacity={0.95}
        >
            <View style={[styles.postContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
                <PostItem
                    post={post}
                    isNested={false}
                    style={styles.nestedPost}
                />
            </View>
        </TouchableOpacity>
    );
};

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        backgroundColor: 'transparent',
    },
    unreadContainer: {
    },
    iconContainer: {
        width: 40,
        height: 40,
        borderRadius: 20,
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
    },
    unreadText: {
        fontWeight: '700',
    },
    message: {
        fontSize: 14,
        lineHeight: 18,
        marginBottom: 4,
    },
    preview: {
        fontSize: 13,
        lineHeight: 18,
        marginBottom: 4,
    },
    postNotificationContainer: {
        backgroundColor: 'transparent',
        borderBottomWidth: 1,
    },
    notificationHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    notificationText: {
        fontSize: 13,
        flex: 1,
        marginLeft: 8,
    },
    notificationTime: {
        fontSize: 11,
        marginLeft: 8,
    },
    smallUnreadIndicator: {
        width: 6,
        height: 6,
        borderRadius: 3,
        marginLeft: 8,
    },
    postContainer: {
    },
    nestedPost: {
        borderBottomWidth: 0,
        marginTop: 0,
    },
    timestamp: {
        fontSize: 12,
    },
    unreadIndicator: {
        width: 8,
        height: 8,
        borderRadius: 4,
        alignSelf: 'center',
    },
});
