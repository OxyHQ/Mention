import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../styles/colors';
import { CommentIcon } from '@/assets/icons/comment-icon';
import { RepostIcon, RepostIconActive } from '@/assets/icons/repost-icon';
import { HeartIcon, HeartIconActive } from '@/assets/icons/heart-icon';
import { Bookmark, BookmarkActive } from '@/assets/icons/bookmark-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
import { AnalyticsIcon } from '@/assets/icons/analytics-icon';
import AnimatedNumber from '../common/AnimatedNumber';
import { useTheme } from '@/hooks/useTheme';

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
  showInsights?: boolean;
  hideLikeCounts?: boolean;
  hideShareCounts?: boolean;
  hideReplyCounts?: boolean;
  hideSaveCounts?: boolean;
}

const PostActions: React.FC<Props> = ({
  engagement,
  isLiked,
  isReposted,
  isSaved,
  onReply,
  onRepost,
  onLike,
  onSave,
  onShare,
  onLikesPress,
  onRepostsPress,
  onInsightsPress,
  postId,
  showInsights = false,
  hideLikeCounts = false,
  hideShareCounts = false,
  hideReplyCounts = false,
  hideSaveCounts = false,
}) => {
  const theme = useTheme();

  const handleLikesPress = () => {
    if (onLikesPress && engagement?.likes > 0) {
      onLikesPress();
    } else {
      onLike();
    }
  };

  const handleRepostsPress = () => {
    if (onRepostsPress && engagement?.reposts > 0) {
      onRepostsPress();
    } else {
      onRepost();
    }
  };

  const formatViewCount = (count: number): string => {
    if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
    if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
    return String(count);
  };

  return (
    <View style={styles.postEngagement}>
      {/* Views */}
      {engagement?.views != null && engagement.views > 0 && (
        <View style={styles.engagementButton}>
          <Ionicons name="eye-outline" size={16} color={theme.colors.textSecondary} />
          <Text style={[styles.engagementText, styles.viewCountText, { color: theme.colors.textSecondary }]}>
            {formatViewCount(engagement.views)}
          </Text>
        </View>
      )}

      {/* Heart (like) */}
      <View style={styles.engagementButton}>
        <TouchableOpacity
          onPress={onLike}
          accessibilityRole="button"
          accessibilityLabel={isLiked ? 'Unlike' : 'Like'}
          accessibilityHint="Double tap to toggle like"
        >
          {isLiked ? (
            <HeartIconActive size={18} color={theme.colors.error} />
          ) : (
            <HeartIcon size={18} color={theme.colors.textSecondary} />
          )}
        </TouchableOpacity>
        {!hideLikeCounts && engagement?.likes !== null && (
          <TouchableOpacity onPress={handleLikesPress} style={styles.countButton}>
            <AnimatedNumber
              value={engagement?.likes ?? 0}
              style={[styles.engagementText, { color: theme.colors.textSecondary }, isLiked && { color: theme.colors.error }]}
            />
          </TouchableOpacity>
        )}
      </View>

      {/* Reply (comment) */}
      <TouchableOpacity
        style={styles.engagementButton}
        onPress={onReply}
        accessibilityRole="button"
        accessibilityLabel="Reply"
        accessibilityHint="Double tap to reply to this post"
      >
        <CommentIcon size={18} color={theme.colors.textSecondary} />
        {!hideReplyCounts && engagement?.replies !== null && (
          <AnimatedNumber
            value={engagement?.replies ?? 0}
            style={[styles.engagementText, { color: theme.colors.textSecondary }]}
          />
        )}
      </TouchableOpacity>

      {/* Repost */}
      <View style={styles.engagementButton}>
        <TouchableOpacity
          onPress={onRepost}
          accessibilityRole="button"
          accessibilityLabel={isReposted ? 'Undo repost' : 'Repost'}
          accessibilityHint="Double tap to toggle repost"
        >
          {isReposted ? (
            <RepostIconActive size={18} color={theme.colors.success} />
          ) : (
            <RepostIcon size={18} color={theme.colors.textSecondary} />
          )}
        </TouchableOpacity>
        {!hideShareCounts && engagement?.reposts !== null && (
          <TouchableOpacity onPress={handleRepostsPress} style={styles.countButton}>
            <AnimatedNumber
              value={engagement?.reposts ?? 0}
              style={[styles.engagementText, { color: theme.colors.textSecondary }, isReposted && { color: theme.colors.success }]}
            />
          </TouchableOpacity>
        )}
      </View>

      {/* Share */}
      <TouchableOpacity
        style={styles.engagementButton}
        onPress={onShare}
        accessibilityRole="button"
        accessibilityLabel="Share"
        accessibilityHint="Double tap to share this post"
      >
        <ShareIcon size={18} color={theme.colors.textSecondary} />
      </TouchableOpacity>

      {/* Save */}
      {!hideSaveCounts && (
        <TouchableOpacity
          style={styles.engagementButton}
          onPress={onSave}
          accessibilityRole="button"
          accessibilityLabel={isSaved ? 'Unsave' : 'Save'}
          accessibilityHint="Double tap to toggle save"
        >
          {isSaved ? (
            <BookmarkActive size={18} color={theme.colors.primary} />
          ) : (
            <Bookmark size={18} color={theme.colors.textSecondary} />
          )}
        </TouchableOpacity>
      )}

      {/* Insights (only for post owners) */}
      {showInsights && onInsightsPress && (
        <TouchableOpacity style={styles.engagementButton} onPress={onInsightsPress}>
          <AnalyticsIcon size={18} color={theme.colors.textSecondary} />
        </TouchableOpacity>
      )}
    </View>
  );
};

export default PostActions;

const styles = StyleSheet.create({
  postEngagement: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    maxWidth: 300,
  },
  engagementButton: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  countButton: {
    marginLeft: 4,
  },
  engagementText: {
    fontSize: 13,
    marginLeft: 4,
  },
  viewCountText: {
    fontSize: 12,
  },
  activeEngagementText: {
  },
  activeLikeText: {
  },
});
