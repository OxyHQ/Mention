import React, { useMemo } from 'react';
import { Text, View, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LiveAvatar } from '@/components/ui/LiveAvatar';

import UserName from '../UserName';
import { ProfileHoverCard } from '../ProfileHoverCard';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { RemoteActorBadge } from '@/components/Fediverse/FediverseBadge';
import { BoostIcon } from '@/assets/icons/boost-icon';
import { formatTimeAgo } from '@/utils/dateUtils';
import type { HydratedAuthor } from '@mention/shared-types';
import { displayNameOrHandle } from '@/utils/displayName';

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
  displayName?: string;
  handle: string;
  verified?: boolean;
  isFederated?: boolean;
  instance?: string;
}

interface PostHeaderProps {
  user: User;
  /** Owner + accepted collaborators for collab posts. Falls back to `user` when omitted. */
  authors?: HydratedAuthor[];
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
   * aligned with the name row, and `PostItem` applies the same offset to the
   * thread line so it reaches the offset avatar.
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
  /**
   * Oxy user id of the post author. When that author is currently live in a Syra
   * room, the avatar shows a live badge and tapping it joins the room instead of
   * opening the profile. Omit it for non-user avatars (e.g. the compose preview).
   */
  authorUserId?: string;
  placeholderColor?: string;
  onPressUser?: () => void;
  onPressAvatar?: () => void;
  onPressMenu?: () => void;
  onPressAuthor?: (handle: string) => void;
}

function formatCollabAuthorLine(authors: HydratedAuthor[], t: (key: string, opts?: Record<string, unknown>) => string): string {
  const names = authors.map((a) => displayNameOrHandle(a.displayName, a.handle ? `@${a.handle}` : ''));
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) {
    return t('collab.twoAuthors', { defaultValue: '{{a}} and {{b}}', a: names[0], b: names[1] });
  }
  const last = names[names.length - 1];
  const rest = names.slice(0, -1).join(', ');
  return t('collab.manyAuthors', { defaultValue: '{{rest}} and {{last}}', rest, last });
}

const PostHeader: React.FC<PostHeaderProps> = ({
  user,
  authors,
  date,
  showBoost,
  showReply,
  paddingHorizontal = HPAD,
  children,
  contextTop,
  avatarSource,
  avatarVariant,
  avatarSize = 36,
  authorUserId,
  placeholderColor,
  onPressUser,
  onPressAvatar,
  onPressMenu,
  onPressAuthor,
}) => {
  const theme = useTheme();
  const { t } = useTranslation();

  const timeLabel = useMemo(() => formatTimeAgo(date || ''), [date]);
  const headerAuthors = authors && authors.length > 0 ? authors : [{ ...user, role: 'owner' as const, status: 'accepted' as const, id: '' }];
  const isCollabHeader = headerAuthors.length > 1;
  const collabLine = useMemo(
    () => (isCollabHeader ? formatCollabAuthorLine(headerAuthors, t) : ''),
    [headerAuthors, isCollabHeader, t],
  );
  const hasDisplayName = !isCollabHeader && !!user.displayName?.trim();

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
          <LiveAvatar
            userId={authorUserId}
            source={avatarSource}
            variant={avatarVariant}
            size={avatarSize}
            placeholderColor={placeholderColor}
            onPress={onPressAvatar}
            style={{ marginTop: headerTopOffset, marginRight: 12 }}
          />
        </ProfileHoverCard>
        <View className="flex-1" style={{ gap: HEADER_CONTENT_GAP }}>
          {contextTop}
          <View className="flex-row items-end" style={{ gap: ROW_GAP }}>
            {/* Bluesky-style identity line: the display name takes the space it
                needs (no width cap); the @handle gives way first (shrinks
                aggressively); the trailing "\u00B7 time" never wraps and stays visible.
                With NO display name the @handle becomes the bold primary (rendered
                ONCE here \u2014 the trailing muted handle is suppressed), never blank. */}
            <View className="flex-row items-end flex-shrink" style={{ minWidth: 0 }}>
              {isCollabHeader ? (
                <Text
                  className="text-foreground text-[15px] font-semibold leading-tight"
                  style={{ flexShrink: 1, minWidth: 0 }}
                  numberOfLines={2}
                  onPress={onPressUser}
                >
                  {collabLine}
                </Text>
              ) : (
                <>
                  <UserName
                    name={hasDisplayName ? user.displayName : (user.handle ? `@${user.handle}` : undefined)}
                    verified={user.verified}
                    onPress={onPressUser}
                    style={{ container: { flexShrink: 0 } }}
                  />
                  {hasDisplayName && user.handle ? (
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
                    <RemoteActorBadge size={13} className="text-muted-foreground" containerClassName="self-center ml-1" />
                  ) : null}
                </>
              )}
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
