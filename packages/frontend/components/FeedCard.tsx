import React, { useCallback, useMemo } from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { PressableScale } from '@/lib/animations/PressableScale';
import { router } from 'expo-router';
import { ThemedText } from './ThemedText';
import Avatar from './Avatar';

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
    style?: ViewStyle;
}

const AVATAR_SIZE = 28;
const AVATAR_OVERLAP = 8;

const AvatarStack = React.memo(function AvatarStack({ avatars }: { avatars: string[] }) {
    if (!avatars.length) return null;
    const displayed = avatars.slice(0, 3);
    const stackWidth = AVATAR_SIZE + (displayed.length - 1) * (AVATAR_SIZE - AVATAR_OVERLAP);

    return (
        <View style={[styles.avatarStack, { width: stackWidth, height: AVATAR_SIZE }]}>
            {displayed.map((uri, i) => (
                <View
                    key={uri}
                    style={[
                        styles.avatarWrapper,
                        { left: i * (AVATAR_SIZE - AVATAR_OVERLAP), zIndex: displayed.length - i },
                    ]}
                >
                    <Avatar source={uri} size={AVATAR_SIZE} />
                </View>
            ))}
        </View>
    );
});

export function FeedCard({ feed, onPress, headerRight, style }: FeedCardProps) {
    const handlePress = useCallback(() => {
        if (onPress) {
            onPress();
        } else if (feed.id) {
            router.push(`/feeds/${feed.id}` as any);
        }
    }, [onPress, feed.id]);

    const subtitle = useMemo(() => {
        const parts: string[] = [];
        if (feed.topicCount && feed.topicCount > 0) {
            parts.push(`${feed.topicCount} ${feed.topicCount === 1 ? 'topic' : 'topics'}`);
        }
        if (feed.memberCount && feed.memberCount > 0) {
            parts.push(`${feed.memberCount} ${feed.memberCount === 1 ? 'profile' : 'profiles'}`);
        }
        return parts.join(' \u00B7 ');
    }, [feed.topicCount, feed.memberCount]);

    return (
        <PressableScale
            onPress={handlePress}
            className="bg-surface w-full p-4 rounded-2xl"
            style={style}
        >
            <View className="flex-row items-center gap-4">
                <View className="flex-1 gap-0.5">
                    <ThemedText className="text-base font-bold" style={{ lineHeight: 22 }} numberOfLines={1}>
                        {feed.displayName}
                    </ThemedText>
                    {subtitle ? (
                        <ThemedText
                            className="text-muted-foreground text-sm"
                            style={{ lineHeight: 18 }}
                            numberOfLines={1}
                        >
                            {subtitle}
                        </ThemedText>
                    ) : feed.creator ? (
                        <ThemedText
                            className="text-muted-foreground text-sm"
                            style={{ lineHeight: 18 }}
                            numberOfLines={1}
                        >
                            Feed by @{feed.creator.username}
                        </ThemedText>
                    ) : null}
                    {feed.description ? (
                        <ThemedText
                            className="text-muted-foreground text-sm mt-0.5"
                            style={{ lineHeight: 20 }}
                            numberOfLines={2}
                        >
                            {feed.description}
                        </ThemedText>
                    ) : null}
                </View>
                {feed.memberAvatars && feed.memberAvatars.length > 0 ? (
                    <AvatarStack avatars={feed.memberAvatars} />
                ) : headerRight ? (
                    <View>{headerRight}</View>
                ) : null}
            </View>
        </PressableScale>
    );
}

const styles = StyleSheet.create({
    avatarStack: {
        position: 'relative',
    },
    avatarWrapper: {
        position: 'absolute',
        top: 0,
        borderRadius: AVATAR_SIZE / 2,
        overflow: 'hidden',
    },
});
