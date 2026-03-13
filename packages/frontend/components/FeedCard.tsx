import React, { useCallback, useMemo } from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { PressableScale } from '@/lib/animations/PressableScale';
import { router } from 'expo-router';
import { cn } from '@/lib/utils';
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
            className="bg-surface"
            style={[styles.card, style]}
        >
            <View style={styles.cardBody}>
                <View style={styles.cardInfo}>
                    <ThemedText style={styles.title} numberOfLines={1}>
                        {feed.displayName}
                    </ThemedText>
                    {subtitle ? (
                        <ThemedText
                            className="text-muted-foreground"
                            style={styles.subtitle}
                            numberOfLines={1}
                        >
                            {subtitle}
                        </ThemedText>
                    ) : feed.creator ? (
                        <ThemedText
                            className="text-muted-foreground"
                            style={styles.subtitle}
                            numberOfLines={1}
                        >
                            Feed by @{feed.creator.username}
                        </ThemedText>
                    ) : null}
                    {feed.description ? (
                        <ThemedText
                            className="text-muted-foreground"
                            style={styles.description}
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
    card: {
        width: '100%',
        padding: 16,
        borderRadius: 16,
    },
    cardBody: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 16,
    },
    cardInfo: {
        flex: 1,
        gap: 2,
    },
    title: {
        fontSize: 16,
        fontWeight: '700',
        lineHeight: 22,
    },
    subtitle: {
        fontSize: 14,
        lineHeight: 18,
    },
    description: {
        fontSize: 14,
        lineHeight: 20,
        marginTop: 2,
    },
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
