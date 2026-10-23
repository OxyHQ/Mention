import React, { useState } from 'react';
import { StyleSheet, Text, View, type PressableProps } from 'react-native';
import { SpinnerIcon } from '@oxy.so/bloom/loading';
import { RiTranslate2 } from '@oxy.so/bloom/icons/RiTranslate2';
import { RiSendPlaneLine } from '@oxy.so/bloom/icons/RiSendPlaneLine';
import { RiBarChartBoxLine } from '@oxy.so/bloom/icons/RiBarChartBoxLine';
import { RiBookmarkFill } from '@oxy.so/bloom/icons/RiBookmarkFill';
import { RiBookmarkLine } from '@oxy.so/bloom/icons/RiBookmarkLine';
import { RiChat3Line } from '@oxy.so/bloom/icons/RiChat3Line';
import { RiRepeat2Line } from '@oxy.so/bloom/icons/RiRepeat2Line';
import { RiUpload2Line } from '@oxy.so/bloom/icons/RiUpload2Line';

import { useTheme } from '@oxy.so/bloom/theme';
import { useHaptics } from '@oxy.so/bloom/hooks';
import { formatCompactNumber } from '@/utils/formatNumber';
import { PressableScale } from '@oxy.so/bloom/pressable-scale';
import { AnimatedLikeIcon } from '@/lib/animations/AnimatedLikeIcon';
import { CountWheel } from '@/lib/animations/CountWheel';
import { useVoteStyle } from '@/hooks/useVoteStyle';
import { HIT_SLOP_MD } from '@/styles/hitSlop';
import VotePill from './VotePill';

const ICON_SIZE = 20;

/** Only what the bar itself renders. Counts it does not show (quotes, views) live on <PostDetailStats>. */
interface Engagement {
  replies: number | null;
  likes: number | null;
  /**
   * Shown beside the boost icon, like the like count beside the heart. The bar
   * used to show likes and saves and leave boosts blank, so a post boosted once
   * read as a post nobody had boosted (OxyHQ/Mention#1140).
   */
  boosts?: number | null;
  downvotes?: number | null;
  saves?: number | null;
}

interface Props {
  engagement: Engagement;
  isLiked?: boolean;
  isDownvoted?: boolean;
  isBoosted?: boolean;
  isSaved?: boolean;
  /**
   * Omitted on a post that takes no replies — the server refused them (a channel
   * account's post, an audience the viewer is outside of) or the author set
   * `replyPermission: ['nobody']` — and the button is then not rendered rather
   * than rendered dead. The caller derives that from the POST
   * (`postAcceptsReplies`), never from a flag threaded down through `PostItem`.
   */
  onReply?: () => void;
  onBoost: () => void;
  /** Returning false rejects the action without mounting the like animation. */
  onLike: () => boolean | undefined;
  onDownvote?: () => void;
  onSave: () => void;
  onShare: () => void;
  /**
   * Send the post to someone in Allo — Instagram's paper plane. Mention has no
   * chat of its own, so this hands the post's link to Allo's share picker.
   */
  onSendInAllo?: () => void;
  onInsightsPress?: () => void;
  /**
   * Translate into the reader's own language, or undo it. Absent for a post
   * already written in that language — translating it would do nothing, so it
   * gets no icon rather than a dead one.
   */
  onTranslate?: () => void;
  /**
   * Read this post in some OTHER language. Reached by a long press on the same
   * icon, and — because a long press is neither discoverable nor operable by a
   * screen reader — by the `translateTo` accessibility action beside it.
   */
  onTranslateLongPress?: () => void;
  isTranslated?: boolean;
  isTranslating?: boolean;
  postId?: string;
}

