import React, { memo } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/useTheme';

interface FeedFooterProps {
    showOnlySaved?: boolean;
    hasMore: boolean;
    isLoadingMore: boolean;
    hasItems: boolean;
}

/**
 * Feed footer component
 * Displays loading indicator when loading more items
 */
export const FeedFooter = memo<FeedFooterProps>(
    ({ showOnlySaved, hasMore, isLoadingMore, hasItems }) => {
        const theme = useTheme();

        if (showOnlySaved || !hasMore || !isLoadingMore) return null;
        if (!hasItems) return null;

        return (
            <View
                style={styles.footer}
                accessible={true}
                accessibilityRole="progressbar"
                accessibilityLabel="Loading more posts"
            >
                <ActivityIndicator size="small" color={theme.colors.primary} />
            </View>
        );
    }
);

FeedFooter.displayName = 'FeedFooter';

const styles = StyleSheet.create({
    footer: {
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        paddingVertical: 8,
    },
});

