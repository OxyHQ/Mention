import React, { useMemo } from 'react';
import { Text, View, TouchableOpacity } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
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
import type { HydratedAuthor, PostUser } from '@mention/shared-types';
import { getNormalizedUserHandle } from '@oxyhq/core';
import { HIT_SLOP_MD } from '@/styles/hitSlop';

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
  /**
   * Rendered immediately BELOW the identity line, inside the same content column
   * — a newspaper byline's position, for a fact about AUTHORSHIP that does not
   * belong in the identity line's trailing run of quiet facts where it would
   * compete with the time and the lane chip.
   */
  bylineSlot?: React.ReactNode;
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
   * Replaces the relative-time label ("now", "5m", …) in the identity line.
   *
   * That slot is already the header's answer to "when does this post go out",
   * so the composer puts the publish time there once one is chosen instead of
   * adding a second place that says it. Omit it and the label renders exactly
   * as it always has — the composer passes it ONLY while a time is set, so the
   * unscheduled row stays the node it was.
   */
  timeSlot?: React.ReactNode;
  /**
   * Rendered immediately AFTER the time in the identity line — the slot the lane
   * chip occupies (`PostLaneChip`).
   *
   * After the time rather than on a context row of its own: a lane is a lens on
   * a post, not a reason it is in the feed, so it belongs on the identity line
   * with the other quiet facts about the post rather than costing an 18px row
   * above it. Whatever goes here must carry its own shrink rank — the identity
   * line's other children are already ranked against each other.
   */
  laneSlot?: React.ReactNode;
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
   * Collaborative BYLINES only (owner + ≥1 accepted collaborator, or a channel
   * naming its writer): tapping the avatar — which represents the group — opens
   * the author list instead of a single profile. Ignored for a solo byline,
   * which keeps {@link onPressAvatar} even when {@link boostedBy} pairs a second
   * avatar beside the author's.
   */
  onPressCollaborators?: () => void;
  onPressMenu?: () => void;
  onPressAuthor?: (handle: string) => void;
  /**
   * Suppresses the author hover preview on both the avatar and the identity
   * line. For surfaces where the header is not a feed row pointing at someone
   * else — the composer's own preview of the post being written, where a card
   * would pop over the editor.
   */
  disableHoverCard?: boolean;
  /**
   * The account whose BOOST brought this post into the reader's feed, when that
   * is why they are seeing it — the same actor the "Reposted by" context row
   * names. Joins the AVATAR cluster and never the byline; see `clusterMembers`
   * for which end it joins and why.
   */
  boostedBy?: PostUser;
}

interface HeaderAuthor {
  /** First name shown in the collaborative byline (never a raw id). */
  firstName: string;
  /** Normalized handle used to link to this author's profile. */
  handle: string;
}

