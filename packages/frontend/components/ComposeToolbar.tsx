import React, { memo, useCallback, useMemo } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Loading } from '@oxy.so/bloom/loading';
import { useTheme } from '@oxy.so/bloom/theme';
import { useHaptics } from '@oxy.so/bloom/hooks';
import { GlyphButton } from '@oxy.so/bloom/button';
import { RiBroadcastLine } from '@oxy.so/bloom/icons/RiBroadcastLine';
import { RiGroupFill } from '@oxy.so/bloom/icons/RiGroupFill';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiMic2Line } from '@oxy.so/bloom/icons/RiMic2Line';
import { MediaIcon } from '@/assets/icons/media-icon';
import { PollIcon } from '@/assets/icons/poll-icon';
import { LocationIcon } from '@/assets/icons/location-icon';
import { EmojiIcon } from '@/assets/icons/emoji-icon';
import { GifIcon } from '@/assets/icons/gif-icon';
import { SourcesIcon } from '@/assets/icons/sources-icon';
import { ArticleIcon } from '@/assets/icons/article-icon';
import { CalendarIcon } from '@/assets/icons/calendar-icon';
import { LaneIcon } from '@/assets/icons/lane-icon';
import Ionicons from '@/components/common/Ionicons';

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
     * Attach one of the composing account's own Mention job listings
     * (OxyHQ/Mention#952). Omitted outright — not merely disabled — when the
     * composing account is not an organization/project operator, since only
     * those accounts have jobs to attach; see `ComposeScreen.tsx`'s
     * `canAttachJob`.
     */
    onJobPress?: () => void;
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
    /** The post already has a Mention job attached (OxyHQ/Mention#952). */
    hasJob?: boolean;
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
    onJobPress,
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
    hasJob = false,
    hasCollaborators = false,
    collaboratorsEnabled = true,
    hasLane = false,
    hasSourceErrors = false,
    disabled = false,
}) => {
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
        // The last icon clears the screen edge by the composer's own gutter
        // instead of ending flush against it.
        paddingRight: TOOLBAR_TRAILING_PAD,
    }), [contentPaddingLeft]);

    const CollaboratorsIcon = hasCollaborators ? RiGroupFill : RiGroupLine;

    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            style={styles.scroller}
            contentContainerStyle={contentContainerStyle}
        >
            {onMediaPress && (
                <ToolbarAction
                    label={t('compose.toolbar.media', { defaultValue: 'Add photos or videos' })}
                    onPress={withHaptic(onMediaPress)}
                    disabled={disabled || hasPoll}
                >
                    {(color) => <MediaIcon size={20} color={color} />}
                </ToolbarAction>
            )}

            {onGifPress && (
                <ToolbarAction
                    label={t('compose.toolbar.gif', { defaultValue: 'Add a GIF' })}
                    onPress={withHaptic(onGifPress)}
                    disabled={disabled}
                >
                    {(color) => <GifIcon size={20} color={color} />}
                </ToolbarAction>
            )}

            {onEmojiPress && (
                <ToolbarAction
                    label={t('compose.toolbar.emoji', { defaultValue: 'Add an emoji' })}
                    onPress={withHaptic(onEmojiPress)}
                    disabled={disabled}
                >
                    {(color) => <EmojiIcon size={20} color={color} />}
                </ToolbarAction>
            )}

            {onPollPress && (
                <ToolbarAction
                    label={t('compose.toolbar.poll', { defaultValue: 'Add a poll' })}
                    onPress={withHaptic(onPollPress)}
                    disabled={disabled || hasMedia}
                    active={hasPoll}
                >
                    {(color) => <PollIcon size={20} color={color} />}
                </ToolbarAction>
            )}

            {onSourcesPress && (
                <ToolbarAction
                    label={t('compose.toolbar.sources', { defaultValue: 'Add sources' })}
                    onPress={withHaptic(onSourcesPress)}
                    disabled={disabled}
                    invalid={hasSourceErrors}
                    active={hasSources}
                >
                    {(color) => <SourcesIcon size={20} color={color} />}
                </ToolbarAction>
            )}

            {onArticlePress && (
                <ToolbarAction
                    label={t('compose.toolbar.article', { defaultValue: 'Write an article' })}
                    onPress={withHaptic(onArticlePress)}
                    disabled={disabled}
                    active={hasArticle}
                >
                    {(color) => <ArticleIcon size={20} color={color} />}
                </ToolbarAction>
            )}

            {onEventPress && (
                <ToolbarAction
                    label={t('compose.toolbar.event', { defaultValue: 'Add an event' })}
                    onPress={withHaptic(onEventPress)}
                    disabled={disabled}
                    active={hasEvent}
                >
                    {(color) => <CalendarIcon size={20} color={color} />}
                </ToolbarAction>
            )}

            {onRoomPress && (
                <ToolbarAction
                    label={t('compose.toolbar.room', { defaultValue: 'Attach a live room' })}
                    onPress={withHaptic(onRoomPress)}
                    disabled={disabled}
                    active={hasRoom}
                >
                    {(color) => <RiBroadcastLine size="md" fill={color} />}
                </ToolbarAction>
            )}

            {onPodcastPress && (
                <ToolbarAction
                    label={t('compose.toolbar.podcast', { defaultValue: 'Add a podcast' })}
                    onPress={withHaptic(onPodcastPress)}
                    disabled={disabled}
                    active={hasPodcast}
                >
                    {(color) => <RiMic2Line size="md" fill={color} />}
                </ToolbarAction>
            )}

            {onJobPress && (
                <ToolbarAction
                    label={t('compose.job.add', { defaultValue: 'Attach a job' })}
                    onPress={withHaptic(onJobPress)}
                    disabled={disabled}
                    active={hasJob}
                >
                    {(color) => <Ionicons name="briefcase-outline" size={20} color={color} />}
                </ToolbarAction>
            )}

            {onCollaboratorsPress && (
                <ToolbarAction
                    label={t('collab.inviteCollaborators', { defaultValue: 'Invite collaborators' })}
                    onPress={withHaptic(onCollaboratorsPress)}
                    disabled={disabled || !collaboratorsEnabled}
                    active={hasCollaborators}
                >
                    {/* The SAME glyph the collaborator picker already labels its
                        rows with, in the two states this row uses everywhere
                        else: filled once the post names someone, outline while
                        it does not. */}
                    {(color) => <CollaboratorsIcon size="md" fill={color} />}
                </ToolbarAction>
            )}

            {/* WHO the post is by is not on this row. It is the box's own avatar
                — the thing that already shows the answer — so the control and
                what it changes are the same object, and every box in beast mode
                gets its own without a toolbar each. */}

            {onLanePress && (
                <ToolbarAction
                    label={t('lanes.compose.choose', { defaultValue: 'Choose a lane' })}
                    onPress={withHaptic(onLanePress)}
                    disabled={disabled}
                    active={hasLane}
                >
                    {/* Parallel tracks, not a branch. A branch is a fork — one
                        history splitting into divergent ones — and a lane forks
                        nothing: the post's distribution, visibility, replies and
                        federation are untouched by it. It is a track the post is
                        filed on. The tint carries the on/off state, the way every
                        other icon in this row signals its attachment. */}
                    {(color) => <LaneIcon size={20} color={color} />}
                </ToolbarAction>
            )}

            {onLocationPress && (
                <ToolbarAction
                    label={t('compose.toolbar.location', { defaultValue: 'Add your location' })}
                    onPress={withHaptic(onLocationPress)}
                    disabled={disabled}
                    busy={isGettingLocation}
                    active={hasLocation}
                >
                    {(color) => (isGettingLocation
                        ? <Loading className="text-primary" variant="inline" size="small" style={{ flex: undefined }} />
                        : <LocationIcon size={20} color={color} />)}
                </ToolbarAction>
            )}
        </ScrollView>
    );
});

