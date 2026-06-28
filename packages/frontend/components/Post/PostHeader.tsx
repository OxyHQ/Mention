import React, { useMemo } from 'react';
import { Text, View, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Avatar } from '@oxyhq/bloom/avatar';

import UserName from '../UserName';
import { ProfileHoverCard } from '../ProfileHoverCard';
import { useTheme } from '@oxyhq/bloom/theme';
import { FediverseIcon } from '@/assets/icons/fediverse-icon';
import { BoostIcon } from '@/assets/icons/boost-icon';
import { formatTimeAgo } from '@/utils/dateUtils';

// Inline indicator icons (boost/reply) are subtler than the action-bar glyphs.
const INDICATOR_ICON_SIZE = 14;

// PostHeader-local default spacing. HPAD here (8px) is only the fallback for the
// `paddingHorizontal` prop — callers (PostItem, compose, detail) pass their own
// context-specific padding, so this deliberately differs from the feed (12px),
// compose (16px) and detail (16px) horizontal paddings.
const HPAD = 8;
const ROW_GAP = 8;

/**
 * Vertical gap between the header's name row and the first content node in its
 * content column (the body text rendered as a `PostHeader` child). Exported so a
 * post with NO text can hug its first external content block (media/location)
 * under the header with the SAME gap a text line would produce — avoiding an
 * orphaned "reserved text line" space. See `PostItem`'s first-content-block gap.
 */
export const HEADER_CONTENT_GAP = 4;

/**
 * Fixed height of a single Bluesky-style context row ("Reposted by" / "Pinned" /
 * "Replying to") rendered through {@link PostHeaderProps.contextTop}. It is fixed
 * (rather than intrinsic) so the avatar/menu vertical offset that re-aligns them
 * with the name row stays exact and deterministic — no measurement, no `onLayout`.
 * See `headerTopOffset` in the component body.
 */
export const POST_CONTEXT_ROW_HEIGHT = 18;

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
  children?: React.ReactNode;
  /**
   * Optional Bluesky-style context rows ("Reposted by" / "Pinned" / "Replying
   * to") rendered as the FIRST child of the name's content column — above the
   * name row, so the context text aligns with the display name (same column, no
   * left padding needed). Pass an ARRAY of fixed-height ({@link POST_CONTEXT_ROW_HEIGHT})
   * rows; the avatar and the ⋯ menu are offset down by that height so they stay
   * aligned with the name row rather than the context row.
   */
  contextTop?: React.ReactNode;
  /**
   * Avatar image source passed straight to Bloom's {@link Avatar}. Accepts a full
   * http(s) URL (federated/remote actor avatar — rendered directly) OR a bare Oxy
   * file id for a LOCAL actor — Bloom's `ImageResolver` resolves the file id with
   * {@link avatarVariant}. The federated-vs-local branch is owned by the caller
   * (it picks the URL or the file id); Bloom disambiguates URL vs file id again.
   */
  avatarSource?: string;
  /**
   * Rendition variant for `avatarSource` when it is a bare file id (local actor).
   * Ignored by Bloom when `avatarSource` is already a full URL.
   */
  avatarVariant?: string;
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
  children,
  contextTop,
  avatarSource,
  avatarVariant,
  avatarSize = 36,

  placeholderColor,
  onPressUser,
  onPressAvatar,
  onPressMenu,
}) => {
  const theme = useTheme();

  const timeLabel = useMemo(() => formatTimeAgo(date || ''), [date]);

  // `contextTop` rows are the first children of the flex-1 content column, so the
  // name row is pushed down by each fixed-height context row plus the column gap.
  // Offset the avatar + ⋯ menu by the same amount so they keep aligning with the
  // NAME row (not the context row). Zero — and a no-op — when there is no context.
  const contextRowCount = contextTop ? React.Children.toArray(contextTop).length : 0;
  const headerTopOffset = contextRowCount * (POST_CONTEXT_ROW_HEIGHT + HEADER_CONTENT_GAP);

  return (
    <View style={{ paddingHorizontal }}>
      <View className="flex-row items-start justify-between">
        <ProfileHoverCard username={user.handle}>
          <TouchableOpacity activeOpacity={0.7} onPress={onPressAvatar} style={{ marginTop: headerTopOffset }}>
            <Avatar source={avatarSource} variant={avatarVariant} size={avatarSize} placeholderColor={placeholderColor} style={{ marginRight: 12 }} />
          </TouchableOpacity>
        </ProfileHoverCard>
        <View className="flex-1" style={{ gap: HEADER_CONTENT_GAP }}>
          {contextTop}
          <View className="flex-row items-end" style={{ gap: ROW_GAP }}>
            {/* Bluesky-style identity line: the display name takes the space it
                needs (no width cap); the @handle gives way first (shrinks
                aggressively); the trailing "\u00B7 time" never wraps and stays visible. */}
            <View className="flex-row items-end flex-shrink" style={{ minWidth: 0 }}>
              <UserName
                name={user.displayName}
                verified={user.verified}
                onPress={onPressUser}
                style={{ container: { flexShrink: 0 } }}
              />
              {user.handle ? (
                <Text
                  className="text-muted-foreground text-[15px] leading-tight"
                  style={{ flexShrink: 10, minWidth: 0 }}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {`\u00A0@${user.handle}`}
                </Text>
              ) : null}
              {user.isFederated ? (
                <FediverseIcon size={13} className="text-muted-foreground self-center ml-1" />
              ) : null}
            </View>
            {!!timeLabel && (
              <Text
                className="text-muted-foreground text-[15px] leading-tight web:whitespace-nowrap"
                style={{ flexShrink: 0 }}
              >
                {'\u00B7'} {timeLabel}
              </Text>
            )}
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
            className="px-2"
            style={{ marginTop: headerTopOffset }}
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
