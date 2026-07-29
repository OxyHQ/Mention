import React, { memo, useCallback, useMemo } from 'react';
import { View, Pressable, StyleSheet, Platform, TouchableOpacity } from 'react-native';
import { useAuth } from '@oxyhq/services/ui/client';
import { router } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Avatar } from '@oxyhq/bloom/avatar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@oxyhq/bloom/theme';
import { HIT_SLOP_MD } from '@/styles/hitSlop';

interface FeedHeaderProps {
    showComposeButton?: boolean;
    onComposePress?: () => void;
    hideHeader?: boolean;
    promptText?: string;
}

/** Height (px) of the prompt row: the avatar and the placeholder/action line beside it. */
const PROMPT_ROW_HEIGHT = 32;
/** Padding (px) inside the pill, above and below the prompt row. */
const PROMPT_VERTICAL_PADDING = 12;
/** Margin (px) around the pill, on every side. */
const PROMPT_MARGIN = 12;

/**
 * Total laid-out height (px) of the prompt, its outer margin included. Screens that
 * pin the prompt as a footer OVER their scrollable content (the post detail screen,
 * where it is the reply composer) reserve this much scrollable bottom padding so the
 * last row is never permanently hidden behind it.
 */
export const FEED_COMPOSER_PROMPT_HEIGHT =
    PROMPT_ROW_HEIGHT + PROMPT_VERTICAL_PADDING * 2 + PROMPT_MARGIN * 2;

/**
 * Composer prompt matching Bluesky's ComposerPrompt layout:
 * [Avatar 40px] ["What's up?" text] [Camera icon (native)] [Image icon]
 *
 * Sits flush at the top of the feed list. Only renders for authenticated users.
 */
export const FeedHeader = memo<FeedHeaderProps>(
    ({ showComposeButton, onComposePress, hideHeader, promptText }) => {
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

        const iconColor = theme.colors.textSecondary;
        const primaryColor = theme.colors.primary;

        const dynamicStyle = useMemo(() => ({
            backgroundColor: theme.colors.card,
            shadowColor: primaryColor,
            shadowOffset: { width: 0, height: 0 },
            shadowOpacity: theme.isDark ? 0.2 : 0.08,
            shadowRadius: 6,
            elevation: 2,
        }), [primaryColor, theme.isDark, theme.colors.card]);

        if (!showComposeButton || hideHeader || !user) return null;

        return (
            <Pressable
                onPress={handlePress}
                style={({ pressed }) => [
                    styles.container,
                    dynamicStyle,
                    pressed && styles.pressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel="Compose new post"
                accessibilityHint="Opens the post composer">
                <Avatar
                    source={user.avatar || undefined}
                    size={32}
                    variant={MEDIA_VARIANT_AVATAR}
                />
                <View style={styles.textRow}>
                    <ThemedText
                        className="text-muted-foreground"
                        style={styles.promptText}>
                        {promptText || 'What\u0027s up?'}
                    </ThemedText>
                    <View style={styles.actions}>
                        {Platform.OS !== 'web' && (
                            <TouchableOpacity
                                onPress={handleCameraPress}
                                hitSlop={HIT_SLOP_MD}
                                accessibilityLabel="Open camera"
                                accessibilityHint="Opens device camera">
                                <Ionicons name="camera-outline" size={22} color={iconColor} />
                            </TouchableOpacity>
                        )}
                        <TouchableOpacity
                            onPress={handleImagePress}
                            hitSlop={HIT_SLOP_MD}
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
        paddingVertical: PROMPT_VERTICAL_PADDING,
        borderRadius: 9999,
        margin: PROMPT_MARGIN,
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
        height: PROMPT_ROW_HEIGHT,
    },
    promptText: {
        fontSize: 16,
    },
    actions: {
        flexDirection: 'row',
        gap: 16,
    },
});
