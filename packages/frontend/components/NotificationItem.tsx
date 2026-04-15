import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { confirmDialog } from '@/utils/alerts';
import { PressableScale } from '@/lib/animations/PressableScale';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];
import { ThemedText } from './ThemedText';
import { useTranslation } from 'react-i18next';
import { useNotificationTransformer, RawNotification } from '../utils/notificationTransformer';
import { useAuth } from '@oxyhq/services';
import { Avatar } from '@oxyhq/bloom/avatar';

import PostItem from './Feed/PostItem';
import { usePostsStore } from '../stores/postsStore';
import { ZEmbeddedPost } from '../types/validation';
import { useUsersStore } from '@/stores/usersStore';
import { cn } from '@/lib/utils';
import { logger } from '@/lib/logger';
import { formatRelativeTimeLocalized } from '@/utils/dateUtils';

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
    const [actorAvatar, setActorAvatar] = useState<string | undefined>(() => {
        const populated = (notification as any)?.actorId_populated;
        return populated?.avatar;
    });

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
                setActorAvatar((cachedUser as any)?.avatar);
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
                    setActorAvatar(profile?.avatar);
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

    const getNotificationIcon = (type: string): IoniconName => {
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
                return '#22c55e';
            case 'reply':
                return '#f59e0b';
            case 'mention':
                return '#005c67';
            case 'follow':
                return '#005c67';
            case 'post':
                return '#005c67';
            case 'poke':
                return '#f59e0b';
            default:
                return '#005c67';
        }
    };

    const handlePress = useCallback(() => {
        // Mark as read if not already read
        if (!notification.read) {
            onMarkAsRead(notification._id);
        }

        // Navigate based on notification type and entity
        if (notification.entityType === 'post' || notification.entityType === 'reply') {
            router.push(`/p/${String(notification.entityId)}`);
        } else if (notification.entityType === 'profile') {
            const rawActor = notification.actorId;
            const id = typeof rawActor === 'string'
                ? rawActor
                : (rawActor && typeof rawActor === 'object' && '_id' in rawActor ? String((rawActor as { _id?: unknown })._id ?? '') : '');
            const cachedUser = id ? useUsersStore.getState().getCachedById(id) : undefined;
            const uname = cachedUser?.username || '';
            if (uname) {
                router.push(`/@${uname}`);
            } else if (id) {
                router.push(`/${id}`);
            }
        }
    }, [notification, onMarkAsRead, router]);

    const handleLongPress = useCallback(async () => {
        const confirmed = await confirmDialog({
            title: t('notification.options.title'),
            message: t('notification.options.message'),
            okText: 'Mark as Read',
            cancelText: 'Cancel',
        });
        if (confirmed) {
            onMarkAsRead(notification._id);
        }
    }, [notification._id, onMarkAsRead]);

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
        <PressableScale
            className={cn("border-border", !notification.read && "bg-primary/5")}
            style={styles.container}
            onPress={handlePress}
            onLongPress={handleLongPress}
        >
            <View style={styles.avatarContainer}>
                <Avatar source={actorAvatar} size={40} />
                <View className="border-background" style={[styles.actionBadge, { backgroundColor: getNotificationColor(notification.type) }]}>
                    <Ionicons name={getNotificationIcon(notification.type)} size={12} color="#fff" />
                </View>
            </View>

            <View style={styles.contentContainer}>
                <ThemedText
                    className={cn("text-muted-foreground", !notification.read && "text-foreground")}
                    style={[
                        styles.message,
                        !notification.read && styles.unreadText,
                    ]}
                    numberOfLines={2}
                >
                    {buildTitle(notification.type, actorName)}
                </ThemedText>

                <ThemedText className="text-muted-foreground" style={styles.timestamp}>
                    {formatRelativeTimeLocalized(notification.createdAt, t)}
                </ThemedText>
            </View>

            {!notification.read && (
                <View className="bg-primary" style={styles.unreadIndicator} />
            )}
        </PressableScale>
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
    const embedded = (notification as any).post ? ZEmbeddedPost.safeParse((notification as any).post) : null;
    const [post, setPost] = useState<any>(embedded?.success ? embedded.data : null);
    const [loading, setLoading] = useState(!(notification as any).post);

    useEffect(() => {
        if ((notification as any).post) return; // Backend provided embedded post
        const loadPost = async () => {
            try {
                if (notification.entityId && notification.entityType === 'post') {
                    const postData = await getPostById(String(notification.entityId));
                    setPost(postData);
                }
            } catch (error) {
                logger.error('Error loading post for notification');
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
            <View
                className={cn("border-border", !notification.read && "bg-primary/5")}
                style={styles.container}
            >
                <View style={styles.avatarContainer}>
                    <Avatar size={40} />
                    <View className="bg-primary border-background" style={styles.actionBadge}>
                        <Ionicons name="create" size={12} color="#fff" />
                    </View>
                </View>
                <View style={styles.contentContainer}>
                    <ThemedText className="text-muted-foreground" style={styles.message}>Loading post...</ThemedText>
                </View>
            </View>
        );
    }

    if (!post) {
        return (
            <PressableScale
                className={cn("border-border", !notification.read && "bg-primary/5")}
                style={styles.container}
                onPress={handleNotificationPress}
            >
                <View style={styles.avatarContainer}>
                    <Avatar size={40} />
                    <View className="bg-primary border-background" style={styles.actionBadge}>
                        <Ionicons name="create" size={12} color="#fff" />
                    </View>
                </View>
                <View style={styles.contentContainer}>
                    <ThemedText
                        className={cn("text-muted-foreground", !notification.read && "text-foreground")}
                        style={[
                            styles.message,
                            !notification.read && styles.unreadText,
                        ]}
                    >
                        {t('notification.post', { actorName, defaultValue: `${actorName} posted a new update` })}
                    </ThemedText>
                    <ThemedText className="text-muted-foreground" style={styles.timestamp}>
                        {formatRelativeTimeLocalized(notification.createdAt, t)}
                    </ThemedText>
                </View>
                {!notification.read && <View className="bg-primary" style={styles.unreadIndicator} />}
            </PressableScale>
        );
    }

    return (
        <PressableScale
            className={cn("border-border", !notification.read && "bg-primary/5")}
            style={styles.postNotificationContainer}
            onPress={handleNotificationPress}
            targetScale={0.99}
        >
            <View className="bg-surface" style={styles.postContainer}>
                <PostItem
                    post={post}
                    isNested={false}
                    style={styles.nestedPost}
                />
            </View>
        </PressableScale>
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
    avatarContainer: {
        position: 'relative',
        marginRight: 12,
    },
    actionBadge: {
        position: 'absolute',
        bottom: -2,
        right: -2,
        width: 20,
        height: 20,
        borderRadius: 10,
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 2,
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
