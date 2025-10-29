import React from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { colors } from '../../styles/colors';
import { CommentIcon } from '@/assets/icons/comment-icon';
import { RepostIcon, RepostIconActive } from '@/assets/icons/repost-icon';
import { HeartIcon, HeartIconActive } from '@/assets/icons/heart-icon';
import { Bookmark, BookmarkActive } from '@/assets/icons/bookmark-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
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
}) => {
  const theme = useTheme();

  return (
    <View style={styles.postEngagement}>
      {/* Heart (like) */}
      <TouchableOpacity style={styles.engagementButton} onPress={onLike}>
        {isLiked ? (
          <HeartIconActive size={18} color={theme.colors.error} />
        ) : (
          <HeartIcon size={18} color={theme.colors.textSecondary} />
        )}
        <AnimatedNumber
          value={engagement?.likes ?? 0}
          style={[styles.engagementText, { color: theme.colors.textSecondary }, isLiked && { color: theme.colors.error }]}
        />
      </TouchableOpacity>

      {/* Reply (comment) */}
      <TouchableOpacity style={styles.engagementButton} onPress={onReply}>
        <CommentIcon size={18} color={theme.colors.textSecondary} />
        <AnimatedNumber
          value={engagement?.replies ?? 0}
          style={[styles.engagementText, { color: theme.colors.textSecondary }]}
        />
      </TouchableOpacity>

      {/* Repost */}
      <TouchableOpacity style={styles.engagementButton} onPress={onRepost}>
        {isReposted ? (
          <RepostIconActive size={18} color={theme.colors.success} />
        ) : (
          <RepostIcon size={18} color={theme.colors.textSecondary} />
        )}
        <AnimatedNumber
          value={engagement?.reposts ?? 0}
          style={[styles.engagementText, { color: theme.colors.textSecondary }, isReposted && { color: theme.colors.success }]}
        />
      </TouchableOpacity>

      {/* Share */}
      <TouchableOpacity style={styles.engagementButton} onPress={onShare}>
        <ShareIcon size={18} color={theme.colors.textSecondary} />
      </TouchableOpacity>

      {/* Save */}
      <TouchableOpacity style={styles.engagementButton} onPress={onSave}>
        {isSaved ? (
          <BookmarkActive size={18} color={theme.colors.primary} />
        ) : (
          <Bookmark size={18} color={theme.colors.textSecondary} />
        )}
      </TouchableOpacity>
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
  engagementText: {
    fontSize: 13,
    marginLeft: 4,
  },
  activeEngagementText: {
  },
  activeLikeText: {
  },
});
