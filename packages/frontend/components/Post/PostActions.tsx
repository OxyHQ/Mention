import React, { useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import Ionicons from '@expo/vector-icons/Ionicons';
import { CommentIcon } from '@/assets/icons/comment-icon';
import { TranslateIcon } from '@/assets/icons/translate-icon';
import { BoostIcon, BoostIconActive } from '@/assets/icons/boost-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
import { Bookmark, BookmarkActive } from '@/assets/icons/bookmark-icon';
import { AnalyticsIcon } from '@/assets/icons/analytics-icon';
import { Avatar } from '@oxyhq/bloom/avatar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';

import { useTheme } from '@oxyhq/bloom/theme';
import { useHaptics } from '@oxyhq/bloom/hooks';
import { formatCompactNumber } from '@/utils/formatNumber';
import { PressableScale } from '@oxyhq/bloom/pressable-scale';
import { AnimatedLikeIcon } from '@/lib/animations/AnimatedLikeIcon';
import { CountWheel } from '@/lib/animations/CountWheel';
import { useVoteStyle } from '@/hooks/useVoteStyle';
import { HIT_SLOP_MD } from '@/styles/hitSlop';
import VotePill from './VotePill';

const ICON_SIZE = 20;
const MINI_AVATAR = 16;
const AVATAR_OVERLAP = -4;

/** Only what the bar itself renders. Counts it does not show (boosts, quotes, views) live on <PostDetailStats>. */
interface Engagement {
  replies: number | null;
  likes: number | null;
  downvotes?: number | null;
  saves?: number | null;
  recentReplierAvatars?: string[];
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
  onLike: () => void;
  onDownvote?: () => void;
  onSave: () => void;
  onShare: () => void;
  onLikesPress?: () => void;
  onBoostsPress?: () => void;
  onInsightsPress?: () => void;
  onTranslate?: () => void;
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
  onLikesPress,
  onBoostsPress,
  onInsightsPress,
  onTranslate,
  isTranslated,
  isTranslating,
}) => {
  const theme = useTheme();
  const haptic = useHaptics();
  const hasBeenToggled = useRef(false);
  const voteStyle = useVoteStyle();

  const replies = engagement?.replies ?? 0;
  const likes = engagement?.likes ?? 0;
  const saves = engagement?.saves ?? 0;
  const downvotes = engagement?.downvotes ?? 0;
  const replierAvatars = engagement?.recentReplierAvatars ?? [];

  // ONE action bar, rendered identically wherever a post appears — a feed row
  // and the focused post on `/p/:id` included. A focused post adds
  // <PostDetailStats> BELOW this bar; it does not get a bar of its own.
  const actionIconRow = (
    <View className="flex-row items-center" style={{ gap: 12 }}>
      {voteStyle === 'pill' && onDownvote ? (
        <VotePill
          likeCount={likes}
          downvoteCount={downvotes}
          isLiked={!!isLiked}
          isDownvoted={!!isDownvoted}
          onUpvote={() => {
            hasBeenToggled.current = true;
            onLike();
          }}
          onDownvote={onDownvote}
        />
      ) : (
        <PressableScale
          style={styles.iconButton}
          onPress={() => {
            hasBeenToggled.current = true;
            haptic('light');
            onLike();
          }}
          hitSlop={HIT_SLOP_MD}
          accessibilityLabel={isLiked ? 'Unlike' : 'Like'}
        >
          <View className="flex-row items-center gap-1">
            <AnimatedLikeIcon
              isLiked={!!isLiked}
              hasBeenToggled={hasBeenToggled.current}
            />
            <CountWheel
              likeCount={likes}
              isLiked={!!isLiked}
              hasBeenToggled={hasBeenToggled.current}
            />
          </View>
        </PressableScale>
      )}

      {onReply ? (
        <PressableScale
          style={styles.iconButton}
          onPress={() => {
            haptic('light');
            onReply();
          }}
          hitSlop={HIT_SLOP_MD}
          accessibilityLabel="Reply"
        >
          <CommentIcon size={ICON_SIZE} className="text-muted-foreground" />
        </PressableScale>
      ) : null}

      <PressableScale
        style={styles.iconButton}
        onPress={() => {
          haptic('medium');
          onBoost();
        }}
        hitSlop={HIT_SLOP_MD}
        accessibilityLabel={isBoosted ? 'Undo boost' : 'Boost'}
      >
        {isBoosted ? (
          <BoostIconActive size={ICON_SIZE} color={theme.colors.success} />
        ) : (
          <BoostIcon size={ICON_SIZE} className="text-muted-foreground" />
        )}
      </PressableScale>

      <PressableScale
        style={styles.iconButton}
        onPress={() => {
          haptic('light');
          onShare();
        }}
        hitSlop={HIT_SLOP_MD}
        accessibilityLabel="Share"
      >
        <ShareIcon size={ICON_SIZE} className="text-muted-foreground" />
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
          <BookmarkActive size={ICON_SIZE} color={theme.colors.primary} />
        ) : (
          <Bookmark size={ICON_SIZE} className="text-muted-foreground" />
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
          hitSlop={HIT_SLOP_MD}
          accessibilityLabel={isTranslated ? 'Show original' : 'Translate'}
          disabled={isTranslating}
        >
          {isTranslating ? (
            <SpinnerIcon size={16} className="text-muted-foreground" />
          ) : (
            <TranslateIcon
              size={ICON_SIZE}
              color={isTranslated ? theme.colors.primary : theme.colors.textSecondary}
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
          <AnalyticsIcon size={ICON_SIZE} className="text-muted-foreground" />
        </PressableScale>
      )}
    </View>
  );

  // Build summary parts like Threads: "X replies · Y likes"
  const summaryParts: string[] = [];
  if (replies > 0) summaryParts.push(`${formatCompactNumber(replies)} ${replies === 1 ? 'reply' : 'replies'}`);

  return (
    <View>
      {actionIconRow}

      {/* Engagement summary -- avatar bubbles + "X replies . Y likes" */}
      {summaryParts.length > 0 && (
        <PressableScale
          className="flex-row items-center mt-2"
          style={{ gap: 6 }}
          onPress={likes > 0 ? (onLikesPress ?? undefined) : undefined}
          disabled={!onLikesPress && !onBoostsPress}
        >
          {replierAvatars.length > 0 && (
            <View className="flex-row items-center">
              {replierAvatars.slice(0, 3).map((avatarId, i) => (
                <View
                  key={i}
                  className="border-background"
                  style={[
                    styles.miniAvatarWrap,
                    i > 0 && { marginLeft: AVATAR_OVERLAP },
                    { zIndex: 3 - i },
                  ]}
                >
                  <Avatar source={avatarId} size={MINI_AVATAR} variant={MEDIA_VARIANT_AVATAR} />
                </View>
              ))}
            </View>
          )}
          <Text className="text-muted-foreground text-[13px]">
            {summaryParts.join(' \u00B7 ')}
          </Text>
        </PressableScale>
      )}
    </View>
  );
};

// Mounted once per feed row. Memoized so an unrelated re-render of a sibling row
// (or the parent feed) does not re-render every action bar — effective because
// PostItem now hands it a stable `engagement` object and memoized callbacks.
export default React.memo(PostActions);

const styles = StyleSheet.create({
  iconButton: {
    padding: 2,
  },
  miniAvatarWrap: {
    borderWidth: 1.5,
    borderRadius: MINI_AVATAR / 2 + 1.5,
    overflow: 'hidden',
  },
});
