import React, { useMemo } from 'react';
import { Text, View, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Avatar } from '@oxyhq/bloom/avatar';

import UserName from '../UserName';
import { ProfileHoverCard } from '../ProfileHoverCard';
import { useTheme } from '@oxyhq/bloom/theme';
import { FediverseIcon } from '@/assets/icons/fediverse-icon';
import { BoostIcon } from '@/assets/icons/boost-icon';
import { formatRelativeTimeCompact } from '@/utils/dateUtils';

// Inline indicator icons (boost/reply) are subtler than the action-bar glyphs.
const INDICATOR_ICON_SIZE = 14;

// PostHeader-local default spacing. HPAD here (8px) is only the fallback for the
// `paddingHorizontal` prop — callers (PostItem, compose, detail) pass their own
// context-specific padding, so this deliberately differs from the feed (12px),
// compose (16px) and detail (16px) horizontal paddings.
const HPAD = 8;
const ROW_GAP = 8;

/**
 * Default vertical gap between the header's name row and its content-column
 * children (the `contentGap` prop default). Used where the body should hug the
 * name tightly (e.g. the compose input). The feed/detail post overrides this
 * with `SECTION_GAP` so the post's vertical spacing is uniform.
 */
export const HEADER_CONTENT_GAP = 4;

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
  paddingHorizontal?: number;
  /**
   * Vertical gap between the name row and the content-column children. Defaults
   * to `HEADER_CONTENT_GAP`. Callers that want the header's content spacing to
   * match the rest of their body layout pass that single shared value here — the
   * feed/detail post passes `SECTION_GAP` so every vertical gap in the post is
   * uniform (name → body → blocks).
   */
  contentGap?: number;
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
  paddingHorizontal = HPAD,
  contentGap = HEADER_CONTENT_GAP,
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

  return (
    <View style={{ paddingHorizontal }}>
      <View className="flex-row items-start justify-between">
        <ProfileHoverCard username={user.handle}>
          <TouchableOpacity activeOpacity={0.7} onPress={onPressAvatar}>
            <Avatar source={avatarUri} size={avatarSize} placeholderColor={placeholderColor} style={{ marginRight: 12 }} />
          </TouchableOpacity>
        </ProfileHoverCard>
        <View className="flex-1" style={{ gap: contentGap }}>
          <View className="flex-row items-center" style={{ gap: ROW_GAP }}>
            {/* Truncatable identity: name + handle shrink and ellipsize; the
                trailing meta (\u00B7 time, indicators) stays fixed and visible. */}
            <View className="flex-row items-center flex-shrink" style={{ gap: ROW_GAP, minWidth: 0 }}>
              <UserName
                name={user.displayName}
                verified={user.verified}
                onPress={onPressUser}
                style={{ container: { flexShrink: 1, minWidth: 0 } }}
              />
              {user.handle ? (
                <Text className="text-muted-foreground text-[15px] flex-shrink" style={{ minWidth: 0 }} numberOfLines={1} ellipsizeMode="tail">
                  @{user.handle}
                </Text>
              ) : null}
              {user.isFederated ? (
                <FediverseIcon size={13} className="text-muted-foreground" />
              ) : null}
            </View>
            {!!timeLabel && <Text className="text-muted-foreground text-[15px]">{'\u00B7'} {timeLabel}</Text>}
            {showBoost && (
              <View accessibilityRole="image" accessibilityLabel="Reposted">
                <BoostIcon size={INDICATOR_ICON_SIZE} className="text-muted-foreground" />
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
