import React, { useMemo } from 'react';
import { Text, View, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LiveAvatar } from '@/components/ui/LiveAvatar';
import { AvatarGroup, type AvatarGroupItem } from '@oxyhq/bloom/avatar-group';

import UserName from '../UserName';
import { ProfileHoverCard } from '../ProfileHoverCard';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { RemoteActorBadge } from '@/components/Fediverse/FediverseBadge';
import { BoostIcon } from '@/assets/icons/boost-icon';
import { formatTimeAgo } from '@/utils/dateUtils';
import { displayNameOrHandle } from '@/utils/displayName';
import type { HydratedAuthor } from '@mention/shared-types';
import { getNormalizedUserHandle } from '@oxyhq/core';

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
   * Avatar image source passed straight to Bloom's {@link Avatar}, which
   * accepts this exact shape natively — a bare Oxy file id (resolved with
   * {@link avatarVariant}), an absolute http(s) URL (rendered directly,
   * `avatarVariant` ignored), or `null`/`undefined` (no author avatar yet).
   * No branching or coercion needed here: pass `user.avatar` straight
   * through, for local and federated authors alike.
   */
  avatarSource?: string | null;
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
  /**
   * Collaborative posts only (owner + ≥1 accepted collaborator): tapping the
   * avatar — which represents the group — opens the collaborators list instead of
   * a single profile. Ignored for solo posts, which keep {@link onPressAvatar}.
   */
  onPressCollaborators?: () => void;
  onPressMenu?: () => void;
  onPressAuthor?: (handle: string) => void;
}

interface HeaderAuthor {
  /** First name shown in the collaborative byline (never a raw id). */
  firstName: string;
  /** Normalized handle used to link to this author's profile. */
  handle: string;
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
  onPressCollaborators,
  onPressMenu,
  onPressAuthor,
}) => {
  const theme = useTheme();
  const { t } = useTranslation();

  const timeLabel = useMemo(() => formatTimeAgo(date || ''), [date]);
  // Collaborative posts (owner + accepted collaborators) render each author's
  // FIRST name as its own tappable link to that author's profile. Reduce the
  // canonical Oxy `User` collaborators to a first-name + normalized-handle view
  // model; a solo post keeps the single-author identity line below.
  const headerAuthors: HeaderAuthor[] = useMemo(
    () =>
      (authors ?? []).map((a) => {
        const handle = getNormalizedUserHandle(a) ?? '';
        // First name only: the structured `name.first`, else the first token of
        // the display name, else the normalized `@handle` (never a raw id).
        const firstName =
          a.name?.first?.trim() ||
          a.name?.displayName?.trim()?.split(/\s+/)?.[0] ||
          (handle ? `@${handle}` : '');
        return { firstName, handle };
      }),
    [authors],
  );
  const isCollabHeader = headerAuthors.length > 1;
  const hasDisplayName = !isCollabHeader && !!user.displayName?.trim();

  // Collaborative posts render a single cluster of every author's avatar in the
  // slot a solo post's avatar occupies. Each member's `avatar` (a bare Oxy file
  // id OR an absolute federated URL) is routed straight into Bloom's `Avatar`
  // source via the group's `uri` — the SAME ImageResolver plumbing the solo
  // avatar uses (variant applied at the group level). `displayName`/`username`
  // drive accessibility only. Empty for solo posts (the cluster is not rendered).
  const collabAvatars = useMemo<AvatarGroupItem[]>(
    () =>
      isCollabHeader
        ? (authors ?? []).map((a) => ({
            id: a.id,
            uri: a.avatar,
            displayName: displayNameOrHandle(a.name?.displayName, getNormalizedUserHandle(a) ?? ''),
            username: a.username,
          }))
        : [],
    [authors, isCollabHeader],
  );

  // `contextTop` rows are the first children of the flex-1 content column, so the
  // name row is pushed down by each fixed-height context row plus the column gap.
  // Offset the avatar + ⋯ menu by the same amount so they keep aligning with the
  // NAME row (not the context row). Zero — and a no-op — when there is no context.
  const contextRowCount = contextTop ? React.Children.toArray(contextTop).length : 0;
  const headerTopOffset = contextRowCount * (POST_CONTEXT_ROW_HEIGHT + HEADER_CONTENT_GAP);

  return (
    <View style={{ paddingHorizontal }}>
      <View className="flex-row items-start justify-between">
        {isCollabHeader ? (
          // The collab avatar represents the whole group: a magnetic bubble
          // cluster of every author's avatar that opens the collaborators list
          // on tap (the sheet lists each @username). `size` is the cluster box
          // diameter, matched to the solo avatar so the layout never shifts.
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={t('collab.viewCollaborators', { defaultValue: 'View collaborators' })}
            disabled={!onPressCollaborators}
            onPress={onPressCollaborators}
            style={{ marginTop: headerTopOffset, marginRight: 12 }}
          >
            <AvatarGroup
              layout="cluster"
              items={collabAvatars}
              size={avatarSize}
              variant={avatarVariant}
              max={20}
            />
          </TouchableOpacity>
        ) : (
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
        )}
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
                >
                  {headerAuthors.map((a, i) => {
                    const isLast = i === headerAuthors.length - 1;
                    const separator = i === 0 ? '' : isLast ? t('collab.and', { defaultValue: ' and ' }) : ', ';
                    // Each first name links to that author's own profile; falls
                    // back to plain text when the author has no resolvable handle.
                    const goToProfile =
                      a.handle && onPressAuthor ? () => onPressAuthor(a.handle) : undefined;
                    return (
                      <React.Fragment key={`${a.handle || 'author'}-${i}`}>
                        {separator}
                        <Text
                          onPress={goToProfile}
                          accessibilityRole={goToProfile ? 'link' : undefined}
                          accessibilityLabel={goToProfile ? a.firstName : undefined}
                        >
                          {a.firstName}
                        </Text>
                      </React.Fragment>
                    );
                  })}
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
