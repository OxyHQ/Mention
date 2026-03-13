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

const ICON_SIZE = 20;
const MINI_AVATAR = 16;
const AVATAR_OVERLAP = -4;

interface Engagement {
  replies: number | null;
  reposts: number | null;
  likes: number | null;
  saves?: number | null;
  views?: number | null;
  recentReplierAvatars?: string[];
}

interface Props {
  engagement: Engagement;
  isLiked?: boolean;
  isReposted?: boolean;
  isSaved?: boolean;
  onReply: () => void;
  onRepost: () => void;
  onLike: () => void;
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
  isReposted,
  onReply,
  onRepost,
  onLike,
  onShare,
  onLikesPress,
  onRepostsPress,
  onInsightsPress,
}) => {
  const theme = useTheme();
  const haptic = useHaptics();
  const hasBeenToggled = useRef(false);

  const replies = engagement?.replies ?? 0;
  const likes = engagement?.likes ?? 0;
  const replierAvatars = engagement?.recentReplierAvatars ?? [];

  // Build summary parts like Threads: "X replies · Y likes"
  const summaryParts: string[] = [];
  if (replies > 0) summaryParts.push(`${formatCompactNumber(replies)} ${replies === 1 ? 'reply' : 'replies'}`);

  return (
    <View>
      {/* Icon row — icon-only, left-aligned */}
      <View style={styles.iconRow}>
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
          <View style={styles.likeRow}>
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

        <PressableScale
          style={styles.iconButton}
          onPress={() => {
            haptic('Light');
            onReply();
          }}
          hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
          accessibilityLabel="Reply"
        >
          <CommentIcon size={ICON_SIZE} color={theme.colors.textSecondary} />
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
            <RepostIcon size={ICON_SIZE} color={theme.colors.textSecondary} />
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
          <ShareIcon size={ICON_SIZE} color={theme.colors.textSecondary} />
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
            <AnalyticsIcon size={ICON_SIZE} color={theme.colors.textSecondary} />
          </PressableScale>
        )}
      </View>

      {/* Engagement summary — avatar bubbles + "X replies · Y likes" */}
      {summaryParts.length > 0 && (
        <PressableScale
          style={styles.summaryRow}
          onPress={likes > 0 ? (onLikesPress ?? undefined) : undefined}
          disabled={!onLikesPress && !onRepostsPress}
        >
          {replierAvatars.length > 0 && (
            <View style={styles.avatarStack}>
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
          <Text style={[styles.summaryText, { color: theme.colors.textSecondary }]}>
            {summaryParts.join(' · ')}
          </Text>
        </PressableScale>
      )}
    </View>
  );
};

export default PostActions;

const styles = StyleSheet.create({
  iconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
  },
  iconButton: {
    padding: 2,
  },
  likeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    gap: 6,
  },
  avatarStack: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  miniAvatarWrap: {
    borderWidth: 1.5,
    borderRadius: MINI_AVATAR / 2 + 1.5,
    overflow: 'hidden',
  },
  summaryText: {
    fontSize: 13,
  },
});
