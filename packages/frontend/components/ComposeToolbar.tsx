import React from 'react';
import { View, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';

interface ComposeToolbarProps {
    onMediaPress?: () => void;
    onPollPress?: () => void;
    onLocationPress?: () => void;
    onGifPress?: () => void;
    onEmojiPress?: () => void;
    onSchedulePress?: () => void;
    hasLocation?: boolean;
    isGettingLocation?: boolean;
    hasPoll?: boolean;
    hasMedia?: boolean;
    disabled?: boolean;
}

const ComposeToolbar: React.FC<ComposeToolbarProps> = ({
    onMediaPress,
    onPollPress,
    onLocationPress,
    onGifPress,
    onEmojiPress,
    onSchedulePress,
    hasLocation = false,
    isGettingLocation = false,
    hasPoll = false,
    hasMedia = false,
    disabled = false,
}) => {
    const theme = useTheme();

    return (
        <View style={styles.toolbar}>
            {onMediaPress && (
                <TouchableOpacity
                    onPress={onMediaPress}
                    disabled={disabled || hasPoll}
                    style={styles.button}
                >
                    <Ionicons
                        name="image-outline"
                        size={20}
                        color={disabled || hasPoll ? theme.colors.textTertiary : theme.colors.textSecondary}
                    />
                </TouchableOpacity>
            )}

            {onGifPress && (
                <TouchableOpacity
                    onPress={onGifPress}
                    disabled={disabled}
                    style={styles.button}
                >
                    <Ionicons
                        name="gift"
                        size={20}
                        color={disabled ? theme.colors.textTertiary : theme.colors.textSecondary}
                    />
                </TouchableOpacity>
            )}

            {onEmojiPress && (
                <TouchableOpacity
                    onPress={onEmojiPress}
                    disabled={disabled}
                    style={styles.button}
                >
                    <Ionicons
                        name="happy-outline"
                        size={20}
                        color={disabled ? theme.colors.textTertiary : theme.colors.textSecondary}
                    />
                </TouchableOpacity>
            )}

            {onPollPress && (
                <TouchableOpacity
                    onPress={onPollPress}
                    disabled={disabled || hasMedia}
                    style={styles.button}
                >
                    <Ionicons
                        name="stats-chart-outline"
                        size={20}
                        color={disabled || hasMedia ? theme.colors.textTertiary : (hasPoll ? theme.colors.primary : theme.colors.textSecondary)}
                    />
                </TouchableOpacity>
            )}

            {onSchedulePress && (
                <TouchableOpacity
                    onPress={onSchedulePress}
                    disabled={disabled}
                    style={styles.button}
                >
                    <Ionicons
                        name="calendar-outline"
                        size={20}
                        color={disabled ? theme.colors.textTertiary : theme.colors.textSecondary}
                    />
                </TouchableOpacity>
            )}

            {onLocationPress && (
                <TouchableOpacity
                    onPress={onLocationPress}
                    disabled={disabled || isGettingLocation}
                    style={styles.button}
                >
                    {isGettingLocation ? (
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    ) : (
                        <Ionicons
                            name="location-outline"
                            size={20}
                            color={disabled ? theme.colors.textTertiary : (hasLocation ? theme.colors.primary : theme.colors.textSecondary)}
                        />
                    )}
                </TouchableOpacity>
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    toolbar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 16,
        paddingVertical: 8,
    },
    button: {
        padding: 4,
    },
});

export default ComposeToolbar;
