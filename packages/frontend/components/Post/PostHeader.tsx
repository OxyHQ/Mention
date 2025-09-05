import React from 'react';
import { StyleSheet, Text, View, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../styles/colors';
import PostAvatar from './PostAvatar';

// Spacing tokens for consistent layout
const HPAD = 16;         // horizontal padding
const ROW_GAP = 8;       // gap between inline header items
const SECTION_GAP = 12;  // vertical gap from header row to children

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
  onPressUser?: () => void;
  onPressAvatar?: () => void;
}

const PostHeader: React.FC<PostHeaderProps> = ({
  user,
  date,
  showRepost,
  showReply,
  paddingHorizontal = HPAD,
  children,
  avatarUri,
  avatarSize = 40,
  avatarGap = 12,
  onPressUser,
  onPressAvatar,
}) => {
  const formatRelativeTime = (input?: string): string => {
    if (!input) return 'now';
    const ts = Date.parse(input);
    if (Number.isNaN(ts)) return 'now';
    const diff = Math.max(0, Date.now() - ts);
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return 'now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hrs = Math.floor(min / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d`;
    const weeks = Math.floor(days / 7);
    if (weeks < 5) return `${weeks}w`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo`;
    const years = Math.floor(days / 365);
    return `${years}y`;
  };

  const timeLabel = formatRelativeTime(date);
  return (
    <View style={[styles.container, { paddingHorizontal }]}>
      <View style={styles.headerRow}>
        <TouchableOpacity activeOpacity={0.7} onPress={onPressAvatar}>
          <PostAvatar uri={avatarUri} size={avatarSize} />
        </TouchableOpacity>
        <View style={styles.headerMeta}>
          <View style={styles.postHeader}>
            <TouchableOpacity activeOpacity={0.7} onPress={onPressUser}>
              <Text style={styles.postUserName}>
                {user.name}
                {user.verified && (
                  <Ionicons name="checkmark-circle" size={16} color={colors.primaryColor} style={styles.verifiedIcon} />
                )}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity activeOpacity={0.7} onPress={onPressUser}>
              <Text style={styles.postHandle}>@{user.handle}</Text>
            </TouchableOpacity>
            {!!timeLabel && <Text style={styles.postDate}>· {timeLabel}</Text>}
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
          {children ? <View style={styles.headerChildren}>{children}</View> : null}
        </View>
      </View>
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
    gap: 8,
  },
  postHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ROW_GAP,
  },
  headerChildren: {
  },
  postUserName: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.COLOR_BLACK_LIGHT_1,
  },
  verifiedIcon: {
    // icon sits inline with text; spacing handled by gap/text layout
  },
  postHandle: {
    fontSize: 15,
    color: colors.COLOR_BLACK_LIGHT_4,
  },
  postDate: {
    fontSize: 15,
    color: colors.COLOR_BLACK_LIGHT_4,
  },
  metaIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ROW_GAP,
  },
  metaIndicatorText: {
    fontSize: 12,
    color: colors.COLOR_BLACK_LIGHT_4,
  },
});
