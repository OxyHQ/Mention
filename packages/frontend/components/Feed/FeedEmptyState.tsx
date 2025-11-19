import React, { memo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { FeedType } from '@mention/shared-types';
import { useTheme } from '@/hooks/useTheme';
import { flattenStyleArray } from '@/utils/theme';
import { Error } from '../Error';
import { FeedFilters } from '@/utils/feedUtils';

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

        if (isLoading) return null;

        const hasError = !!error;
        const hasNoItems = !hasItems;

        if (hasError && hasNoItems && onRetry) {
            return (
                <Error
                    title="Failed to load posts"
                    message="Unable to fetch posts. Please check your connection and try again."
                    onRetry={onRetry}
                    hideBackButton={true}
                    style={{ flex: 1, paddingVertical: 60 }}
                />
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

