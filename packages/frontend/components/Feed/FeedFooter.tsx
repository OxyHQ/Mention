import React, { memo, useCallback } from 'react';
import { View, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { useAuth } from '@oxyhq/services';

interface FeedFooterProps {
    showOnlySaved?: boolean;
    hasMore: boolean;
    isLoadingMore: boolean;
    hasItems: boolean;
}

/**
 * Feed footer component
 * Displays loading indicator when loading more items
 * Shows sign-in prompt for unauthenticated users
 */
export const FeedFooter = memo<FeedFooterProps>(
    ({ showOnlySaved, hasMore, isLoadingMore, hasItems }) => {
        const theme = useTheme();
        const { isAuthenticated, signIn } = useAuth();

        const handleSignIn = useCallback(() => {
            signIn().catch(() => {});
        }, [signIn]);

        // Show sign-in prompt for unauthenticated users at the end of the feed
        if (!isAuthenticated && hasItems && !showOnlySaved) {
            return (
                <TouchableOpacity
                    className="flex-row items-center justify-center py-4 px-5 border-border"
                    style={styles.signInFooter}
                    onPress={handleSignIn}
                    activeOpacity={0.7}
                >
                    <Ionicons name="lock-closed-outline" size={20} color={theme.colors.primary} />
                    <Text className="text-foreground text-[15px] font-medium flex-1" style={{ marginLeft: 10 }}>
                        Sign in to see more
                    </Text>
                    <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
                </TouchableOpacity>
            );
        }

        if (showOnlySaved || !hasMore || !isLoadingMore) return null;
        if (!hasItems) return null;

        return (
            <View
                className="flex-row justify-center items-center py-2"
                accessible={true}
                accessibilityRole="progressbar"
                accessibilityLabel="Loading more posts"
            >
                <Loading className="text-primary" size="small" style={{ flex: undefined }} />
            </View>
        );
    }
);

FeedFooter.displayName = 'FeedFooter';

const styles = StyleSheet.create({
    signInFooter: {
        gap: 10,
        borderTopWidth: StyleSheet.hairlineWidth,
    },
});
