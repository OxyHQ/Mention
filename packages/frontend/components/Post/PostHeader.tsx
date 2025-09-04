import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../styles/colors';

interface User {
  name: string;
  handle: string;
  verified?: boolean;
}

interface PostHeaderProps {
  user: User;
  date?: string;
  showRepost?: boolean;
  showReply?: boolean;
}

const PostHeader: React.FC<PostHeaderProps> = ({ user, date, showRepost, showReply }) => {
  return (
    <View style={styles.postHeader}>
      <Text style={styles.postUserName}>
        {user.name}
        {user.verified && (
          <Ionicons name="checkmark-circle" size={16} color={colors.primaryColor} style={styles.verifiedIcon} />
        )}
      </Text>
      <Text style={styles.postHandle}>@{user.handle}</Text>
      {!!date && <Text style={styles.postDate}>· {date}</Text>}
      {showRepost && (
        <View style={styles.metaIndicator}>
          <Ionicons name="repeat" size={12} color={colors.COLOR_BLACK_LIGHT_4} />
          <Text style={styles.metaIndicatorText}>Reposted</Text>
        </View>
      )}
      {showReply && (
        <View style={styles.metaIndicator}>
          <Ionicons name="chatbubble" size={12} color={colors.COLOR_BLACK_LIGHT_4} />
          <Text style={styles.metaIndicatorText}>Replied</Text>
        </View>
      )}
    </View>
  );
};

export default PostHeader;

const styles = StyleSheet.create({
  postHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  postUserName: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.COLOR_BLACK_LIGHT_1,
    marginRight: 4,
  },
  verifiedIcon: {
    marginRight: 4,
  },
  postHandle: {
    fontSize: 15,
    color: colors.COLOR_BLACK_LIGHT_4,
    marginRight: 4,
  },
  postDate: {
    fontSize: 15,
    color: colors.COLOR_BLACK_LIGHT_4,
  },
  metaIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 8,
  },
  metaIndicatorText: {
    fontSize: 12,
    color: colors.COLOR_BLACK_LIGHT_4,
    marginLeft: 2,
  },
});