const PostActions: React.FC<Props> = ({
  engagement,
  isLiked,
  isDownvoted,
  isBoosted,
  isSaved,
  onReply,
  onBoost,
  onLike,
  onDownvote,
  onSave,
  onShare,
  onSendInAllo,
  onInsightsPress,
  onTranslate,
  onTranslateLongPress,
  isTranslated,
  isTranslating,
}) => {
  const theme = useTheme();
  const haptic = useHaptics();
  // State, not a ref: reading `ref.current` during render made the React
  // Compiler skip this whole component — which every row mounts (#1103). It
  // flips once, on the first like, in the same batch as the like itself.
  const [hasBeenToggled, setHasBeenToggled] = useState(false);
  const voteStyle = useVoteStyle();

  const replies = engagement?.replies ?? 0;
  const likes = engagement?.likes ?? 0;
  const saves = engagement?.saves ?? 0;
  const boosts = engagement?.boosts ?? 0;
  const downvotes = engagement?.downvotes ?? 0;

  // The translate icon's SECOND job — reading the post in some other language —
  // hung off a long press, which no screen reader performs, so the accessibility
  // action carries the same call. Both arrive together or not at all: an
  // advertised action that does nothing is worse than an absent one.
  const otherLanguagesProps: Partial<
    Pick<PressableProps, 'onLongPress' | 'accessibilityActions' | 'onAccessibilityAction'>
  > = onTranslateLongPress
    ? {
        onLongPress: () => {
          haptic('medium');
          onTranslateLongPress();
        },
        accessibilityActions: [{ name: 'translateTo', label: 'Read in another language' }],
        onAccessibilityAction: (event) => {
          if (event.nativeEvent.actionName === 'translateTo') onTranslateLongPress();
        },
      }
    : {};

  // ONE action bar, rendered identically wherever a post appears — a feed row
  // and the focused post on `/p/:id` included. A focused post adds
  // <PostDetailStats> BELOW this bar; it does not get a bar of its own.
  const actionIconRow = (
    <View className="flex-row items-center" style={{ gap: 8 }}>
      {voteStyle === 'pill' && onDownvote ? (
        <VotePill
          likeCount={likes}
          downvoteCount={downvotes}
          isLiked={!!isLiked}
          isDownvoted={!!isDownvoted}
          onUpvote={() => {
            if (onLike() === false) return;
            setHasBeenToggled(true);
          }}
          onDownvote={onDownvote}
        />
      ) : (
        <PressableScale
          style={styles.iconButton}
          onPress={() => {
            if (onLike() === false) return;
            setHasBeenToggled(true);
            haptic('light');
          }}
          hitSlop={HIT_SLOP_MD}
          accessibilityLabel={isLiked ? 'Unlike' : 'Like'}
        >
          <View className="flex-row items-center gap-1">
            <AnimatedLikeIcon isLiked={!!isLiked} hasBeenToggled={hasBeenToggled} />
            <CountWheel likeCount={likes} isLiked={!!isLiked} hasBeenToggled={hasBeenToggled} />
          </View>
        </PressableScale>
      )}

      {onReply ? (
        <PressableScale
          style={styles.countedIconButton}
          onPress={() => {
            haptic('light');
            onReply();
          }}
          hitSlop={HIT_SLOP_MD}
          accessibilityLabel="Reply"
        >
          <RiChat3Line width={ICON_SIZE} height={ICON_SIZE} fill={theme.colors.textSecondary} />
          {replies > 0 && (
            <Text className="text-[13px] text-muted-foreground">
              {formatCompactNumber(replies)}
            </Text>
          )}
        </PressableScale>
      ) : null}

      <PressableScale
        style={styles.countedIconButton}
        onPress={() => {
          haptic('light');
          onBoost();
        }}
        hitSlop={HIT_SLOP_MD}
        accessibilityLabel="Repost options"
        accessibilityRole="button"
      >
        {isBoosted ? (
          <RiRepeat2Line width={ICON_SIZE} height={ICON_SIZE} fill={theme.colors.success} />
        ) : (
          <RiRepeat2Line width={ICON_SIZE} height={ICON_SIZE} fill={theme.colors.textSecondary} />
        )}
        {boosts > 0 && (
          <Text
            className={isBoosted ? 'text-[13px]' : 'text-[13px] text-muted-foreground'}
            style={isBoosted ? { color: theme.colors.success } : undefined}
          >
            {formatCompactNumber(boosts)}
          </Text>
        )}
      </PressableScale>

      {onSendInAllo ? (
        <PressableScale
          style={styles.iconButton}
          onPress={() => {
            haptic('light');
            onSendInAllo();
          }}
          hitSlop={HIT_SLOP_MD}
          accessibilityRole="button"
          accessibilityLabel="Send in Allo"
        >
          <RiSendPlaneLine size="md" fill={theme.colors.textSecondary} />
        </PressableScale>
      ) : null}

      <PressableScale
        style={styles.iconButton}
        onPress={() => {
          haptic('light');
          onShare();
        }}
        hitSlop={HIT_SLOP_MD}
        accessibilityLabel="Share"
      >
        <RiUpload2Line width={ICON_SIZE} height={ICON_SIZE} fill={theme.colors.textSecondary} />
      </PressableScale>

      {/* Spacer: pushes Save + Translate + Insights to the right edge */}
      <View className="flex-1" />

      <PressableScale
        className="flex-row items-center"
        style={[styles.iconButton, { gap: 6 }]}
        onPress={() => {
          haptic('light');
          onSave();
        }}
        hitSlop={HIT_SLOP_MD}
        accessibilityRole="button"
        accessibilityLabel={isSaved ? 'Remove from saved' : 'Save post'}
      >
        {isSaved ? (
          <RiBookmarkFill width={ICON_SIZE} height={ICON_SIZE} fill={theme.colors.primary} />
        ) : (
          <RiBookmarkLine width={ICON_SIZE} height={ICON_SIZE} fill={theme.colors.textSecondary} />
        )}
        {saves > 0 && (
          <Text
            className={isSaved ? 'text-[13px]' : 'text-[13px] text-muted-foreground'}
            style={isSaved ? { color: theme.colors.primary } : undefined}
          >
            {formatCompactNumber(saves)}
          </Text>
        )}
      </PressableScale>

      {onTranslate && (
        <PressableScale
          style={styles.iconButton}
          onPress={() => {
            haptic('light');
            onTranslate();
          }}
          {...otherLanguagesProps}
          hitSlop={HIT_SLOP_MD}
          accessibilityLabel={isTranslated ? 'Show original' : 'Translate'}
          disabled={isTranslating}
        >
          {isTranslating ? (
            <SpinnerIcon size={16} className="text-muted-foreground" />
          ) : (
            <RiTranslate2
              size="md"
              fill={isTranslated ? theme.colors.primary : theme.colors.textSecondary}
            />
          )}
        </PressableScale>
      )}

      {onInsightsPress && (
        <PressableScale
          style={styles.iconButton}
          onPress={() => {
            haptic('light');
            onInsightsPress();
          }}
          hitSlop={HIT_SLOP_MD}
          accessibilityLabel="Insights"
        >
          <RiBarChartBoxLine
            width={ICON_SIZE}
            height={ICON_SIZE}
            fill={theme.colors.textSecondary}
          />
        </PressableScale>
      )}
    </View>
  );

  return actionIconRow;
};

// Mounted once per feed row. Memoized so an unrelated re-render of a sibling row
// (or the parent feed) does not re-render every action bar — effective because
// PostItem now hands it a stable `engagement` object and memoized callbacks.
export default React.memo(PostActions);

const styles = StyleSheet.create({
  iconButton: {
    padding: 2,
  },
  // A plain style, not `className`: a class on the pressable costs every row an
  // interop wrapper (the row-cost harness counts it), for a layout this states.
  countedIconButton: {
    padding: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
});
