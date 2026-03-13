import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Loading } from '@/components/ui/Loading';
import { useTheme } from '@/hooks/useTheme';
import { useHaptics } from '@/hooks/useHaptics';
import { PressableScale } from '@/lib/animations/PressableScale';
import { MediaIcon } from '@/assets/icons/media-icon';
import { PollIcon } from '@/assets/icons/poll-icon';
import { LocationIcon } from '@/assets/icons/location-icon';
import { EmojiIcon } from '@/assets/icons/emoji-icon';
import { GifIcon } from '@/assets/icons/gif-icon';
import { SourcesIcon } from '@/assets/icons/sources-icon';
import { ArticleIcon } from '@/assets/icons/article-icon';
import { CalendarIcon } from '@/assets/icons/calendar-icon';
import { Ionicons } from '@expo/vector-icons';

interface ComposeToolbarProps {
    onMediaPress?: () => void;
    onPollPress?: () => void;
    onLocationPress?: () => void;
    onGifPress?: () => void;
    onEmojiPress?: () => void;
    onSchedulePress?: () => void;
    onSourcesPress?: () => void;
    onArticlePress?: () => void;
    onEventPress?: () => void;
    onRoomPress?: () => void;
    hasLocation?: boolean;
    isGettingLocation?: boolean;
    hasPoll?: boolean;
    hasMedia?: boolean;
    hasSources?: boolean;
    hasArticle?: boolean;
    hasEvent?: boolean;
    hasRoom?: boolean;
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
    onEventPress,
    onRoomPress,
    hasLocation = false,
    isGettingLocation = false,
    hasPoll = false,
    hasMedia = false,
    hasSources = false,
    hasArticle = false,
    hasEvent = false,
    hasRoom = false,
    hasSchedule = false,
    scheduleEnabled = true,
    hasSourceErrors = false,
    disabled = false,
}) => {
    const theme = useTheme();
    const haptic = useHaptics();

    const withHaptic = (handler?: () => void) => () => {
        haptic('Light');
        handler?.();
    };

    const scheduleColor = (disabled || !scheduleEnabled)
        ? theme.colors.textTertiary
        : hasSchedule
            ? theme.colors.primary
            : theme.colors.textSecondary;

    return (
        <View style={styles.toolbar}>
            {onMediaPress && (
                <PressableScale
                    onPress={withHaptic(onMediaPress)}
                    disabled={disabled || hasPoll}
                    style={styles.button}
                >
                    <MediaIcon
                        size={20}
                        color={disabled || hasPoll ? theme.colors.textTertiary : theme.colors.textSecondary}
                    />
                </PressableScale>
            )}

            {onGifPress && (
                <PressableScale
                    onPress={withHaptic(onGifPress)}
                    disabled={disabled}
                    style={styles.button}
                >
                    <GifIcon
                        size={20}
                        color={disabled ? theme.colors.textTertiary : theme.colors.textSecondary}
                    />
                </PressableScale>
            )}

            {onEmojiPress && (
                <PressableScale
                    onPress={withHaptic(onEmojiPress)}
                    disabled={disabled}
                    style={styles.button}
                >
                    <EmojiIcon
                        size={20}
                        color={disabled ? theme.colors.textTertiary : theme.colors.textSecondary}
                    />
                </PressableScale>
            )}

            {onPollPress && (
                <PressableScale
                    onPress={withHaptic(onPollPress)}
                    disabled={disabled || hasMedia}
                    style={styles.button}
                >
                    <PollIcon
                        size={20}
                        color={disabled || hasMedia ? theme.colors.textTertiary : (hasPoll ? theme.colors.primary : theme.colors.textSecondary)}
                    />
                </PressableScale>
            )}

            {onSourcesPress && (
                <PressableScale
                    onPress={withHaptic(onSourcesPress)}
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
                </PressableScale>
            )}

            {onArticlePress && (
                <PressableScale
                    onPress={withHaptic(onArticlePress)}
                    disabled={disabled}
                    style={styles.button}
                >
                    <ArticleIcon
                        size={20}
                        color={disabled ? theme.colors.textTertiary : (hasArticle ? theme.colors.primary : theme.colors.textSecondary)}
                    />
                </PressableScale>
            )}

            {onEventPress && (
                <PressableScale
                    onPress={withHaptic(onEventPress)}
                    disabled={disabled}
                    style={styles.button}
                >
                    <CalendarIcon
                        size={20}
                        color={disabled ? theme.colors.textTertiary : (hasEvent ? theme.colors.primary : theme.colors.textSecondary)}
                    />
                </PressableScale>
            )}

            {onRoomPress && (
                <PressableScale
                    onPress={withHaptic(onRoomPress)}
                    disabled={disabled}
                    style={styles.button}
                >
                    <Ionicons
                        name="radio-outline"
                        size={20}
                        color={disabled ? theme.colors.textTertiary : (hasRoom ? theme.colors.primary : theme.colors.textSecondary)}
                    />
                </PressableScale>
            )}

            {onSchedulePress && (
                <PressableScale
                    onPress={withHaptic(onSchedulePress)}
                    disabled={disabled}
                    style={[styles.button, !scheduleEnabled && { opacity: 0.6 }]}
                >
                    <View style={{ opacity: disabled ? 0.3 : 1 }}>
                        <CalendarIcon
                            size={20}
                            color={scheduleColor}
                        />
                    </View>
                </PressableScale>
            )}

            {onLocationPress && (
                <PressableScale
                    onPress={withHaptic(onLocationPress)}
                    disabled={disabled || isGettingLocation}
                    style={styles.button}
                >
                    {isGettingLocation ? (
                        <Loading variant="inline" size="small" style={{ flex: undefined }} />
                    ) : (
                        <LocationIcon
                            size={20}
                            color={disabled ? theme.colors.textTertiary : (hasLocation ? theme.colors.primary : theme.colors.textSecondary)}
                        />
                    )}
                </PressableScale>
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
