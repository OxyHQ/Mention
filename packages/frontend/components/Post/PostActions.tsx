import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { CommentIcon } from '@/assets/icons/comment-icon';
import { RepostIcon, RepostIconActive } from '@/assets/icons/repost-icon';
import { HeartIcon, HeartIconActive } from '@/assets/icons/heart-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
import { AnalyticsIcon } from '@/assets/icons/analytics-icon';
import { useTheme } from '@/hooks/useTheme';
import { formatCompactNumber } from '@/utils/formatNumber';

const ICON_SIZE = 20;

interface Engagement {
  replies: number | null;
  reposts: number | null;
  likes: number | null;
  saves?: number | null;
  views?: number | null;
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

  const replies = engagement?.replies ?? 0;
  const likes = engagement?.likes ?? 0;
  const reposts = engagement?.reposts ?? 0;

  // Build summary parts like Threads: "X replies · Y likes"
  const summaryParts: string[] = [];
  if (replies > 0) summaryParts.push(`${formatCompactNumber(replies)} ${replies === 1 ? 'reply' : 'replies'}`);
  if (likes > 0) summaryParts.push(`${formatCompactNumber(likes)} ${likes === 1 ? 'like' : 'likes'}`);

  return (
    <View>
      {/* Icon row — Threads style: icon-only, left-aligned */}
      <View style={styles.iconRow}>
        <TouchableOpacity
          style={styles.iconButton}
          onPress={onLike}
          accessibilityRole="button"
          accessibilityLabel={isLiked ? 'Unlike' : 'Like'}
        >
          {isLiked ? (
            <HeartIconActive size={ICON_SIZE} color={theme.colors.error} />
          ) : (
            <HeartIcon size={ICON_SIZE} color={theme.colors.textSecondary} />
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.iconButton}
          onPress={onReply}
          accessibilityRole="button"
          accessibilityLabel="Reply"
        >
          <CommentIcon size={ICON_SIZE} color={theme.colors.textSecondary} />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.iconButton}
          onPress={onRepost}
          accessibilityRole="button"
          accessibilityLabel={isReposted ? 'Undo repost' : 'Repost'}
        >
          {isReposted ? (
            <RepostIconActive size={ICON_SIZE} color={theme.colors.success} />
          ) : (
            <RepostIcon size={ICON_SIZE} color={theme.colors.textSecondary} />
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.iconButton}
          onPress={onShare}
          accessibilityRole="button"
          accessibilityLabel="Share"
        >
          <ShareIcon size={ICON_SIZE} color={theme.colors.textSecondary} />
        </TouchableOpacity>

        {onInsightsPress && (
          <TouchableOpacity
            style={styles.iconButton}
            onPress={onInsightsPress}
            accessibilityRole="button"
            accessibilityLabel="Insights"
          >
            <AnalyticsIcon size={ICON_SIZE} color={theme.colors.textSecondary} />
          </TouchableOpacity>
        )}
      </View>

      {/* Engagement summary — Threads style: "X replies · Y likes" */}
      {summaryParts.length > 0 && (
        <TouchableOpacity
          style={styles.summaryRow}
          onPress={likes > 0 ? (onLikesPress ?? undefined) : undefined}
          activeOpacity={0.6}
          disabled={!onLikesPress && !onRepostsPress}
        >
          <Text style={[styles.summaryText, { color: theme.colors.textSecondary }]}>
            {summaryParts.join(' · ')}
          </Text>
        </TouchableOpacity>
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
  summaryRow: {
    marginTop: 6,
  },
  summaryText: {
    fontSize: 13,
  },
});