/**
 * One control of the row: Bloom's `GlyphButton`, so every control is a real
 * button with a required name, keyboard focus and activation, a hover wash and
 * a focus ring — the row used to be hand-rolled pressables, most of them with
 * no name or role (OxyHQ/Mention#1124).
 *
 * The tint says whether the post already carries this attachment (`active`) or
 * has a problem with it (`invalid`); `busy` is announced while it works.
 */
interface ToolbarActionProps {
    label: string;
    onPress: () => void;
    disabled: boolean;
    busy?: boolean;
    /** The post already carries this attachment. */
    active?: boolean;
    /** This attachment needs the author's attention (sources missing a title). */
    invalid?: boolean;
    /** The glyph, painted in the colour the control's state resolves to. */
    children: (color: string) => React.ReactNode;
}

const ToolbarAction = ({ label, onPress, disabled, busy, active = false, invalid = false, children }: ToolbarActionProps) => {
    const theme = useTheme();
    const tint = invalid ? theme.colors.error : active ? theme.colors.primary : undefined;
    return (
        <GlyphButton
            size={TOOLBAR_ACTION_SIZE}
            glyphSize={TOOLBAR_GLYPH_SIZE}
            accessibilityLabel={label}
            onPress={onPress}
            disabled={disabled}
            busy={busy}
            color={tint}
            hoverColor={tint}
        >
            {children}
        </GlyphButton>
    );
};

/** The glyphs are 20px, and the target keeps the 4px of padding round each it had. */
const TOOLBAR_GLYPH_SIZE = 20;
const TOOLBAR_ACTION_SIZE = 28;

ComposeToolbar.displayName = 'ComposeToolbar';

/** The composer's horizontal gutter (`composeLayout.HPAD`). */
const TOOLBAR_TRAILING_PAD = 16;

const styles = StyleSheet.create({
    // Every caller puts this row inside a `flexDirection: 'row'` wrapper. A
    // horizontal ScrollView there sizes to its CONTENT on native (a flex child
    // does not shrink by default), so with more icons than the screen is wide
    // the scroller itself was wider than the screen: nothing to scroll, and the
    // last icon clipped off the right edge (OxyHQ/Mention#1140). Shrinking to
    // the row it is in is what gives it something to scroll; `minWidth: 0`
    // does the same for web, where a flex item's minimum is its content.
    scroller: {
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
    },
});

export default ComposeToolbar;
