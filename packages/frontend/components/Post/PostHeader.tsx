import React, { useMemo } from 'react';
import { Text, View, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Avatar } from '@oxyhq/bloom/avatar';

import UserName from '../UserName';
import { ProfileHoverCard } from '../ProfileHoverCard';
import { useTheme } from '@oxyhq/bloom/theme';
import { FediverseIcon } from '@/assets/icons/fediverse-icon';
import { formatRelativeTimeCompact } from '@/utils/dateUtils';

// PostHeader-local default spacing. HPAD here (8px) is only the fallback for the
// `paddingHorizontal` prop — callers (PostItem, compose, detail) pass their own
// context-specific padding, so this deliberately differs from the feed (12px),
// compose (16px) and detail (16px) horizontal paddings.
const HPAD = 8;
const ROW_GAP = 8;

interface User {
  displayName: string;
  handle: string;
  verified?: boolean;
  isFederated?: boolean;
  instance?: string;
}

interface PostHeaderProps {
  user: User;
  date?: string;
  showBoost?: boolean;
  showReply?: boolean;
  boostedBy?: { displayName: string; handle: string; verified?: boolean; date?: string };
  paddingHorizontal?: number;
  children?: React.ReactNode;
  avatarUri?: string;
  avatarSize?: number;
  avatarGap?: number;
  placeholderColor?: string;
  onPressUser?: () => void;
  onPressAvatar?: () => void;
  onPressMenu?: () => void;
}

const PostHeader: React.FC<PostHeaderProps> = ({
  user,
  date,
  showBoost,
  showReply,
  boostedBy,
  paddingHorizontal = HPAD,
  children,
  avatarUri,
  avatarSize = 36,

  placeholderColor,
  onPressUser,
  onPressAvatar,
  onPressMenu,
}) => {
  const theme = useTheme();

  const timeLabel = useMemo(() => formatRelativeTimeCompact(date || ''), [date]);
  const boostLabel = useMemo(() => boostedBy ? `${boostedBy.displayName} boosted` : undefined, [boostedBy]);
  const boostTime = useMemo(() => boostedBy?.date ? formatRelativeTimeCompact(boostedBy.date) : undefined, [boostedBy?.date]);

  return (
    <View style={{ paddingHorizontal }}>
      <View className="flex-row items-start justify-between">
        <ProfileHoverCard username={user.handle}>
          <TouchableOpacity activeOpacity={0.7} onPress={onPressAvatar}>
            <Avatar source={avatarUri} size={avatarSize} placeholderColor={placeholderColor} style={{ marginRight: 12 }} />
          </TouchableOpacity>
        </ProfileHoverCard>
        <View className="flex-1" style={{ gap: 4 }}>
          <View className="flex-row items-center" style={{ gap: ROW_GAP }}>
            <UserName
              name={user.displayName}
              verified={user.verified}
              onPress={onPressUser}
            />
            {user.handle ? (
              <Text className="text-muted-foreground text-[15px]">
                @{user.handle}
              </Text>
            ) : null}
            {user.isFederated ? (
              <FediverseIcon size={13} className="text-muted-foreground" />
            ) : null}
            {!!timeLabel && <Text className="text-muted-foreground text-[15px]">{'\u00B7'} {timeLabel}</Text>}
            {(boostLabel || showBoost) && (
              <View className="flex-row items-center" style={{ gap: ROW_GAP }}>
                <Ionicons name="repeat" size={12} color={theme.colors.textSecondary} />
                <Text className="text-muted-foreground text-xs">
                  {boostLabel || 'Boosted'}{boostTime ? ` \u00B7 ${boostTime}` : ''}
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
