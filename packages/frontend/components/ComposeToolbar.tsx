import React, { memo, useCallback, useMemo } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Loading } from '@oxyhq/bloom/loading';
import { useTheme } from '@oxyhq/bloom/theme';
import { useHaptics } from '@oxyhq/bloom/hooks';
import { PressableScale } from '@oxyhq/bloom/pressable-scale';
import { MediaIcon } from '@/assets/icons/media-icon';
import { PollIcon } from '@/assets/icons/poll-icon';
import { LocationIcon } from '@/assets/icons/location-icon';
import { EmojiIcon } from '@/assets/icons/emoji-icon';
import { GifIcon } from '@/assets/icons/gif-icon';
import { SourcesIcon } from '@/assets/icons/sources-icon';
import { ArticleIcon } from '@/assets/icons/article-icon';
import { CalendarIcon } from '@/assets/icons/calendar-icon';
import Ionicons from '@expo/vector-icons/Ionicons';

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
    onPodcastPress?: () => void;
    /** Add another language to the post — composer-wide, so main toolbar only. */
    onLanguagePress?: () => void;
    hasLocation?: boolean;
    isGettingLocation?: boolean;
    hasPoll?: boolean;
    hasMedia?: boolean;
    hasSources?: boolean;
    hasArticle?: boolean;
    hasEvent?: boolean;
    hasRoom?: boolean;
    hasPodcast?: boolean;
    hasSchedule?: boolean;
    scheduleEnabled?: boolean;
    /** The post already carries more than one language. */
    hasLanguages?: boolean;
    /** False once the post holds the maximum author languages. */
    languageEnabled?: boolean;
    /**
     * The chosen publish time, already formatted. Present ⇒ the schedule control
     * IS the indicator: it shows the time inline instead of a separate card
     * explaining it. Absent ⇒ the post goes out now and the control is the bare
     * icon.
     */
    scheduledLabel?: string;
    hasSourceErrors?: boolean;
    disabled?: boolean;
}

const ComposeToolbar = memo<ComposeToolbarProps>(({
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
    onPodcastPress,
    onLanguagePress,
    hasLocation = false,
    isGettingLocation = false,
    hasPoll = false,
    hasMedia = false,
    hasSources = false,
    hasArticle = false,
    hasEvent = false,
    hasRoom = false,
    hasPodcast = false,
    hasSchedule = false,
    scheduleEnabled = true,
    scheduledLabel,
    hasLanguages = false,
    languageEnabled = true,
    hasSourceErrors = false,
    disabled = false,
}) => {
    const theme = useTheme();
    const haptic = useHaptics();
    const { t } = useTranslation();

    const withHaptic = useCallback((handler?: () => void) => () => {
        haptic('light');
        handler?.();
    }, [haptic]);

    const scheduleColor = (disabled || !scheduleEnabled)
        ? theme.colors.textTertiary
        : hasSchedule
            ? theme.colors.primary
            : theme.colors.textSecondary;

    const contentContainerStyle = useMemo(() => ({
        alignItems: 'center' as const,
        gap: 8,
        paddingVertical: 8,
        paddingLeft: contentPaddingLeft,
    }), [contentPaddingLeft]);

    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={contentContainerStyle}
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

            {onPodcastPress && (
                <PressableScale
                    onPress={withHaptic(onPodcastPress)}
                    disabled={disabled}
                    className="p-1"
                    accessibilityLabel={t('compose.podcast.add')}
                >
                    <Ionicons
                        name="mic-outline"
                        size={20}
                        color={disabled ? theme.colors.textTertiary : (hasPodcast ? theme.colors.primary : theme.colors.textSecondary)}
                    />
                </PressableScale>
            )}

            {onLanguagePress && (
                <PressableScale
                    onPress={withHaptic(onLanguagePress)}
                    disabled={disabled || !languageEnabled}
                    className="p-1"
                    accessibilityRole="button"
                    accessibilityLabel={t('compose.languages.add', { defaultValue: 'Add a language' })}
                >
                    {/* The SAME icon the post component marks a translation
                        with, in the same two states: `PostActions` renders
                        `isTranslated ? 'language' : 'language-outline'` tinted
                        primary or secondary. Here "carries another language" is
                        the authoring side of that same fact, so the control that
                        writes one and the badge that reads one look alike. */}
                    <Ionicons
                        name={hasLanguages ? 'language' : 'language-outline'}
                        size={20}
                        color={disabled || !languageEnabled
                            ? theme.colors.textTertiary
                            : hasLanguages
                                ? theme.colors.primary
                                : theme.colors.textSecondary}
                    />
                </PressableScale>
            )}

            {onSchedulePress && (
                <PressableScale
                    onPress={withHaptic(onSchedulePress)}
                    disabled={disabled}
                    // The tint is `bg-primary/10`, NOT a hand-built
                    // `${theme.colors.primary}1A`: this theme's `primary` is
                    // `rgb(0 98 157)`, so appending hex alpha to it yields a
                    // string react-native-web parses back to FULLY OPAQUE
                    // primary — which paints primary text on a primary pill and
                    // hides the time completely. Caught in a browser, invisible
                    // to jest.
                    className={scheduledLabel
                        ? 'flex-row items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary/10'
                        : 'p-1'}
                    style={!scheduleEnabled ? { opacity: 0.6 } : undefined}
                    accessibilityRole="button"
                    // The label carries the STATE, not just the action: a screen
                    // reader has no colour or chip shape to go on.
                    accessibilityLabel={scheduledLabel
                        ? t('compose.schedule.chipA11y', {
                            defaultValue: 'Scheduled for {{time}}. Tap to change.',
                            time: scheduledLabel,
                        })
                        : t('compose.schedule.a11y', { defaultValue: 'Schedule this post' })}
                >
                    <View style={{ opacity: disabled ? 0.3 : 1 }}>
                        <CalendarIcon
                            size={20}
                            color={scheduledLabel ? theme.colors.primary : scheduleColor}
                        />
                    </View>
                    {scheduledLabel ? (
                        <Text
                            className="text-primary text-[13px] font-semibold"
                            style={{ opacity: disabled ? 0.3 : 1 }}
                            numberOfLines={1}
                        >
                            {scheduledLabel}
                        </Text>
                    ) : null}
                </PressableScale>
            )}

            {onLocationPress && (
                <PressableScale
                    onPress={withHaptic(onLocationPress)}
                    disabled={disabled || isGettingLocation}
                    className="p-1"
                >
                    {isGettingLocation ? (
                        <Loading className="text-primary" variant="inline" size="small" style={{ flex: undefined }} />
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
});

ComposeToolbar.displayName = 'ComposeToolbar';

export default ComposeToolbar;
