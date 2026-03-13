import React, { useCallback, useMemo } from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { PressableScale } from '@/lib/animations/PressableScale';
import { router } from 'expo-router';
import { ThemedText } from './ThemedText';
import Avatar from './Avatar';
import { AvatarStack, type AvatarStackProfile } from './AvatarStack';
import { SkeletonText, SkeletonCircle, SkeletonRow, SkeletonCol } from './Skeleton';
import { formatCompactNumber } from '@/utils/formatNumber';

export interface FeedCardData {
    id: string;
    displayName: string;
    description?: string;
    avatar?: string | null;
    creator?: {
        username: string;
        displayName?: string;
        avatar?: string;
    };
    likeCount?: number;
    memberCount?: number;
    topicCount?: number;
    memberAvatars?: string[];
}

interface FeedCardProps {
    feed: FeedCardData;
    onPress?: () => void;
    headerRight?: React.ReactNode;
    showDescription?: boolean;
    showLikes?: boolean;
    style?: ViewStyle;
}

/**
 * Feed card matching Bluesky's FeedSourceCard layout:
 * - 36px algo avatar on the left
 * - Feed name (bold, single line)
 * - "Feed by @handle" byline (muted, single line)
 * - Optional description (muted, up to 3 lines)
 * - Optional "Pinned by N users" stat line
 * - Optional memberAvatars stack or headerRight slot on the right
 */
export function FeedCard({
    feed,
    onPress,
    headerRight,
    showDescription = true,
    showLikes = false,
    style,
}: FeedCardProps) {
    const handlePress = useCallback(() => {
        if (onPress) {
            onPress();
        } else if (feed.id) {
            router.push(`/feeds/${feed.id}` as never);
        }
    }, [onPress, feed.id]);

    const statsLine = useMemo(() => {
        const parts: string[] = [];
        if (feed.topicCount && feed.topicCount > 0) {
            parts.push(`${feed.topicCount} ${feed.topicCount === 1 ? 'topic' : 'topics'}`);
        }
        if (feed.memberCount && feed.memberCount > 0) {
            parts.push(`${feed.memberCount} ${feed.memberCount === 1 ? 'profile' : 'profiles'}`);
        }
        return parts.join(' \u00B7 ');
    }, [feed.topicCount, feed.memberCount]);

    const accessibilityLabel = useMemo(() => {
        const parts = [feed.displayName];
        if (feed.creator) {
            parts.push(`a feed by @${feed.creator.username}`);
        }
        if (feed.memberCount && feed.memberCount > 0) {
            parts.push(`${feed.memberCount} ${feed.memberCount === 1 ? 'profile' : 'profiles'}`);
        }
        if (showLikes && feed.likeCount && feed.likeCount > 0) {
            parts.push(`pinned by ${feed.likeCount} ${feed.likeCount === 1 ? 'user' : 'users'}`);
        }
        return parts.join(', ');
    }, [feed.displayName, feed.creator, feed.memberCount, feed.likeCount, showLikes]);

    const avatarProfiles: AvatarStackProfile[] = useMemo(() => {
        if (!feed.memberAvatars || feed.memberAvatars.length === 0) return [];
        return feed.memberAvatars.slice(0, 3).map((uri, i) => ({
            id: `member-${i}`,
            avatar: uri,
        }));
    }, [feed.memberAvatars]);

    return (
        <PressableScale
            onPress={handlePress}
            style={[styles.outer, style]}
            className="bg-surface"
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            testID={`feed-${feed.id}`}>
            <View style={styles.row}>
                {/* Avatar */}
                <View style={styles.avatarWrap}>
                    <Avatar
                        source={feed.avatar || feed.creator?.avatar}
                        size={36}
                        shape="squircle"
                    />
                </View>

                {/* Text content */}
                <View style={styles.textContent}>
                    <ThemedText
                        className="text-sm font-semibold"
                        style={styles.name}
                        numberOfLines={1}>
                        {feed.displayName}
                    </ThemedText>
                    {feed.creator && (
                        <ThemedText
                            className="text-sm text-muted-foreground"
                            style={styles.byline}
                            numberOfLines={1}>
                            Feed by @{feed.creator.username}
                        </ThemedText>
                    )}
                </View>

                {/* Right side: avatar stack or custom slot */}
                {avatarProfiles.length > 0 ? (
                    <AvatarStack profiles={avatarProfiles} size={28} />
                ) : headerRight ? (
                    <View>{headerRight}</View>
                ) : null}
            </View>

            {showDescription && feed.description ? (
                <ThemedText
                    className="text-muted-foreground"
                    style={styles.description}
                    numberOfLines={3}>
                    {feed.description}
                </ThemedText>
            ) : null}

            {statsLine ? (
                <ThemedText
                    className="text-sm text-muted-foreground"
                    style={styles.stats}
                    numberOfLines={1}>
                    {statsLine}
                </ThemedText>
            ) : null}

            {showLikes && feed.likeCount && feed.likeCount > 0 ? (
                <ThemedText
                    className="text-sm font-semibold text-muted-foreground"
                    style={styles.likes}
                    numberOfLines={1}>
                    Pinned by {formatCompactNumber(feed.likeCount)}{' '}
                    {feed.likeCount === 1 ? 'user' : 'users'}
                </ThemedText>
            ) : null}
        </PressableScale>
    );
}

/**
 * Skeleton placeholder matching FeedCard layout.
 * Shows grey boxes for avatar, title, byline, and description.
 */
export function FeedCardSkeleton() {
    return (
        <View style={styles.outer} className="bg-surface">
            <SkeletonRow style={styles.row}>
                <SkeletonCircle size={36} />
                <SkeletonCol style={[styles.textContent, { gap: 6 }]}>
                    <SkeletonText style={{ width: 140, fontSize: 14 }} />
                    <SkeletonText style={{ width: 100, fontSize: 13 }} />
                </SkeletonCol>
            </SkeletonRow>
            <SkeletonText style={{ width: '80%' as unknown as number, fontSize: 14 }} />
        </View>
    );
}

const styles = StyleSheet.create({
    outer: {
        width: '100%',
        padding: 16,
        gap: 8,
        borderRadius: 12,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    avatarWrap: {
        // Matches Bluesky's a.mr_md (margin-right medium)
    },
    textContent: {
        flex: 1,
    },
    name: {
        lineHeight: 18,
    },
    byline: {
        lineHeight: 18,
    },
    description: {
        fontSize: 14,
        lineHeight: 20,
    },
    stats: {
        lineHeight: 18,
    },
    likes: {
        lineHeight: 18,
    },
});
