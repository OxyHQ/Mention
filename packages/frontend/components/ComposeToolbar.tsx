import React, { memo, useCallback, useMemo } from 'react';
import { ScrollView } from 'react-native';
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
import { LaneIcon } from '@/assets/icons/lane-icon';
import Ionicons from '@expo/vector-icons/Ionicons';

/**
 * The attachment row under ONE compose box.
 *
 * Every control here writes a property of THAT post, so the row is the same on
 * the first box and on the tenth. What decides membership is the wire: an
 * affordance belongs here if, and only if, the payload carries its property PER
 * ENTRY. Anything the server reads once for the whole batch is a property of the
 * BATCH and lives at the composer level instead — putting it here would make
 * whichever box drew it look like the one that owns it.
 *
 * Two controls were moved out on exactly that test, and must not come back:
 *
 *  - **The schedule.** `POST /posts/thread` reads `scheduledFor` from the TOP
 *    level and stamps every entry with the same instant; a per-entry
 *    `scheduledFor` is not a field of `CreateThreadPostRequest` and is ignored
 *    outright. It lives in the composer's footer, beside the other whole-batch
 *    decisions.
 *  - **Adding a language.** The declared languages are one set for the whole
 *    composer — the renditions are a buffer keyed by (item × language), so there
 *    is no such thing as adding a language to one box. It lives on the language
 *    tab strip, which is already the composer-wide surface for them.
 */
interface ComposeToolbarProps {
    contentPaddingLeft?: number;
    onMediaPress?: () => void;
    onPollPress?: () => void;
    onLocationPress?: () => void;
    onGifPress?: () => void;
    onEmojiPress?: () => void;
    onSourcesPress?: () => void;
    onArticlePress?: () => void;
    onEventPress?: () => void;
    onRoomPress?: () => void;
    onPodcastPress?: () => void;
    /**
     * Open the collaborator picker. A post's collaborators are its own, but a
     * BATCH cannot have any — `POST /posts/thread` refuses `collaboratorIds`
     * outright, per entry and at the top level alike (400) — so the composer
     * omits this the moment a second box exists.
     */
    onCollaboratorsPress?: () => void;
    /**
     * Choose the publisher's lane for this post. Per entry, and the composer
     * decides which boxes may offer it: `POST /posts/thread` takes a lane on
     * every entry of a BEAST batch, and on a thread's ROOT only — a
     * continuation is a reply, and a reply carries no lane (400). Omitted on a
     * reply and an edit for the same reason: the payload drops what it does not
     * name, so the choice would be taken, answered 201, and thrown away.
     */
    onLanePress?: () => void;
    hasLocation?: boolean;
    isGettingLocation?: boolean;
    hasPoll?: boolean;
    hasMedia?: boolean;
    hasSources?: boolean;
    hasArticle?: boolean;
    hasEvent?: boolean;
    hasRoom?: boolean;
    hasPodcast?: boolean;
    /** The post already names at least one collaborator. */
    hasCollaborators?: boolean;
    /** The post is already assigned to one of the publisher's lanes. */
    hasLane?: boolean;
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
    onSourcesPress,
    onArticlePress,
    onEventPress,
    onRoomPress,
    onPodcastPress,
    onCollaboratorsPress,
    onLanePress,
    hasLocation = false,
    isGettingLocation = false,
    hasPoll = false,
    hasMedia = false,
    hasSources = false,
    hasArticle = false,
    hasEvent = false,
    hasRoom = false,
    hasPodcast = false,
    hasCollaborators = false,
    collaboratorsEnabled = true,
    hasLane = false,
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
                    // Labelled but role-less until now, alone among the labelled
                    // controls in this row — a screen reader announced the name
                    // without saying it could be activated.
                    accessibilityRole="button"
                    accessibilityLabel={t('compose.podcast.add')}
                >
                    <Ionicons
                        name="mic-outline"
                        size={20}
                        color={disabled ? theme.colors.textTertiary : (hasPodcast ? theme.colors.primary : theme.colors.textSecondary)}
                    />
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

            {/* WHO the post is by is not on this row. It is the box's own avatar
                — the thing that already shows the answer — so the control and
                what it changes are the same object, and every box in beast mode
                gets its own without a toolbar each. */}

            {onLanePress && (
                <PressableScale
                    onPress={withHaptic(onLanePress)}
                    disabled={disabled}
                    className="p-1"
                    accessibilityRole="button"
                    accessibilityLabel={t('lanes.compose.choose', { defaultValue: 'Choose a lane' })}
                >
                    {/* Parallel tracks, not a branch. A branch is a fork — one
                        history splitting into divergent ones — and a lane forks
                        nothing: the post's distribution, visibility, replies and
                        federation are untouched by it. It is a track the post is
                        filed on. The tint carries the on/off state, the way every
                        other icon in this row signals its attachment. */}
                    <LaneIcon
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
