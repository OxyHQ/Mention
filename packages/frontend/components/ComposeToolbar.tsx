import React from 'react';
import { View, ScrollView } from 'react-native';
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
    contentPaddingLeft?: number;
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
    contentPaddingLeft,
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
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ alignItems: 'center', gap: 8, paddingVertical: 8, paddingLeft: contentPaddingLeft }}
        >
            {onMediaPress && (
                <PressableScale
                    onPress={withHaptic(onMediaPress)}
                    disabled={disabled || hasPoll}
                    className="p-1"
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
                    className="p-1"
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
                    className="p-1"
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
                    className="p-1"
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
                    className="p-1"
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
                    className="p-1"
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
                    className="p-1"
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
                    className="p-1"
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
                    className="p-1"
                    style={!scheduleEnabled ? { opacity: 0.6 } : undefined}
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
                    className="p-1"
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
        </ScrollView>
    );
};

export default ComposeToolbar;
