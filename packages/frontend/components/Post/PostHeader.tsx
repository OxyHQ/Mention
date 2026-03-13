import React, { useMemo } from 'react';
import { StyleSheet, Text, View, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import PostAvatar from './PostAvatar';
import UserName from '../UserName';
import { ProfileHoverCard } from '../ProfileHoverCard';
import { useTheme } from '@/hooks/useTheme';
import { FediverseIcon } from '@/assets/icons/fediverse-icon';

// Spacing tokens for consistent layout
const HPAD = 8;
const ROW_GAP = 8;

interface User {
  name: string;
  handle: string;
  verified?: boolean;
  isFederated?: boolean;
  instance?: string;
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
  onPressMenu?: () => void;
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
  const theme = useTheme();

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

  const timeLabel = useMemo(() => formatRelativeTime(date), [date, formatRelativeTime]);
  const repostLabel = useMemo(() => repostedBy ? `${repostedBy.name} reposted` : undefined, [repostedBy]);
  const repostTime = useMemo(() => repostedBy?.date ? formatRelativeTime(repostedBy.date) : undefined, [repostedBy?.date, formatRelativeTime]);

  return (
    <View style={{ paddingHorizontal }}>
      <View className="flex-row items-start justify-between">
        <ProfileHoverCard username={user.handle}>
          <TouchableOpacity activeOpacity={0.7} onPress={onPressAvatar}>
            <PostAvatar uri={avatarUri} size={avatarSize} />
          </TouchableOpacity>
        </ProfileHoverCard>
        <View className="flex-1" style={{ gap: 4 }}>
          <View className="flex-row items-center" style={{ gap: ROW_GAP }}>
            <UserName
              name={user.name}
              verified={user.verified}
              onPress={onPressUser}
            />
            {user.handle ? <Text className="text-muted-foreground text-[15px]">@{user.handle}</Text> : null}
            {user.isFederated ? (
              <FediverseIcon size={13} className="text-muted-foreground" />
            ) : null}
            {!!timeLabel && <Text className="text-muted-foreground text-[15px]">{'\u00B7'} {timeLabel}</Text>}
            {(repostLabel || showRepost) && (
              <View className="flex-row items-center" style={{ gap: ROW_GAP }}>
                <Ionicons name="repeat" size={12} color={theme.colors.textSecondary} />
                <Text className="text-muted-foreground text-xs">
                  {repostLabel || 'Reposted'}{repostTime ? ` \u00B7 ${repostTime}` : ''}
                </Text>
              </View>
            )}
            {showReply && (
              <View className="flex-row items-center" style={{ gap: ROW_GAP }}>
                <Ionicons name="chatbubble" size={12} color={theme.colors.textSecondary} />
                <Text className="text-muted-foreground text-xs">Replied</Text>
              </View>
            )}
          </View>
          {children ? <View>{children}</View> : null}
        </View>
        {onPressMenu ? (
          <TouchableOpacity
            accessibilityLabel="Post options"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            className="px-2 pt-1"
            onPress={onPressMenu}
          >
            <Ionicons name="ellipsis-horizontal" size={18} color={theme.colors.textSecondary} />
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
};

export default React.memo(PostHeader);
