import React, { useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CommentIcon } from '@/assets/icons/comment-icon';
import { RepostIcon, RepostIconActive } from '@/assets/icons/repost-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
import { AnalyticsIcon } from '@/assets/icons/analytics-icon';
import Avatar from '@/components/Avatar';
import { useTheme } from '@/hooks/useTheme';
import { useHaptics } from '@/hooks/useHaptics';
import { formatCompactNumber } from '@/utils/formatNumber';
import { PressableScale } from '@/lib/animations/PressableScale';
import { AnimatedLikeIcon } from '@/lib/animations/AnimatedLikeIcon';
import { CountWheel } from '@/lib/animations/CountWheel';
import { useVoteStyle } from '@/hooks/useVoteStyle';
import VotePill from './VotePill';

const ICON_SIZE = 20;
const MINI_AVATAR = 16;
const AVATAR_OVERLAP = -4;

interface Engagement {
  replies: number | null;
  reposts: number | null;
  likes: number | null;
  downvotes?: number | null;
  saves?: number | null;
  views?: number | null;
  recentReplierAvatars?: string[];
}

interface Props {
  engagement: Engagement;
  isLiked?: boolean;
  isDownvoted?: boolean;
  isReposted?: boolean;
  isSaved?: boolean;
  onReply: () => void;
  onRepost: () => void;
  onLike: () => void;
  onDownvote?: () => void;
  onSave: () => void;
  onShare: () => void;
  onLikesPress?: () => void;
  onRepostsPress?: () => void;
  onInsightsPress?: () => void;
  postId?: string;
}

const PostActions: React.FC<Props> = ({
  engagement,
  isLiked,
  isDownvoted,
  isReposted,
  onReply,
  onRepost,
  onLike,
  onDownvote,
  onShare,
  onLikesPress,
  onRepostsPress,
  onInsightsPress,
}) => {
  const theme = useTheme();
  const haptic = useHaptics();
  const hasBeenToggled = useRef(false);
  const voteStyle = useVoteStyle();

  const replies = engagement?.replies ?? 0;
  const likes = engagement?.likes ?? 0;
  const downvotes = engagement?.downvotes ?? 0;
  const replierAvatars = engagement?.recentReplierAvatars ?? [];

  // Build summary parts like Threads: "X replies · Y likes"
  const summaryParts: string[] = [];
  if (replies > 0) summaryParts.push(`${formatCompactNumber(replies)} ${replies === 1 ? 'reply' : 'replies'}`);

  return (
    <View>
      {/* Icon row -- icon-only, left-aligned */}
      <View className="flex-row items-center" style={{ gap: 18 }}>
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
              haptic('Light');
              onLike();
            }}
            hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
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

        <PressableScale
          style={styles.iconButton}
          onPress={() => {
            haptic('Light');
            onReply();
          }}
          hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
          accessibilityLabel="Reply"
        >
          <CommentIcon size={ICON_SIZE} className="text-muted-foreground" />
        </PressableScale>

        <PressableScale
          style={styles.iconButton}
          onPress={() => {
            haptic('Medium');
            onRepost();
          }}
          hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
          accessibilityLabel={isReposted ? 'Undo repost' : 'Repost'}
        >
          {isReposted ? (
            <RepostIconActive size={ICON_SIZE} color={theme.colors.success} />
          ) : (
            <RepostIcon size={ICON_SIZE} className="text-muted-foreground" />
          )}
        </PressableScale>

        <PressableScale
          style={styles.iconButton}
          onPress={() => {
            haptic('Light');
            onShare();
          }}
          hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
          accessibilityLabel="Share"
        >
          <ShareIcon size={ICON_SIZE} className="text-muted-foreground" />
        </PressableScale>

        {onInsightsPress && (
          <PressableScale
            style={styles.iconButton}
            onPress={() => {
              haptic('Light');
              onInsightsPress();
            }}
            hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel="Insights"
          >
            <AnalyticsIcon size={ICON_SIZE} className="text-muted-foreground" />
          </PressableScale>
        )}
      </View>

      {/* Engagement summary -- avatar bubbles + "X replies . Y likes" */}
      {summaryParts.length > 0 && (
        <PressableScale
          className="flex-row items-center mt-2"
          style={{ gap: 6 }}
          onPress={likes > 0 ? (onLikesPress ?? undefined) : undefined}
          disabled={!onLikesPress && !onRepostsPress}
        >
          {replierAvatars.length > 0 && (
            <View className="flex-row items-center">
              {replierAvatars.slice(0, 3).map((avatarId, i) => (
                <View
                  key={i}
                  style={[
                    styles.miniAvatarWrap,
                    i > 0 && { marginLeft: AVATAR_OVERLAP },
                    { zIndex: 3 - i, borderColor: theme.colors.background },
                  ]}
                >
                  <Avatar source={avatarId} size={MINI_AVATAR} />
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

export default PostActions;

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
