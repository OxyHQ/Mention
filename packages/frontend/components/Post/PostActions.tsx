import React from 'react';
import type { AccessibilityActionEvent } from 'react-native';
import { EngagementAction, EngagementBar, EngagementGroup } from '@oxy.so/bloom/engagement-bar';
import { RiArrowDownSLine } from '@oxy.so/bloom/icons/RiArrowDownSLine';
import { RiArrowUpSLine } from '@oxy.so/bloom/icons/RiArrowUpSLine';
import { RiBarChartBoxLine } from '@oxy.so/bloom/icons/RiBarChartBoxLine';
import { RiBookmarkFill } from '@oxy.so/bloom/icons/RiBookmarkFill';
import { RiBookmarkLine } from '@oxy.so/bloom/icons/RiBookmarkLine';
import { RiChat3Line } from '@oxy.so/bloom/icons/RiChat3Line';
import { RiHeart3Fill } from '@oxy.so/bloom/icons/RiHeart3Fill';
import { RiHeart3Line } from '@oxy.so/bloom/icons/RiHeart3Line';
import { RiRepeat2Line } from '@oxy.so/bloom/icons/RiRepeat2Line';
import { RiSendPlaneLine } from '@oxy.so/bloom/icons/RiSendPlaneLine';
import { RiTranslate2 } from '@oxy.so/bloom/icons/RiTranslate2';
import { RiUpload2Line } from '@oxy.so/bloom/icons/RiUpload2Line';

import { formatCompactNumber } from '@/utils/formatNumber';
import { useVoteStyle } from '@/hooks/useVoteStyle';

/** The translate icon's long press, offered to screen readers as an action. */
const TRANSLATE_TO = [{ name: 'translateTo', label: 'Read in another language' }] as const;

// The two vote arrows are adjacent halves of ONE pill, so neither hit region
// may grow toward the other or it swallows the other's taps.
const UPVOTE_HIT_SLOP = { top: 5, bottom: 5, left: 5, right: 0 };
const DOWNVOTE_HIT_SLOP = { top: 5, bottom: 5, left: 0, right: 5 };

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
  /** Returning false rejects the like: no haptic and no animation follow. */
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
  const voteStyle = useVoteStyle();

  const likes = engagement?.likes ?? 0;

  // ONE action bar, rendered identically wherever a post appears — a feed row
  // and the focused post on `/p/:id` included. A focused post adds
  // <PostDetailStats> BELOW this bar; it does not get a bar of its own.
  return (
    <EngagementBar
      formatCount={formatCompactNumber}
      trailing={
        <>
          <EngagementAction
            icon={RiBookmarkLine}
            activeIcon={RiBookmarkFill}
            accessibilityLabel="Save post"
            count={engagement?.saves}
            active={!!isSaved}
            onPress={onSave}
          />
          {onTranslate ? (
            <EngagementAction
              icon={RiTranslate2}
              accessibilityLabel="Translate"
              active={!!isTranslated}
              busy={isTranslating}
              onPress={onTranslate}
              // The icon's SECOND job — reading the post in some other language —
              // hangs off a long press, which no screen reader performs, so the
              // accessibility action carries the same call. Both arrive together
              // or not at all: an advertised action that does nothing is worse
              // than an absent one.
              {...(onTranslateLongPress
                ? {
                    onLongPress: onTranslateLongPress,
                    accessibilityActions: TRANSLATE_TO,
                    onAccessibilityAction: (event: AccessibilityActionEvent) => {
                      if (event.nativeEvent.actionName === 'translateTo') onTranslateLongPress();
                    },
                  }
                : null)}
            />
          ) : null}
          {onInsightsPress ? (
            <EngagementAction
              icon={RiBarChartBoxLine}
              accessibilityLabel="Insights"
              onPress={onInsightsPress}
            />
          ) : null}
        </>
      }
    >
      {voteStyle === 'pill' && onDownvote ? (
        <EngagementGroup>
          <EngagementAction
            icon={RiArrowUpSLine}
            accessibilityLabel="Upvote"
            count={likes - (engagement?.downvotes ?? 0)}
            active={!!isLiked}
            rollCount
            hitSlop={UPVOTE_HIT_SLOP}
            onPress={onLike}
          />
          <EngagementAction
            icon={RiArrowDownSLine}
            accessibilityLabel="Downvote"
            active={!!isDownvoted}
            tone="error"
            hitSlop={DOWNVOTE_HIT_SLOP}
            onPress={onDownvote}
          />
        </EngagementGroup>
      ) : (
        <EngagementAction
          icon={RiHeart3Line}
          activeIcon={RiHeart3Fill}
          accessibilityLabel="Like"
          count={likes}
          active={!!isLiked}
          tone="error"
          popOnActivate
          rollCount
          onPress={onLike}
        />
      )}
      {onReply ? (
        <EngagementAction
          icon={RiChat3Line}
          accessibilityLabel="Reply"
          count={engagement?.replies}
          onPress={onReply}
        />
      ) : null}
      <EngagementAction
        icon={RiRepeat2Line}
        accessibilityLabel="Repost options"
        count={engagement?.boosts}
        active={!!isBoosted}
        tone="success"
        onPress={onBoost}
      />
      {onSendInAllo ? (
        <EngagementAction
          icon={RiSendPlaneLine}
          accessibilityLabel="Send in Allo"
          onPress={onSendInAllo}
        />
      ) : null}
      <EngagementAction icon={RiUpload2Line} accessibilityLabel="Share" onPress={onShare} />
    </EngagementBar>
  );
};

// Mounted once per feed row. Memoized so an unrelated re-render of a sibling row
// (or the parent feed) does not re-render every action bar — effective because
// PostItem now hands it a stable `engagement` object and memoized callbacks.
export default React.memo(PostActions);
