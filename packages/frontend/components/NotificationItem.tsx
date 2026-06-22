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
import { ZEmbeddedPost, type TEmbeddedPost } from '../types/validation';
import { PostVisibility } from '@mention/shared-types';
import { queryKeys } from '@oxyhq/services';
import type { User } from '@oxyhq/core';
import { queryClient } from '@/lib/queryClient';
import { precacheProfileView } from '@/lib/precacheProfiles';
import { cn } from '@/lib/utils';
import { logger } from '@/lib/logger';
import { formatRelativeTimeLocalized } from '@/utils/dateUtils';

type NotificationPost = React.ComponentProps<typeof PostItem>['post'];

/**
 * Normalize the loose embedded-post preview carried on a notification into the
 * full hydrated shape `PostItem` renders. The embedded payload only carries a
 * minimal preview, so the required hydration sub-objects (attachments, viewer
 * state, permissions, metadata) are filled with safe defaults derived from the
 * preview's engagement/flags.
 */
function normalizeEmbeddedPost(embedded: TEmbeddedPost): NotificationPost {
    const content = embedded.content;
    const text = typeof content === 'string' ? content : content?.text;
    const engagement = embedded.engagement;
    return {
        id: embedded.id,
        content: { text },
        attachments: {},
        linkPreview: null,
        user: {
            id: embedded.user.id ?? '',
            handle: embedded.user.handle ?? '',
            displayName: embedded.user.displayName,
            avatar: embedded.user.avatar,
            isVerified: embedded.user.verified,
        },
        engagement: {
            likes: engagement?.likes ?? null,
            downvotes: null,
            boosts: engagement?.boosts ?? null,
            replies: engagement?.replies ?? null,
        },
        viewerState: {
            isOwner: false,
            isLiked: Boolean(embedded.isLiked),
            isDownvoted: false,
            isBoosted: Boolean(embedded.isBoosted),
            isSaved: Boolean(embedded.isSaved),
        },
        permissions: {
            canReply: true,
            canDelete: false,
            canPin: false,
            canViewSources: true,
        },
        metadata: {
            visibility: PostVisibility.PUBLIC,
            isThread: Boolean(embedded.isThread),
            createdAt: typeof embedded.date === 'string' ? embedded.date : '',
            updatedAt: typeof embedded.date === 'string' ? embedded.date : '',
        },
    };
}

type ProfileLookupServices = {
    getProfileById?: (id: string) => Promise<User | null | undefined>;
    getProfile?: (id: string) => Promise<User | null | undefined>;
    getUserById?: (id: string) => Promise<User | null | undefined>;
    getUser?: (id: string) => Promise<User | null | undefined>;
};

function objectValue(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function actorIdFrom(value: unknown): string {
    if (typeof value === 'string') return value;
    const object = objectValue(value);
    return object ? stringValue(object._id) || stringValue(object.id) || '' : '';
}

function actorUsernameFrom(value: unknown): string {
    const object = objectValue(value);
    return object ? stringValue(object.username) || '' : '';
}

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
            const populated = notification.actorId_populated;
            const id = actorIdFrom(notification.actorId);
            if (populated && (id || populated.id || populated._id)) {
                const merged = { ...(populated as Partial<User>), id: String(id || populated.id || populated._id) };
                precacheProfileView(queryClient, merged);
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
        return notification.actorId_populated?.avatar ?? undefined;
    });

    useEffect(() => {
        let cancelled = false;
        const id = actorIdFrom(notification.actorId);
        if (!id || actorName) return; // nothing to resolve

        // Try the shared users cache first for immediate value
        try {
            const cachedUser = queryClient.getQueryData<User>(queryKeys.users.detail(String(id)));
            if (cachedUser) {
                const resolvedName = cachedUser.name.displayName;
                setActorName(resolvedName);
                setActorAvatar(cachedUser.avatar ?? undefined);
                actorCacheRef.current.set(String(id), { name: resolvedName, avatar: cachedUser.avatar ?? undefined });
                return;
            }
        } catch { }

        // Otherwise ensure by ID via oxy services, then populate cache
        const resolve = async () => {
            try {
                if (!oxyServices) return;
                const svc = oxyServices as unknown as ProfileLookupServices;
                const loader = (actorId: string) => {
                    if (typeof svc.getProfileById === 'function') return svc.getProfileById(actorId);
                    if (typeof svc.getProfile === 'function') return svc.getProfile(actorId);
                    if (typeof svc.getUserById === 'function') return svc.getUserById(actorId);
                    if (typeof svc.getUser === 'function') return svc.getUser(actorId);
                    return Promise.resolve(null);
                };
                const ensured = await queryClient.fetchQuery<User | null>({
                    queryKey: queryKeys.users.detail(String(id)),
                    queryFn: async () => (await loader(String(id))) ?? null,
                    staleTime: 5 * 60 * 1000,
                });
                if (!cancelled && ensured) {
                    actorCacheRef.current.set(String(id), { name: ensured.name.displayName, avatar: ensured.avatar ?? undefined });
                    setActorName(ensured.name.displayName);
                    setActorAvatar(ensured.avatar ?? undefined);
                } else if (!cancelled) {
                    actorCacheRef.current.set(String(id), { name: String(id), avatar: undefined });
                    setActorName(String(id));
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
            case 'boost':
                return t('notification.boost', { actorName: display });
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
            case 'boost':
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
            const id = actorIdFrom(rawActor);
            const cachedUser = id ? queryClient.getQueryData<User>(queryKeys.users.detail(id)) : undefined;
            const uname = cachedUser?.username || notification.actorId_populated?.username || actorUsernameFrom(rawActor);
            if (uname) {
                router.push(`/@${uname}`);
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
    const embedded = notification.post ? ZEmbeddedPost.safeParse(notification.post) : null;
    const [post, setPost] = useState<NotificationPost | null>(embedded?.success ? normalizeEmbeddedPost(embedded.data) : null);
    const [loading, setLoading] = useState(!notification.post);

    useEffect(() => {
        if (notification.post) return; // Backend provided embedded post
        const loadPost = async () => {
            try {
                if (notification.entityId && notification.entityType === 'post') {
                    const postData = await getPostById(String(notification.entityId));
                    setPost(postData as NotificationPost | null);
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
