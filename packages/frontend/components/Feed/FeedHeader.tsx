import React, { memo, useCallback, useMemo } from 'react';
import { View, Pressable, StyleSheet, Platform, TouchableOpacity } from 'react-native';
import { useAuth } from '@oxyhq/services';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Avatar from '@/components/Avatar';
import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';

interface FeedHeaderProps {
    showComposeButton?: boolean;
    onComposePress?: () => void;
    hideHeader?: boolean;
}

/**
 * Composer prompt matching Bluesky's ComposerPrompt layout:
 * [Avatar 40px] ["What's up?" text] [Camera icon (native)] [Image icon]
 *
 * Sits flush at the top of the feed list. Only renders for authenticated users.
 */
export const FeedHeader = memo<FeedHeaderProps>(
    ({ showComposeButton, onComposePress, hideHeader }) => {
        const { user } = useAuth();
        const theme = useTheme();

        const handlePress = useCallback(() => {
            if (onComposePress) {
                onComposePress();
            } else {
                router.push('/compose');
            }
        }, [onComposePress]);

        const handleCameraPress = useCallback(() => {
            router.push('/compose');
        }, []);

        const handleImagePress = useCallback(() => {
            router.push('/compose');
        }, []);

        if (!showComposeButton || hideHeader || !user) return null;

        const iconColor = theme.colors.textSecondary;
        const primaryColor = theme.colors.primary;

        const shadowStyle = useMemo(() => ({
            shadowColor: primaryColor,
            shadowOffset: { width: 0, height: 0 },
            shadowOpacity: theme.isDark ? 0.3 : 0.15,
            shadowRadius: 8,
            elevation: 3,
        }), [primaryColor, theme.isDark]);

        return (
            <Pressable
                onPress={handlePress}
                style={({ pressed }) => [
                    styles.container,
                    shadowStyle,
                    { backgroundColor: theme.colors.card, borderColor: theme.colors.border },
                    pressed && styles.pressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel="Compose new post"
                accessibilityHint="Opens the post composer">
                <Avatar
                    source={user.avatar || undefined}
                    size={40}
                />
                <View style={styles.textRow}>
                    <ThemedText
                        className="text-muted-foreground"
                        style={styles.promptText}>
                        What&apos;s up?
                    </ThemedText>
                    <View style={styles.actions}>
                        {Platform.OS !== 'web' && (
                            <TouchableOpacity
                                onPress={handleCameraPress}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                accessibilityLabel="Open camera"
                                accessibilityHint="Opens device camera">
                                <Ionicons name="camera-outline" size={22} color={iconColor} />
                            </TouchableOpacity>
                        )}
                        <TouchableOpacity
                            onPress={handleImagePress}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            accessibilityLabel="Add image"
                            accessibilityHint="Opens image picker">
                            <Ionicons name="image-outline" size={22} color={iconColor} />
                        </TouchableOpacity>
                    </View>
                </View>
            </Pressable>
        );
    }
);

FeedHeader.displayName = 'FeedHeader';

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingHorizontal: 12,
        paddingVertical: 12,
        borderRadius: 16,
        margin: 12,
        borderWidth: StyleSheet.hairlineWidth,
    },
    pressed: {
        opacity: 0.7,
    },
    textRow: {
        flex: 1,
        marginLeft: 12,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 40,
    },
    promptText: {
        fontSize: 16,
    },
    actions: {
        flexDirection: 'row',
        gap: 16,
    },
});
