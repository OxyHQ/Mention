import React, { useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { PressableScale } from '@oxyhq/bloom/pressable-scale';
import { router } from 'expo-router';
import { ThemedText } from './ThemedText';
import { Avatar } from '@oxyhq/bloom/avatar';
import { AvatarGroup, type AvatarGroupItem } from '@oxyhq/bloom/avatar-group';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { formatCompactNumber } from '@/utils/formatNumber';

export interface FeedCardData {
    id: string;
    uri?: string;
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
    subscriberCount?: number;
    topicCount?: number;
    memberAvatars?: string[];
}

export type FeedCardVariant = 'card' | 'row';

interface FeedCardProps {
    feed: FeedCardData;
    onPress?: () => void;
    headerRight?: React.ReactNode;
    showDescription?: boolean;
    showLikes?: boolean;
    variant?: FeedCardVariant;
}

/** Card surface (default) vs. flush full-width feed row (result lists). */
const OUTER_CLASS: Record<FeedCardVariant, string> = {
    card: 'w-full p-4 gap-2 rounded-xl bg-surface',
    row: 'w-full px-3 py-3 gap-1 border-b border-border',
};

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
    variant = 'card',
}: FeedCardProps) {
    const handlePress = useCallback(() => {
        if (onPress) {
            onPress();
        } else if (feed.id) {
            router.push(`/feeds/${feed.id}`);
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
        return parts.join(' · ');
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

    const avatarItems: AvatarGroupItem[] = useMemo(() => {
        if (!feed.memberAvatars || feed.memberAvatars.length === 0) return [];
        return feed.memberAvatars.map((uri, i) => ({
            id: `member-${i}`,
            uri,
        }));
    }, [feed.memberAvatars]);

    return (
        <PressableScale
            onPress={handlePress}
            className={OUTER_CLASS[variant]}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            testID={`feed-${feed.id}`}>
            <View className="flex-row items-center gap-3">
                {/* Avatar */}
                <Avatar
                    source={feed.avatar || feed.creator?.avatar}
                    size={36}
                    variant={MEDIA_VARIANT_AVATAR}
                    shape="squircle"
                />

                {/* Text content */}
                <View className="flex-1">
                    <ThemedText
                        className="text-sm font-semibold leading-[18px]"
                        numberOfLines={1}>
                        {feed.displayName}
                    </ThemedText>
                    {feed.creator && (
                        <ThemedText
                            className="text-sm text-muted-foreground leading-[18px]"
                            numberOfLines={1}>
                            Feed by @{feed.creator.username}
                        </ThemedText>
                    )}
                </View>

                {/* Right side: avatar cluster or custom slot */}
                {avatarItems.length > 0 ? (
                    <AvatarGroup items={avatarItems} size={28} max={3} variant={MEDIA_VARIANT_AVATAR} />
                ) : headerRight ? (
                    <View>{headerRight}</View>
                ) : null}
            </View>

            {showDescription && feed.description ? (
                <ThemedText
                    className="text-muted-foreground text-sm leading-5"
                    numberOfLines={variant === 'row' ? 2 : 3}>
                    {feed.description}
                </ThemedText>
            ) : null}

            {statsLine ? (
                <ThemedText
                    className="text-sm text-muted-foreground leading-[18px]"
                    numberOfLines={1}>
                    {statsLine}
                </ThemedText>
            ) : null}

            {showLikes && feed.likeCount && feed.likeCount > 0 ? (
                <ThemedText
                    className="text-sm font-semibold text-muted-foreground leading-[18px]"
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
 *
 * Bloom's Skeleton primitives take `style` (not `className`), so the shimmer
 * geometry stays as plain style objects here.
 */
export function FeedCardSkeleton() {
    return (
        <View className={OUTER_CLASS.card}>
            <Skeleton.Row style={{ alignItems: 'center', gap: 12 }}>
                <Skeleton.Circle size={36} />
                <Skeleton.Col style={{ flex: 1, gap: 6 }}>
                    <Skeleton.Text style={{ width: 140, fontSize: 14 }} />
                    <Skeleton.Text style={{ width: 100, fontSize: 13 }} />
                </Skeleton.Col>
            </Skeleton.Row>
            <Skeleton.Box width="80%" height={14} />
        </View>
    );
}
