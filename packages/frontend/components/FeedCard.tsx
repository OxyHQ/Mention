import React from 'react';
import { View, StyleSheet, ViewStyle, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { ThemedText } from './ThemedText';
import Avatar from './Avatar';

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
    subscriberCount?: number;
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

function AvatarStack({ avatars }: { avatars: string[] }) {
    if (!avatars.length) return null;
    const displayed = avatars.slice(0, 3);
    const stackWidth = AVATAR_SIZE + (displayed.length - 1) * (AVATAR_SIZE - AVATAR_OVERLAP);

    return (
        <View style={[styles.avatarStack, { width: stackWidth, height: AVATAR_SIZE }]}>
            {displayed.map((uri, i) => (
                <View
                    key={i}
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
}

export function FeedCard({ feed, onPress, headerRight, style }: FeedCardProps) {
    const router = useRouter();
    const theme = useTheme();

    const handlePress = () => {
        if (onPress) {
            onPress();
        } else if (feed.id) {
            router.push(`/feeds/${feed.id}` as any);
        }
    };

    const subtitleParts: string[] = [];
    if (feed.topicCount && feed.topicCount > 0) {
        subtitleParts.push(`${feed.topicCount} ${feed.topicCount === 1 ? 'topic' : 'topics'}`);
    }
    if (feed.memberCount && feed.memberCount > 0) {
        subtitleParts.push(`${feed.memberCount} ${feed.memberCount === 1 ? 'profile' : 'profiles'}`);
    }
    const subtitle = subtitleParts.join(' \u00B7 ');

    return (
        <TouchableOpacity
            onPress={handlePress}
            activeOpacity={0.7}
            style={[
                styles.card,
                { backgroundColor: theme.colors.backgroundSecondary },
                style,
            ]}
        >
            <View style={styles.cardBody}>
                <View style={styles.cardInfo}>
                    <ThemedText style={styles.title} numberOfLines={1}>
                        {feed.displayName}
                    </ThemedText>
                    {subtitle ? (
                        <ThemedText
                            style={[styles.subtitle, { color: theme.colors.textSecondary }]}
                            numberOfLines={1}
                        >
                            {subtitle}
                        </ThemedText>
                    ) : feed.creator ? (
                        <ThemedText
                            style={[styles.subtitle, { color: theme.colors.textSecondary }]}
                            numberOfLines={1}
                        >
                            Feed by @{feed.creator.username}
                        </ThemedText>
                    ) : null}
                    {feed.description ? (
                        <ThemedText
                            style={[styles.description, { color: theme.colors.textSecondary }]}
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
        </TouchableOpacity>
    );
}

export function FeedCardOuter({
    children,
    style,
}: {
    children: React.ReactNode;
    style?: ViewStyle;
}) {
    return <View style={[styles.outerContainer, style]}>{children}</View>;
}

export function FeedCardHeader({
    children,
    style,
}: {
    children: React.ReactNode;
    style?: ViewStyle;
}) {
    return <View style={[styles.header, style]}>{children}</View>;
}

const styles = StyleSheet.create({
    outerContainer: {
        width: '100%',
        gap: 12,
    },
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
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
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
