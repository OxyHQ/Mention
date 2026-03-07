import React, { useCallback, useEffect, useState, useMemo } from 'react';
import {
    View,
    Text,
    FlatList,
    TouchableOpacity,
    ActivityIndicator,
    Linking,
    StatusBar,
    StyleSheet,
    ImageBackground,
    Share,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/hooks/useTheme';
import { federationService } from '@/services/federationService';
import PostItem from '@/components/Feed/PostItem';
import Avatar from '@/components/Avatar';
import UserName from '@/components/UserName';
import { IconButton } from '@/components/ui/Button';
import { ShareIcon } from '@/assets/icons/share-icon';
import { ProfileSkeleton } from '@/components/Profile';
import SEO from '@/components/SEO';
import type { FederatedActorProfile } from '@mention/shared-types';

interface FederatedProfileScreenProps {
    handle: string; // e.g. "AlbertIsernAlvarez@mastodon.social"
}

const FederatedProfileScreen: React.FC<FederatedProfileScreenProps> = ({ handle }) => {
    const theme = useTheme();
    const insets = useSafeAreaInsets();

    const [actor, setActor] = useState<FederatedActorProfile | null>(null);
    const [posts, setPosts] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [followLoading, setFollowLoading] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [nextCursor, setNextCursor] = useState<string | undefined>();

    useEffect(() => {
        if (!handle) return;
        loadProfile();
    }, [handle]);

    const loadProfile = async () => {
        setLoading(true);
        try {
            const actorData = await federationService.lookupActor(handle);
            if (!actorData) {
                setLoading(false);
                return;
            }
            setActor(actorData);

            const postsData = await federationService.getActorPosts(actorData.actorUri);
            setPosts(postsData.posts);
            setHasMore(postsData.hasMore);
            setNextCursor(postsData.nextCursor);
        } finally {
            setLoading(false);
        }
    };

    const loadMore = async () => {
        if (!hasMore || !nextCursor || !actor) return;
        const data = await federationService.getActorPosts(actor.actorUri, nextCursor);
        setPosts((prev) => [...prev, ...data.posts]);
        setHasMore(data.hasMore);
        setNextCursor(data.nextCursor);
    };

    const handleFollow = async () => {
        if (!actor) return;
        setFollowLoading(true);
        try {
            if (actor.isFollowing || actor.isFollowPending) {
                await federationService.unfollow(actor.actorUri);
                setActor((prev) => prev ? { ...prev, isFollowing: false, isFollowPending: false } : null);
            } else {
                const result = await federationService.follow(actor.actorUri);
                setActor((prev) => prev ? {
                    ...prev,
                    isFollowing: !result.pending,
                    isFollowPending: result.pending,
                } : null);
            }
        } finally {
            setFollowLoading(false);
        }
    };

    const openOnInstance = useCallback(() => {
        if (actor?.actorUri) Linking.openURL(actor.actorUri);
    }, [actor?.actorUri]);

    const handleShare = useCallback(async () => {
        if (!actor) return;
        const shareUrl = `https://mention.earth/@${handle}`;
        await Share.share({
            message: `Check out ${actor.displayName || handle}'s profile on Mention!\n\n${shareUrl}`,
            url: shareUrl,
            title: `${actor.displayName || handle} on Mention`,
        });
    }, [actor, handle]);

    const followButtonLabel = actor?.isFollowPending
        ? 'Pending'
        : actor?.isFollowing
            ? 'Following'
            : 'Follow';

    const followButtonStyle = useMemo(() =>
        actor?.isFollowing || actor?.isFollowPending
            ? { backgroundColor: 'transparent', borderWidth: 1, borderColor: theme.colors.border }
            : { backgroundColor: theme.colors.primary },
        [actor?.isFollowing, actor?.isFollowPending, theme.colors.border, theme.colors.primary]
    );

    const followTextColor = actor?.isFollowing || actor?.isFollowPending
        ? theme.colors.text
        : '#fff';

    if (loading) {
        return (
            <View style={[styles.container, { paddingTop: insets.top, backgroundColor: theme.colors.background }]}>
                <StatusBar barStyle={theme.isDark ? 'light-content' : 'dark-content'} />
                <ProfileSkeleton />
            </View>
        );
    }

    if (!actor) {
        return (
            <View style={[styles.centered, { backgroundColor: theme.colors.background }]}>
                <StatusBar barStyle={theme.isDark ? 'light-content' : 'dark-content'} />
                <Ionicons name="globe-outline" size={48} color={theme.colors.textSecondary} />
                <Text style={{ color: theme.colors.textSecondary, marginTop: 12, fontSize: 16 }}>
                    Actor not found
                </Text>
            </View>
        );
    }

    const displayName = actor.displayName || handle.split('@')[0];
    const username = handle.split('@')[0];
    const instance = handle.split('@')[1];

    const renderHeader = () => (
        <View>
            {/* Banner */}
            {actor.bannerUrl ? (
                <ImageBackground
                    source={{ uri: actor.bannerUrl }}
                    style={styles.banner}
                />
            ) : (
                <View style={[styles.banner, { backgroundColor: `${theme.colors.primary}20` }]} />
            )}

            {/* Avatar + Actions */}
            <View style={styles.avatarRow}>
                <View style={styles.avatarContainer}>
                    <Avatar
                        source={actor.avatarUrl || undefined}
                        size={72}
                    />
                </View>
                <View style={styles.actionButtons}>
                    <TouchableOpacity
                        onPress={openOnInstance}
                        style={[styles.iconBtn, { borderColor: theme.colors.border }]}
                    >
                        <Ionicons name="open-outline" size={16} color={theme.colors.text} />
                    </TouchableOpacity>
                    <TouchableOpacity
                        onPress={handleFollow}
                        disabled={followLoading}
                        style={[styles.followBtn, followButtonStyle]}
                    >
                        {followLoading ? (
                            <ActivityIndicator size="small" color={followTextColor} />
                        ) : (
                            <Text style={{ color: followTextColor, fontWeight: '600', fontSize: 14 }}>
                                {followButtonLabel}
                            </Text>
                        )}
                    </TouchableOpacity>
                </View>
            </View>

            {/* Name + Handle */}
            <View style={styles.nameSection}>
                <UserName
                    name={displayName}
                    style={{ name: { fontSize: 20, fontWeight: '700', color: theme.colors.text } }}
                />
                <View style={styles.handleRow}>
                    <Text style={[styles.handleText, { color: theme.colors.textSecondary }]}>
                        @{username}
                    </Text>
                    <Ionicons name="globe-outline" size={14} color={theme.colors.textSecondary} />
                    <Text style={[styles.instanceText, { color: theme.colors.textTertiary }]}>
                        {instance}
                    </Text>
                </View>
            </View>

            {/* Bio */}
            {actor.bio ? (
                <Text style={[styles.bio, { color: theme.colors.text }]}>
                    {actor.bio.replace(/<[^>]*>/g, '')}
                </Text>
            ) : null}

            {/* Stats */}
            <View style={styles.statsRow}>
                <TouchableOpacity style={styles.stat}>
                    <Text style={[styles.statCount, { color: theme.colors.text }]}>
                        {actor.followingCount ?? 0}
                    </Text>
                    <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}> Following</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.stat}>
                    <Text style={[styles.statCount, { color: theme.colors.text }]}>
                        {actor.followersCount ?? 0}
                    </Text>
                    <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}> Followers</Text>
                </TouchableOpacity>
            </View>

            {/* Divider */}
            <View style={[styles.divider, { borderBottomColor: theme.colors.border }]} />
        </View>
    );

    return (
        <>
            <SEO
                title={`${displayName} (@${handle}) on Mention`}
                description={actor.bio ? `View ${displayName}'s profile on Mention. ${actor.bio.replace(/<[^>]*>/g, '')}` : `View ${displayName}'s profile on Mention.`}
                image={actor.avatarUrl}
                type="profile"
            />
            <View style={[styles.container, { paddingTop: insets.top, backgroundColor: theme.colors.background }]}>
                <StatusBar barStyle={theme.isDark ? 'light-content' : 'dark-content'} />

                {/* Header actions */}
                <View style={[styles.headerActions, { top: insets.top + 6 }]}>
                    <IconButton variant="icon" onPress={handleShare}>
                        <ShareIcon size={20} color={theme.colors.text} />
                    </IconButton>
                </View>

                <FlatList
                    data={posts}
                    keyExtractor={(item) => item._id || item.id}
                    renderItem={({ item }) => <PostItem post={item} />}
                    ListHeaderComponent={renderHeader}
                    onEndReached={loadMore}
                    onEndReachedThreshold={0.5}
                    ListEmptyComponent={
                        <View style={styles.emptyPosts}>
                            <Text style={{ color: theme.colors.textSecondary, fontSize: 15 }}>
                                No posts available
                            </Text>
                        </View>
                    }
                />
            </View>
        </>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    centered: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    headerActions: {
        zIndex: 10,
        position: 'absolute',
        right: 16,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    banner: {
        width: '100%',
        height: 150,
    },
    avatarRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        paddingHorizontal: 16,
        marginTop: -30,
    },
    avatarContainer: {
        borderRadius: 40,
        borderWidth: 3,
        borderColor: 'transparent',
        overflow: 'hidden',
    },
    actionButtons: {
        flexDirection: 'row',
        gap: 8,
        paddingBottom: 4,
    },
    iconBtn: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 20,
        borderWidth: 1,
    },
    followBtn: {
        paddingHorizontal: 20,
        paddingVertical: 8,
        borderRadius: 20,
    },
    nameSection: {
        paddingHorizontal: 16,
        marginTop: 8,
    },
    handleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        marginTop: 2,
    },
    handleText: {
        fontSize: 15,
    },
    instanceText: {
        fontSize: 14,
    },
    bio: {
        paddingHorizontal: 16,
        marginTop: 8,
        fontSize: 15,
        lineHeight: 20,
    },
    statsRow: {
        flexDirection: 'row',
        gap: 16,
        paddingHorizontal: 16,
        marginTop: 12,
    },
    stat: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    statCount: {
        fontSize: 14,
        fontWeight: '700',
    },
    statLabel: {
        fontSize: 14,
    },
    divider: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        marginTop: 16,
    },
    emptyPosts: {
        padding: 32,
        alignItems: 'center',
    },
});

export default FederatedProfileScreen;