const PostHeader: React.FC<PostHeaderProps> = ({
  user,
  bylineSlot,
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
  timeSlot,
  laneSlot,
  authorUserId,
  placeholderColor,
  onPressUser,
  onPressAvatar,
  onPressCollaborators,
  onPressMenu,
  onPressAuthor,
  disableHoverCard,
  boostedBy,
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
        // A collaborative byline reads "Ana and Luis", so a PERSON contributes a
        // first name: the structured `name.first`, else the first token of the
        // display name, else the normalized `@handle` (never a raw id).
        //
        // A non-personal account has a TITLE, not a given name, and splitting it
        // is wrong in a way that looks like truncation: "Notas de Nate" rendered
        // as "Notas". That is the same distinction `name_display` exists for —
        // an organization or a channel sets `displayName` and leaves
        // `first`/`last` unset precisely so nobody composes a name from parts it
        // does not have.
        const isPerson = a.kind === undefined || a.kind === 'personal';
        const wholeName = a.name?.displayName?.trim();
        const firstName = isPerson
          ? a.name?.first?.trim() ||
            wholeName?.split(/\s+/)?.[0] ||
            (handle ? `@${handle}` : '')
          : wholeName || (handle ? `@${handle}` : '');
        return { firstName, handle };
      }),
    [authors],
  );
  // The BYLINE is collaborative when more than one person is NAMED. It is read
  // off `authors` alone, so nothing below can grow it: a booster never earns a
  // name, and an author who boosted keeps their place in the sentence.
  const isCollabByline = headerAuthors.length > 1;
  const hasDisplayName = !isCollabByline && !!user.displayName?.trim();

  // `writer` is the role hydration gives the human behind a SIGNED channel post,
  // and it exists on no other byline — so it, not the account kind, is what says
  // "this is a channel naming its writer".
  const bylineNamesWriter = useMemo(
    () => (authors ?? []).some((a) => a.role === 'writer'),
    [authors],
  );

  // Who is in the avatar cluster, and in what order.
  //
  // The cluster is the post's AUTHORS. When a boost is why the reader is seeing
  // this row, the booster joins it — and which end they join is not a style
  // choice, it is what they are to this post:
  //
  //  - An author who boosted it LEADS. Both members genuinely authored it (a
  //    signed channel post is the case that produces this: the channel and the
  //    person who wrote it), so the lead says which of those relationships
  //    surfaced the row — someone following the writer got here through the
  //    writer, someone following the channel through the channel.
  //  - Anyone else TRAILS. They authored nothing, so the second avatar is
  //    attribution, not a byline entry, and leading with it would read as one.
  //
  // Trailing is confined to a SOLO byline on purpose. A multi-author cluster is
  // the byline made visual and tapping it opens a list of exactly those authors,
  // so an extra avatar with no row in that list is a mismatch the reader cannot
  // resolve — and the "Reposted by" context row above already names the booster.
  //
  // An orphan federated post carries no `authors` at all, so there is no
  // author-shaped record to pair the booster with; it keeps its solo avatar.
  const clusterMembers = useMemo<PostUser[]>(() => {
    const members: PostUser[] = [...(authors ?? [])];
    if (!boostedBy) return members;
    const boosterIndex = members.findIndex((member) => member.id === boostedBy.id);
    if (boosterIndex > 0) {
      const [lead] = members.splice(boosterIndex, 1);
      members.unshift(lead);
    } else if (boosterIndex < 0 && members.length === 1) {
      members.push(boostedBy);
    }
    return members;
  }, [authors, boostedBy]);

  // Each member's `avatar` (a bare Oxy file id OR an absolute federated URL) is
  // routed straight into Bloom's `Avatar` source via the group's `uri` — the
  // SAME ImageResolver plumbing the solo avatar uses (variant applied at the
  // group level). `displayName`/`username` drive accessibility only. Empty
  // whenever one avatar says everything, in which case the solo avatar renders.
  const collabAvatars = useMemo<AvatarGroupItem[]>(
    () =>
      clusterMembers.length > 1
        ? clusterMembers.map((member) => ({
            id: member.id,
            uri: member.avatar,
            displayName: displayNameOrHandle(
              member.name?.displayName,
              getNormalizedUserHandle(member) ?? '',
            ),
            username: member.username,
          }))
        : [],
    [clusterMembers],
  );
  const showAvatarCluster = collabAvatars.length > 1;

  // `contextTop` rows are the first children of the flex-1 content column, so the
  // name row is pushed down by each fixed-height context row plus the column gap.
  // Offset the avatar + ⋯ menu by the same amount so they keep aligning with the
  // NAME row (not the context row). Zero — and a no-op — when there is no context.
  const contextRowCount = contextTop ? React.Children.toArray(contextTop).length : 0;
  const headerTopOffset = contextRowCount * (POST_CONTEXT_ROW_HEIGHT + HEADER_CONTENT_GAP);

  return (
    <View style={{ paddingHorizontal }}>
      <View className="flex-row items-start justify-between">
        {showAvatarCluster ? (
          // A magnetic bubble cluster in the slot the solo avatar occupies —
          // `size` is the cluster box diameter, matched to the solo avatar so
          // the layout never shifts.
          //
          // What a tap means follows the byline, not the cluster: a
          // collaborative byline's cluster stands for the whole group and opens
          // the author list (which lists each @username), while an
          // attribution pair still has ONE author, so it goes where that
          // author's avatar has always gone. The pair keeps the author's hover
          // preview for the same reason; the group has no single subject to
          // preview, so `username` is withheld and the card renders inert.
          //
          // The cluster is a Bloom `AvatarGroup` and not a `LiveAvatar`, so a
          // reposted row cannot carry the Syra live badge — the badge belongs to
          // one person and this slot no longer represents one.
          <ProfileHoverCard
            username={isCollabByline ? undefined : user.handle}
            disable={disableHoverCard}
          >
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={
                isCollabByline
                  ? t('collab.viewCollaborators', { defaultValue: 'View collaborators' })
                  : displayNameOrHandle(user.displayName, user.handle ? `@${user.handle}` : '')
              }
              disabled={isCollabByline ? !onPressCollaborators : !onPressAvatar}
              onPress={isCollabByline ? onPressCollaborators : onPressAvatar}
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
          </ProfileHoverCard>
        ) : (
          <ProfileHoverCard username={user.handle} disable={disableHoverCard}>
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
            {isCollabByline ? (
              <View className="flex-row items-end flex-shrink" style={{ minWidth: 0 }}>
                <Text
                  className="text-foreground text-[15px] font-semibold leading-tight"
                  style={{ flexShrink: 1, minWidth: 0 }}
                  numberOfLines={2}
                >
                  {headerAuthors.map((a, i) => {
                    const isLast = i === headerAuthors.length - 1;
                    // A channel signing with its writer is not a list of
                    // co-authors: the channel published it and a person wrote
                    // it, so the byline reads "Notas de Nate by Nate". `and`
                    // would claim they authored it jointly.
                    const separator =
                      i === 0
                        ? ''
                        : isLast
                          ? bylineNamesWriter
                            ? t('collab.by', { defaultValue: ' by ' })
                            : t('collab.and', { defaultValue: ' and ' })
                          : ', ';
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
              </View>
            ) : (
              // The whole identity line \u2014 name, `@handle` and the federated badge
              // \u2014 is one hover target, so pointing at ANY part of it previews the
              // author (the avatar is its own target above).
              <ProfileHoverCard
                username={user.handle}
                disable={disableHoverCard}
                style={{ minWidth: 0 }}
              >
                <View className="flex-row items-end flex-shrink" style={{ minWidth: 0 }}>
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
                </View>
              </ProfileHoverCard>
            )}
            {timeSlot ?? (!!timeLabel && (
              <Text
                className="text-muted-foreground text-[15px] leading-tight web:whitespace-nowrap"
                style={{ flexShrink: 0 }}
              >
                {'\u00B7'} {timeLabel}
              </Text>
            ))}
            {laneSlot}
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
          {bylineSlot}
          {children ? <View>{children}</View> : null}
        </View>
        {onPressMenu ? (
          <TouchableOpacity
            accessibilityLabel="Post options"
            hitSlop={HIT_SLOP_MD}
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
