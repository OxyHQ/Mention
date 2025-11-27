import React, { memo, useCallback } from 'react';
import { View, ActivityIndicator, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useOxy } from '@oxyhq/services';

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
        const { isAuthenticated, showBottomSheet } = useOxy();

        const handleSignIn = useCallback(() => {
            showBottomSheet?.('SignIn');
        }, [showBottomSheet]);

        // Show sign-in prompt for unauthenticated users at the end of the feed
        if (!isAuthenticated && hasItems && !showOnlySaved) {
            return (
                <TouchableOpacity 
                    style={[styles.signInFooter, { borderTopColor: theme.colors.border }]}
                    onPress={handleSignIn}
                    activeOpacity={0.7}
                >
                    <Ionicons name="lock-closed-outline" size={20} color={theme.colors.primary} />
                    <Text style={[styles.signInText, { color: theme.colors.text }]}>
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
    signInFooter: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 16,
        paddingHorizontal: 20,
        gap: 10,
        borderTopWidth: StyleSheet.hairlineWidth,
    },
    signInText: {
        fontSize: 15,
        fontWeight: '500',
        flex: 1,
    },
});

