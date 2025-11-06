import React from 'react';
import { View, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { MediaIcon } from '@/assets/icons/media-icon';
import { PollIcon } from '@/assets/icons/poll-icon';
import { LocationIcon } from '@/assets/icons/location-icon';
import { EmojiIcon } from '@/assets/icons/emoji-icon';
import { GifIcon } from '@/assets/icons/gif-icon';

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
                    <MediaIcon
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
                    <GifIcon
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
                    <EmojiIcon
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
                    <PollIcon
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
                    {/* TODO: Add calendar icon when available */}
                    <View style={{ width: 20, height: 20, backgroundColor: theme.colors.textSecondary, opacity: disabled ? 0.3 : 1 }} />
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
                        <LocationIcon
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
        gap: 8,
        paddingVertical: 8,
    },
    button: {
        padding: 4,
    },
});

export default ComposeToolbar;
