import React, { useMemo } from 'react';
import { StyleSheet, Text, View, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../styles/colors';
import PostAvatar from './PostAvatar';
import UserName from '../UserName';

// Spacing tokens for consistent layout
const HPAD = 8;         // horizontal padding
const ROW_GAP = 8;       // gap between inline header items

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
  repostedBy?: { name: string; handle: string; verified?: boolean; date?: string };
  paddingHorizontal?: number;
  children?: React.ReactNode;
  avatarUri?: string;
  avatarSize?: number;
  avatarGap?: number;
  onPressUser?: () => void;
  onPressAvatar?: () => void;
  onPressMenu?: () => void; // optional three-dots menu action
}

const PostHeader: React.FC<PostHeaderProps> = ({
  user,
  date,
  showRepost,
  showReply,
  repostedBy,
  paddingHorizontal = HPAD,
  children,
  avatarUri,
  avatarSize = 36,

  onPressUser,
  onPressAvatar,
  onPressMenu,
}) => {
  // Move formatRelativeTime outside component to avoid recreation
  const formatRelativeTime = React.useCallback((input?: string): string => {
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
  }, []);

  // Memoize time labels to prevent recalculation on every render
  const timeLabel = useMemo(() => formatRelativeTime(date), [date, formatRelativeTime]);
  const repostLabel = useMemo(() => repostedBy ? `${repostedBy.name} reposted` : undefined, [repostedBy]);
  const repostTime = useMemo(() => repostedBy?.date ? formatRelativeTime(repostedBy.date) : undefined, [repostedBy?.date, formatRelativeTime]);
  return (
    <View style={[styles.container, { paddingHorizontal }]}> 
      <View style={styles.headerRow}>
        <TouchableOpacity activeOpacity={0.7} onPress={onPressAvatar}>
          <PostAvatar uri={avatarUri} size={avatarSize} />
        </TouchableOpacity>
        <View style={styles.headerMeta}>
          <View style={styles.postHeader}>
            <UserName
              name={user.name}
              verified={user.verified}
              onPress={onPressUser}
            />
            {user.handle ? <Text style={styles.postHandle}>@{user.handle}</Text> : null}
            {!!timeLabel && <Text style={styles.postDate}>· {timeLabel}</Text>}
            {(repostLabel || showRepost) && (
              <View style={styles.metaIndicator}>
                <Ionicons name="repeat" size={12} color={colors.COLOR_BLACK_LIGHT_4} />
                <Text style={styles.metaIndicatorText}>
                  {repostLabel || 'Reposted'}{repostTime ? ` · ${repostTime}` : ''}
                </Text>
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
        {onPressMenu ? (
          <TouchableOpacity
            accessibilityLabel="Post options"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.menuButton}
            onPress={onPressMenu}
          >
            <Ionicons name="ellipsis-horizontal" size={18} color={colors.COLOR_BLACK_LIGHT_3} />
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingTop: 0,
    paddingBottom: 0,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  headerMeta: {
    flex: 1,
    gap: 4,
  },
  menuButton: {
    paddingHorizontal: 8,
    paddingTop: 4,
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

export default React.memo(PostHeader);
