import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../styles/colors';
import PostAvatar from './PostAvatar';

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
  paddingHorizontal?: number;
  children?: React.ReactNode;
  avatarUri?: string;
  avatarSize?: number;
  avatarGap?: number;
}

const PostHeader: React.FC<PostHeaderProps> = ({
  user,
  date,
  showRepost,
  showReply,
  paddingHorizontal = 16,
  children,
  avatarUri,
  avatarSize = 40,
  avatarGap = 12,
}) => {
  const indentLeft = avatarUri ? avatarSize + avatarGap : 0;
  return (
    <View style={[styles.container, { paddingHorizontal }]}>
      <View style={styles.headerRow}>
        {avatarUri ? <PostAvatar uri={avatarUri} size={avatarSize} /> : null}
        <View style={styles.headerMeta}>
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
        </View>
      </View>
      {children ? <View style={[styles.headerChildren, { paddingLeft: indentLeft }]}>{children}</View> : null}
    </View>
  );
};

export default PostHeader;

const styles = StyleSheet.create({
  container: {
    paddingTop: 0,
    paddingBottom: 0,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  headerMeta: {
    flex: 1,
    paddingTop: 2,
  },
  postHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  headerChildren: {
    marginTop: 8,
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
