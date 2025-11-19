import React, { memo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { FeedType } from '@mention/shared-types';
import { useTheme } from '@/hooks/useTheme';
import { flattenStyleArray } from '@/utils/theme';
import { Ionicons } from '@expo/vector-icons';

interface FeedEmptyStateProps {
    isLoading: boolean;
    error: string | null;
    hasItems: boolean;
    type: FeedType;
    showOnlySaved?: boolean;
    onRetry?: () => Promise<void>;
}

/**
 * Feed empty state component
 * Handles loading, error, and empty states
 */
export const FeedEmptyState = memo<FeedEmptyStateProps>(
    ({ isLoading, error, hasItems, type, showOnlySaved, onRetry }) => {
        const theme = useTheme();
        const [isRetrying, setIsRetrying] = useState(false);

        if (isLoading) return null;

        const hasError = !!error;
        const hasNoItems = !hasItems;

        const handleRetry = async () => {
            if (!onRetry || isRetrying) return;
            setIsRetrying(true);
            try {
                await onRetry();
            } finally {
                setIsRetrying(false);
            }
        };

        if (hasError && hasNoItems && onRetry) {
            return (
                <View
                    style={flattenStyleArray([
                        styles.errorContainer,
                        { backgroundColor: theme.colors.background },
                    ])}
                >
                    <View style={styles.errorContent}>
                        <View
                            style={[
                                styles.iconWrapper,
                                { backgroundColor: theme.colors.error + '15' },
                            ]}
                        >
                            <Ionicons
                                name="cloud-offline-outline"
                                size={48}
                                color={theme.colors.error}
                            />
                        </View>

                        <Text
                            style={flattenStyleArray([
                                styles.errorTitle,
                                { color: theme.colors.text },
                            ])}
                        >
                            Couldn't load posts
                        </Text>

                        <Text
                            style={flattenStyleArray([
                                styles.errorMessage,
                                { color: theme.colors.textSecondary },
                            ])}
                        >
                            Something went wrong while loading your feed. Pull down to refresh or tap the button below to try again.
                        </Text>

                        <TouchableOpacity
                            style={[
                                styles.retryButton,
                                {
                                    backgroundColor: theme.colors.primary,
                                    opacity: isRetrying ? 0.6 : 1,
                                },
                            ]}
                            onPress={handleRetry}
                            disabled={isRetrying}
                            activeOpacity={0.8}
                        >
                            {isRetrying ? (
                                <ActivityIndicator
                                    size="small"
                                    color={theme.colors.card}
                                />
                            ) : (
                                <>
                                    <Ionicons
                                        name="refresh"
                                        size={18}
                                        color={theme.colors.card}
                                        style={styles.retryIcon}
                                    />
                                    <Text
                                        style={[
                                            styles.retryButtonText,
                                            { color: theme.colors.card },
                                        ]}
                                    >
                                        Try again
                                    </Text>
                                </>
                            )}
                        </TouchableOpacity>
                    </View>
                </View>
            );
        }

        const emptyText = showOnlySaved ? 'No saved posts yet' : 'No posts yet';
        const emptySubtext = getEmptySubtext(type, showOnlySaved);

        return (
            <View
                style={flattenStyleArray([
                    styles.emptyState,
                    { backgroundColor: theme.colors.background },
                ])}
                accessible={true}
                accessibilityRole="text"
                accessibilityLabel={`${emptyText}. ${emptySubtext}`}
            >
                <Text
                    style={flattenStyleArray([
                        styles.emptyStateText,
                        { color: theme.colors.text },
                    ])}
                >
                    {emptyText}
                </Text>
                <Text
                    style={flattenStyleArray([
                        styles.emptyStateSubtext,
                        { color: theme.colors.textSecondary },
                    ])}
                >
                    {emptySubtext}
                </Text>
            </View>
        );
    }
);

FeedEmptyState.displayName = 'FeedEmptyState';

function getEmptySubtext(type: FeedType, showOnlySaved?: boolean): string {
    if (showOnlySaved) {
        return 'Posts you save will appear here. Tap the bookmark icon on any post to save it.';
    }

    switch (type) {
        case 'posts':
            return 'Be the first to share something!';
        case 'media':
            return 'No media posts found';
        case 'replies':
            return 'No replies yet';
        case 'reposts':
            return 'No reposts yet';
        case 'explore':
            return 'No trending posts right now. Check back later!';
        case 'following':
            return 'Start following people to see their posts';
        case 'for_you':
            return 'Discover posts based on your interests';
        case 'custom':
            return 'This feed is empty';
        default:
            return 'Start following people to see their posts';
    }
}

const styles = StyleSheet.create({
    errorContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingVertical: 60,
        paddingHorizontal: 32,
    },
    errorContent: {
        alignItems: 'center',
        maxWidth: 320,
        width: '100%',
    },
    iconWrapper: {
        width: 96,
        height: 96,
        borderRadius: 48,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 24,
    },
    errorTitle: {
        fontSize: 22,
        fontWeight: '700',
        textAlign: 'center',
        marginBottom: 12,
        letterSpacing: -0.3,
    },
    errorMessage: {
        fontSize: 15,
        textAlign: 'center',
        lineHeight: 22,
        marginBottom: 32,
    },
    retryButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 14,
        paddingHorizontal: 24,
        borderRadius: 24,
        minWidth: 140,
        gap: 8,
    },
    retryIcon: {
        marginRight: 0,
    },
    retryButtonText: {
        fontSize: 16,
        fontWeight: '600',
    },
    emptyState: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingVertical: 80,
        paddingHorizontal: 32,
    },
    emptyStateText: {
        fontSize: 20,
        fontWeight: '700',
        marginTop: 24,
        textAlign: 'center',
        letterSpacing: -0.5,
    },
    emptyStateSubtext: {
        fontSize: 16,
        marginTop: 12,
        textAlign: 'center',
        lineHeight: 24,
        maxWidth: 280,
    },
});

