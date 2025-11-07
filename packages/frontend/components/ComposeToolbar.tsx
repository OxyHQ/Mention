import React from 'react';
import { View, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { MediaIcon } from '@/assets/icons/media-icon';
import { PollIcon } from '@/assets/icons/poll-icon';
import { LocationIcon } from '@/assets/icons/location-icon';
import { EmojiIcon } from '@/assets/icons/emoji-icon';
import { GifIcon } from '@/assets/icons/gif-icon';
import { SourcesIcon } from '@/assets/icons/sources-icon';
import { ArticleIcon } from '@/assets/icons/article-icon';
import { CalendarIcon } from '@/assets/icons/calendar-icon';

interface ComposeToolbarProps {
    onMediaPress?: () => void;
    onPollPress?: () => void;
    onLocationPress?: () => void;
    onGifPress?: () => void;
    onEmojiPress?: () => void;
    onSchedulePress?: () => void;
    onSourcesPress?: () => void;
    onArticlePress?: () => void;
    hasLocation?: boolean;
    isGettingLocation?: boolean;
    hasPoll?: boolean;
    hasMedia?: boolean;
    hasSources?: boolean;
    hasArticle?: boolean;
    hasSchedule?: boolean;
    scheduleEnabled?: boolean;
    hasSourceErrors?: boolean;
    disabled?: boolean;
}

const ComposeToolbar: React.FC<ComposeToolbarProps> = ({
    onMediaPress,
    onPollPress,
    onLocationPress,
    onGifPress,
    onEmojiPress,
    onSchedulePress,
    onSourcesPress,
    onArticlePress,
    hasLocation = false,
    isGettingLocation = false,
    hasPoll = false,
    hasMedia = false,
    hasSources = false,
    hasArticle = false,
    hasSchedule = false,
    scheduleEnabled = true,
    hasSourceErrors = false,
    disabled = false,
}) => {
    const theme = useTheme();

    const scheduleColor = (disabled || !scheduleEnabled)
        ? theme.colors.textTertiary
        : hasSchedule
            ? theme.colors.primary
            : theme.colors.textSecondary;

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

            {onSourcesPress && (
                <TouchableOpacity
                    onPress={onSourcesPress}
                    disabled={disabled}
                    style={styles.button}
                >
                    <SourcesIcon
                        size={20}
                        color={disabled
                            ? theme.colors.textTertiary
                            : hasSourceErrors
                                ? (theme.colors.error || '#ff4d4f')
                                : hasSources
                                    ? theme.colors.primary
                                    : theme.colors.textSecondary}
                    />
                </TouchableOpacity>
            )}

            {onArticlePress && (
                <TouchableOpacity
                    onPress={onArticlePress}
                    disabled={disabled}
                    style={styles.button}
                >
                    <ArticleIcon
                        size={20}
                        color={disabled ? theme.colors.textTertiary : theme.colors.textSecondary}
                    />
                </TouchableOpacity>
            )}

            {onSchedulePress && (
                <TouchableOpacity
                    onPress={onSchedulePress}
                    disabled={disabled}
                    activeOpacity={scheduleEnabled ? 0.7 : 1}
                    style={[styles.button, !scheduleEnabled && { opacity: 0.6 }]}
                >
                    <View style={{ opacity: disabled ? 0.3 : 1 }}>
                        <CalendarIcon
                            size={20}
                            color={scheduleColor}
                        />
                    </View>
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
