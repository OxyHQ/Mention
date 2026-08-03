import React, { memo, useCallback, useMemo } from 'react';
import { ScrollView } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Loading } from '@oxyhq/bloom/loading';
import { useTheme } from '@oxyhq/bloom/theme';
import { useHaptics } from '@oxyhq/bloom/hooks';
import { PressableScale } from '@oxyhq/bloom/pressable-scale';
import { MediaIcon } from '@/assets/icons/media-icon';
import { ChannelIcon } from '@/assets/icons/channel-icon';
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
    /**
     * Open the collaborator picker — composer-wide (a collab post has one set of
     * authors), so main toolbar only, and omitted entirely where the post cannot
     * take collaborators at all.
     */
    onCollaboratorsPress?: () => void;
    /**
     * Choose the author's own lane for this post — composer-wide, so main
     * toolbar only, and omitted entirely on a REPLY: the server refuses a lane
     * there (400) and `CreateReplyRequest` drops fields it does not name, so an
     * affordance on that path would take the author's choice, answer 201 and
     * throw the lane away with nothing to tell them.
     */
    onLanePress?: () => void;
    /**
     * Choose WHO the post is by — the author themselves, or a channel account
     * they operate. Main toolbar only, and omitted entirely on a reply, an edit
     * and a thread: the server refuses another author on all three, and the reply
     * and update payloads drop fields they do not name, so an affordance there
     * would take the author's choice, answer 201 and publish under their own name
     * with nothing to tell them.
     */
    onPublishAsPress?: () => void;
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
    /** The post already carries more than one language. */
    hasLanguages?: boolean;
    /** False once the post holds the maximum author languages. */
    languageEnabled?: boolean;
    /** The post already names at least one collaborator. */
    hasCollaborators?: boolean;
    /** The post is already assigned to one of the author's lanes. */
    hasLane?: boolean;
    /** The post is authored by a channel account rather than by the author. */
    hasPublishAs?: boolean;
    /** False once the post holds the maximum collaborators. */
    collaboratorsEnabled?: boolean;
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
    onCollaboratorsPress,
    onLanePress,
    onPublishAsPress,
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
    hasLanguages = false,
    languageEnabled = true,
    hasCollaborators = false,
    collaboratorsEnabled = true,
    hasLane = false,
    hasPublishAs = false,
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

    const scheduleColor = disabled
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
                    className="p-1"
                    accessibilityRole="button"
                    // The chosen time lives in the author row's time slot, where
                    // it replaces "now" — see `ComposeScheduleIndicator`. So this
                    // control is the plain action again, and tints itself when a
                    // time is set exactly like every other icon in this row
                    // signals its attachment is present.
                    accessibilityLabel={t('compose.schedule.a11y', { defaultValue: 'Schedule this post' })}
                >
                    <CalendarIcon size={20} color={scheduleColor} />
                </PressableScale>
            )}

            {onCollaboratorsPress && (
                <PressableScale
                    onPress={withHaptic(onCollaboratorsPress)}
                    disabled={disabled || !collaboratorsEnabled}
                    className="p-1"
                    accessibilityRole="button"
                    accessibilityLabel={t('collab.inviteCollaborators', { defaultValue: 'Invite collaborators' })}
                >
                    {/* The SAME glyph the collaborator picker already labels its
                        rows with, in the two states this row uses everywhere
                        else: filled once the post names someone, outline while
                        it does not. */}
                    <Ionicons
                        name={hasCollaborators ? 'people' : 'people-outline'}
                        size={20}
                        color={disabled || !collaboratorsEnabled
                            ? theme.colors.textTertiary
                            : hasCollaborators
                                ? theme.colors.primary
                                : theme.colors.textSecondary}
                    />
                </PressableScale>
            )}

            {onPublishAsPress && (
                <PressableScale
                    onPress={withHaptic(onPublishAsPress)}
                    disabled={disabled}
                    className="p-1"
                    accessibilityRole="button"
                    accessibilityLabel={t('channels.compose.choose', { defaultValue: 'Choose who posts' })}
                >
                    {/* The SAME glyph the sidebar's Channels row uses. This is
                        the only control on the row that changes WHO the post is
                        by, and a reader who has seen it in the sidebar should not
                        have to learn a second symbol for the same idea. */}
                    <ChannelIcon
                        size={20}
                        color={disabled
                            ? theme.colors.textTertiary
                            : hasPublishAs
                                ? theme.colors.primary
                                : theme.colors.textSecondary}
                    />
                </PressableScale>
            )}

            {onLanePress && (
                <PressableScale
                    onPress={withHaptic(onLanePress)}
                    disabled={disabled}
                    className="p-1"
                    accessibilityRole="button"
                    accessibilityLabel={t('lanes.compose.choose', { defaultValue: 'Choose a lane' })}
                >
                    {/* A signpost, in the two states this row uses everywhere
                        else: filled once the post is on a lane, outline while it
                        is not. */}
                    <Ionicons
                        name={hasLane ? 'git-branch' : 'git-branch-outline'}
                        size={20}
                        color={disabled
                            ? theme.colors.textTertiary
                            : hasLane
                                ? theme.colors.primary
                                : theme.colors.textSecondary}
                    />
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
