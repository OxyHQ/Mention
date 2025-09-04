import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../styles/colors';

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
  return (
    <View style={styles.postEngagement}>
      <TouchableOpacity style={styles.engagementButton} onPress={onReply}>
        <Ionicons name="chatbubble-outline" size={18} color={colors.COLOR_BLACK_LIGHT_4} />
        <Text style={styles.engagementText}>{engagement?.replies ?? 0}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.engagementButton} onPress={onRepost}>
        <Ionicons
          name={isReposted ? 'repeat' : 'repeat-outline'}
          size={18}
          color={isReposted ? colors.online : colors.COLOR_BLACK_LIGHT_4}
        />
        <Text style={[styles.engagementText, isReposted && styles.activeEngagementText]}>
          {engagement?.reposts ?? 0}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.engagementButton} onPress={onLike}>
        <Ionicons
          name={isLiked ? 'heart' : 'heart-outline'}
          size={18}
          color={isLiked ? colors.busy : colors.COLOR_BLACK_LIGHT_4}
        />
        <Text style={[styles.engagementText, isLiked && styles.activeLikeText]}>
          {engagement?.likes ?? 0}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.engagementButton} onPress={onSave}>
        <Ionicons
          name={isSaved ? 'bookmark' : 'bookmark-outline'}
          size={18}
          color={isSaved ? colors.primaryColor : colors.COLOR_BLACK_LIGHT_4}
        />
      </TouchableOpacity>
      <TouchableOpacity style={styles.engagementButton} onPress={onShare}>
        <Ionicons name="share-outline" size={18} color={colors.COLOR_BLACK_LIGHT_4} />
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
    color: colors.COLOR_BLACK_LIGHT_4,
    marginLeft: 4,
  },
  activeEngagementText: {
    color: colors.online,
  },
  activeLikeText: {
    color: colors.busy,
  },
});
