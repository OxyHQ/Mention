import React from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
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
  replies: number;
  reposts: number;
  likes: number;
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

  return (
    <View style={styles.postEngagement}>
      {/* Heart (like) */}
      <View style={styles.engagementButton}>
        <TouchableOpacity onPress={onLike}>
          {isLiked ? (
            <HeartIconActive size={18} color={theme.colors.error} />
          ) : (
            <HeartIcon size={18} color={theme.colors.textSecondary} />
          )}
        </TouchableOpacity>
        {!hideLikeCounts && (
          <TouchableOpacity onPress={handleLikesPress} style={styles.countButton}>
            <AnimatedNumber
              value={engagement?.likes ?? 0}
              style={[styles.engagementText, { color: theme.colors.textSecondary }, isLiked && { color: theme.colors.error }]}
            />
          </TouchableOpacity>
        )}
      </View>

      {/* Reply (comment) */}
      <TouchableOpacity style={styles.engagementButton} onPress={onReply}>
        <CommentIcon size={18} color={theme.colors.textSecondary} />
        {!hideReplyCounts && (
          <AnimatedNumber
            value={engagement?.replies ?? 0}
            style={[styles.engagementText, { color: theme.colors.textSecondary }]}
          />
        )}
      </TouchableOpacity>

      {/* Repost */}
      <View style={styles.engagementButton}>
        <TouchableOpacity onPress={onRepost}>
          {isReposted ? (
            <RepostIconActive size={18} color={theme.colors.success} />
          ) : (
            <RepostIcon size={18} color={theme.colors.textSecondary} />
          )}
        </TouchableOpacity>
        {!hideShareCounts && (
          <TouchableOpacity onPress={handleRepostsPress} style={styles.countButton}>
            <AnimatedNumber
              value={engagement?.reposts ?? 0}
              style={[styles.engagementText, { color: theme.colors.textSecondary }, isReposted && { color: theme.colors.success }]}
            />
          </TouchableOpacity>
        )}
      </View>

      {/* Share */}
      <TouchableOpacity style={styles.engagementButton} onPress={onShare}>
        <ShareIcon size={18} color={theme.colors.textSecondary} />
      </TouchableOpacity>

      {/* Save */}
      {!hideSaveCounts && (
        <TouchableOpacity style={styles.engagementButton} onPress={onSave}>
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
  activeEngagementText: {
  },
  activeLikeText: {
  },
});
