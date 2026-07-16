import React, { useCallback, useContext, useMemo, useState } from 'react';
import { View, Pressable, Text } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { Avatar } from '@oxyhq/bloom/avatar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types';
import { Button } from '@oxyhq/bloom/button';
import { SubtleHover } from '@oxyhq/bloom/subtle-hover';
import { useTheme } from '@oxyhq/bloom/theme';
import { show as toast } from '@oxyhq/bloom/toast';
import { queryKeys as sdkQueryKeys } from '@oxyhq/services';
import { getNormalizedUserHandle } from '@oxyhq/core';
import type { User } from '@oxyhq/core';
import type { PostUser } from '@mention/shared-types';

import UserName from '../UserName';
import { LinkifiedText } from '../common/LinkifiedText';
import { RemoteActorBadge } from '@/components/Fediverse/FediverseBadge';
import CollabAcceptSheet from '@/components/Compose/CollabAcceptSheet';
import { DoneAllIcon } from '@/assets/icons/done-all-icon';
import { TrashIcon } from '@/assets/icons/trash-icon';
import { getDescriptor, type TranslateFn } from './notificationDescriptors';
import { useUserById } from '@/hooks/useCachedUser';
import type { GroupedNotification } from '@/utils/groupNotifications';
import { POST_ITEM_SPACING } from '@/styles/shared';
import { formatRelativeTimeLocalized } from '@/utils/dateUtils';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { feedService } from '@/services/feedService';
import { usePostsStore } from '@/stores/postsStore';
import { queryKeys } from '@/hooks/useOptimizedQuery';
import { cn } from '@/lib/utils';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('NotificationItem');

type GroupedActor = GroupedNotification['actors'][number];

// The avatar column mirrors the feed post anatomy (single source of truth:
// POST_ITEM_SPACING). AVATAR_SIZE = 40. The row's horizontal padding (HPAD = 12
// → px-3), vertical padding (VPAD = 12 → py-3) and avatar gap (AVATAR_GAP = 12 →
// mr-3) are expressed as NativeWind classes below so the row reads like a post.
const AVATAR_SIZE = POST_ITEM_SPACING.AVATAR_SIZE;

const BADGE_ICON_SIZE = 12;
// The action badge FILL is themed (`theme.colors[colorToken]`); this white glyph
// sits on top of that saturated fill for contrast across every preset/mode. A
// named constant, not a stray magic hex.
const BADGE_GLYPH_COLOR = '#ffffff';

const STACK_AVATAR_SIZE = 24;
// Compact media chip on the trailing edge of a row whose post carries an image.
const THUMBNAIL_SIZE = 48;
// Actors shown in the collapsed avatar strip before collapsing into "+N".
const COLLAPSED_STRIP_LIMIT = 3;
// Matches a bare Oxy user id so it is never surfaced as a display name.
const OXY_ID_PATTERN = /^[a-f0-9]{24}$/i;

/**
 * An actor resolved for display: the raw grouped actor merged with its cached
 * Oxy `User` (when warm). Splits the identity into a ghost-guarded `displayName`
 * and a normalized `handle` so the byline can render the name bold and the
 * `@handle` muted, exactly like the feed's `PostHeader`.
 */
interface ResolvedActor {
  id: string;
  /** Ghost-guarded display name — never a raw 24-hex id. `undefined` when none. */
  displayName?: string;
  /** Raw Oxy username (for the collab `PostUser` shape). */
  username?: string;
  /** Normalized handle (no leading `@`) for profile routing + the muted line. */
  handle?: string;
  avatar?: string | null;
  verified: boolean;
  isFederated: boolean;
}

/**
 * Drop id-like display names (ghost-handle rule): `groupNotifications` falls back
 * `name = actorId` when no display name resolved, so an id-like or empty name
 * means "no name" — the byline then falls to `@handle`, never the raw id.
 */
function ghostGuardedName(rawName: string | undefined | null, actorId: string | undefined): string | undefined {
  const name = rawName?.trim();
  if (!name) return undefined;
  if (OXY_ID_PATTERN.test(name)) return undefined;
  if (actorId && name === actorId) return undefined;
  return name;
}

/** Normalized profile handle (local `username`, federated `username@instance`). */
function normalizedHandle(username: string | undefined | null, cached: User | undefined): string | undefined {
  const handle = getNormalizedUserHandle({
    username: username ?? null,
    instance: cached?.instance ?? null,
    isFederated: cached?.isFederated ?? null,
    federation: cached?.federation ?? null,
  });
  return handle ?? undefined;
}

/**
 * Merge a raw grouped actor with its cached Oxy `User` (when present). Cached
 * fields win — restoring the proven fallback the old row had via the prewarmed
 * user cache — with the raw actor as the floor.
 */
function mergeActor(actor: GroupedActor | undefined, cached: User | undefined): ResolvedActor {
  const username = cached?.username ?? actor?.username;
  return {
    id: actor?.id ?? cached?.id ?? '',
    displayName: ghostGuardedName(cached?.name?.displayName ?? actor?.name, actor?.id),
    username,
    handle: normalizedHandle(username, cached),
    avatar: cached?.avatar ?? actor?.avatar ?? undefined,
    verified: cached?.verified === true,
    isFederated: cached?.isFederated === true,
  };
}

/** Human label for an actor: display name, else `@handle`, else neutral "Someone". */
function actorLabel(actor: ResolvedActor, someone: string): string {
  if (actor.displayName) return actor.displayName;
  if (actor.handle) return `@${actor.handle}`;
  return someone;
}

/** Build the "Alice, Bob and 3 more" actor clause for grouped bylines. */
function buildActorString(actors: ResolvedActor[], totalActors: number, t: TranslateFn): string {
  const someone = t('notification.someone', { defaultValue: 'Someone' });
  const names = actors.map((a) => actorLabel(a, someone));
  const first = names[0] ?? someone;
  const second = names[1] ?? someone;
  const remaining = totalActors - names.length;

  if (names.length === 1 && remaining === 0) return first;
  if (names.length === 2 && remaining === 0) {
    return t('notification.group.two_actors', {
      actor1: first,
      actor2: second,
      defaultValue: '{{actor1}} and {{actor2}}',
    });
  }
  if (remaining > 0) {
    return t('notification.group.many_actors', {
      actors: names.slice(0, 2).join(', '),
      count: remaining,
      defaultValue: '{{actors}} and {{count}} more',
    });
  }
  return names.join(', ');
}

/** Text preview source from an embedded/hydrated post's `content`. */
function postContentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    const text = (content as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return undefined;
}

/** Reads a non-empty string field off a loosely-typed embedded media object. */
function mediaField(item: Record<string, unknown>, key: string): string | undefined {
  const value = item[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The first renderable image on an embedded/hydrated post's `content`, or
 * `undefined` when the post carries no displayable media.
 *
 * The embedded post comes from `PostHydrationService`, so its media items
 * already hold ready-to-render URLs — the precedence here (`thumbUrl` →
 * `posterUrl` → `url`) matches the feed's media grid. Nothing extra is fetched.
 * A video contributes only its still frame: its `url` is the playable stream,
 * never an image. Fails soft (no chip) when nothing resolves.
 */
function postThumbnailUrl(content: unknown): string | undefined {
  if (!content || typeof content !== 'object') return undefined;
  const media = (content as { media?: unknown }).media;
  if (!Array.isArray(media)) return undefined;
  for (const entry of media) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const still = mediaField(item, 'thumbUrl') ?? mediaField(item, 'posterUrl');
    const url = item.type === 'video' ? still : (still ?? mediaField(item, 'url'));
    if (url) return url;
  }
  return undefined;
}

/**
 * Lightweight text preview of the related post — the same `LinkifiedText`
 * primitive the feed uses, WITHOUT mounting a `PostItem` (no per-row engagement
 * hooks or SQLite reads). Renders nothing when there is no text.
 */
const NotificationPreview: React.FC<{ text: string }> = ({ text }) => (
  <LinkifiedText text={text} numberOfLines={2} className="text-muted-foreground text-sm leading-5" />
);

/** Collapsed stacked-avatar strip (up to 3 + "+N") for grouped rows. */
const AvatarStrip: React.FC<{ actors: ResolvedActor[]; totalActors: number }> = ({ actors, totalActors }) => {
  const shown = actors.slice(0, COLLAPSED_STRIP_LIMIT);
  const extra = totalActors - shown.length;
  return (
    <View className="flex-row items-center">
      {shown.map((actor, index) => (
        // `zIndex` is the only per-item dynamic value (stack order) — everything
        // else is NativeWind. The -8px overlap for every avatar after the first
        // is `-ml-2`.
        <View
          key={actor.id}
          className={cn(index > 0 && '-ml-2')}
          style={{ zIndex: shown.length - index }}
        >
          <View className="border-2 border-background rounded-full">
            <Avatar source={actor.avatar} size={STACK_AVATAR_SIZE} variant={MEDIA_VARIANT_AVATAR} />
          </View>
        </View>
      ))}
      {extra > 0 ? (
        <View className="-ml-2">
          <View className="w-7 h-7 rounded-full border-2 bg-primary border-background items-center justify-center">
            <Text className="text-primary-foreground text-[9px] font-bold">+{extra}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
};

const ACTION_ICON_SIZE = 20;

/**
 * One row of the long-press action sheet. Mirrors the grouped, rounded row
 * treatment the shared widget menu uses (`useWidgetItemMenu`), with a
 * `destructive` variant for the red delete affordance.
 */
const NotificationActionRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  destructive?: boolean;
  isFirst: boolean;
  isLast: boolean;
}> = ({ icon, label, onPress, destructive, isFirst, isLast }) => (
  <Pressable
    className={cn(
      'bg-surface flex-row items-center justify-between py-3 px-3.5 active:opacity-70',
      isFirst && 'rounded-t-2xl',
      isLast ? 'rounded-b-2xl' : 'mb-1',
    )}
    onPress={onPress}
    accessibilityRole="button"
    accessibilityLabel={label}
  >
    <Text className={cn('text-base font-medium', destructive ? 'text-destructive' : 'text-foreground')}>{label}</Text>
    <View className="ml-3">{icon}</View>
  </Pressable>
);

interface NotificationItemProps {
  item: GroupedNotification;
  /** Marks the given notification ids read (single -> `[id]`, group -> all ids). */
  onMarkAsRead: (ids: string[]) => void;
  /** Deletes the given notification ids (single -> `[id]`, group -> all ids). */
  onDelete: (ids: string[]) => void;
}

const NotificationItemComponent: React.FC<NotificationItemProps> = ({ item, onMarkAsRead, onDelete }) => {
  const router = useRouter();
  const { t } = useTranslation();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const bottomSheet = useContext(BottomSheetContext);
  // Shared post cache (SQLite/memory) that every feed + the post detail read from.
  // Accepting/declining an invite mutates the post's authorship, so the updated
  // post must be propagated here — updating only the React Query post-detail cache
  // leaves the timeline/profile rendering the pre-collaboration copy.
  const cachePosts = usePostsStore((s) => s.cachePosts);

  const descriptor = getDescriptor(item.type);
  const primaryActor = item.actors[0];
  const hasUnread = item.hasUnread;
  const isGroup = item.isGroup;
  const isWelcome = item.type === 'welcome';
  const isCollabInvite = item.type === 'collab_invite';
  const postId = String(item.leadNotification.entityId ?? '');
  const someone = t('notification.someone', { defaultValue: 'Someone' });

  const [expanded, setExpanded] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // Resolve the PRIMARY actor from the Oxy user cache reactively (the screen
  // prewarms it via `prewarmUsersByIds`). Cached fields are merged over the raw
  // `actors[0]`, so names + real avatars appear even when the backend's
  // `actorId_populated` is empty. Gate on a real Oxy id (same 24-hex gate the
  // prewarm uses) so a non-Oxy id (e.g. the "unknown" floor) never fires a stray
  // per-row `getUserById` on a cache miss.
  const primaryOxyId = primaryActor?.id && OXY_ID_PATTERN.test(primaryActor.id) ? primaryActor.id : undefined;
  const cachedPrimary = useUserById(primaryOxyId);
  const resolvedPrimary = useMemo(() => mergeActor(primaryActor, cachedPrimary), [primaryActor, cachedPrimary]);

  // Grouped strip / expanded list: best-effort resolve each id from the SAME
  // prewarmed cache (non-reactive read; re-runs when the reactive primary lands,
  // which coincides with the bulk cache write).
  const resolvedActors = useMemo(
    () =>
      item.actors.map((actor, index) =>
        index === 0
          ? resolvedPrimary
          : mergeActor(actor, queryClient.getQueryData<User>(sdkQueryKeys.users.detail(actor.id))),
      ),
    [item.actors, resolvedPrimary, queryClient],
  );

  // Collab invites carry no backend preview — fetch the invited post's text via
  // React Query (replaces the old useEffect + useState load).
  const { data: collabPost } = useQuery({
    queryKey: queryKeys.post(postId),
    queryFn: () => feedService.getPostById(postId),
    enabled: isCollabInvite && !!postId,
    staleTime: 60_000,
  });

  // Whether THIS viewer's invite is still actionable, read from the invited post's
  // authoritative `viewerState` (derived server-side from the post's authorship —
  // the single source of truth). While the post is loading, or once the viewer no
  // longer has view access (a declined private post), none of these are true and
  // the row shows no actionable UI. Accept/decline update the post cache below, so
  // these flip reactively without a manual refresh.
  const collabViewerState = collabPost?.viewerState;
  const collabInvitePending = collabViewerState?.collabInvitePending === true;
  const collabAccepted = collabViewerState?.isCollaborator === true;
  // The viewer holds a collaborator entry that is neither pending nor accepted →
  // they responded by declining the invite.
  const collabDeclined =
    collabViewerState?.viewerRole === 'collaborator' && !collabInvitePending && !collabAccepted;

  const badgeColor = theme.colors[descriptor.colorToken];
  const timeLabel = formatRelativeTimeLocalized(item.createdAt, t);
  const actionText = descriptor.actionPhrase(t);

  // The bold byline name: grouped -> "María and 3 others"; welcome -> the welcome
  // title; single -> the resolved display name (or @handle floor).
  const bylineName = useMemo(() => {
    if (isWelcome) return t('notification.welcome.title');
    if (isGroup) return buildActorString(resolvedActors, item.totalActors, t);
    return actorLabel(resolvedPrimary, someone);
  }, [isWelcome, isGroup, resolvedActors, item.totalActors, resolvedPrimary, someone, t]);

  // Only a single, non-welcome actor with a real display name gets the muted
  // trailing "@handle" + verified/federated affixes (post-byline treatment).
  const isSingleActor = !isGroup && !isWelcome;
  const hasDisplayName = isSingleActor && !!resolvedPrimary.displayName;
  const showHandleLine = hasDisplayName && !!resolvedPrimary.handle;

  const accessibilityLabel = isWelcome ? `${bylineName}. ${actionText}` : `${bylineName} ${actionText}`;

  const previewText = useMemo(() => {
    if (!descriptor.hasPreview) return undefined;
    const backend = item.leadNotification.preview?.trim();
    if (backend) return backend;
    const source = isCollabInvite ? collabPost?.content : item.leadNotification.post?.content;
    return postContentText(source)?.trim() || undefined;
  }, [descriptor.hasPreview, item.leadNotification.preview, item.leadNotification.post, isCollabInvite, collabPost]);

  // Media chip: shown whenever the referenced post already carries an image on
  // the notification (the backend embeds a hydrated post for `type:'post'`) —
  // it complements the text preview rather than replacing it. No extra fetch.
  const thumbnailUrl = useMemo(() => {
    const source = isCollabInvite ? collabPost?.content : item.leadNotification.post?.content;
    return postThumbnailUrl(source);
  }, [item.leadNotification.post, isCollabInvite, collabPost]);

  const markRead = useCallback(() => {
    if (hasUnread) onMarkAsRead(item.notificationIds);
  }, [hasUnread, onMarkAsRead, item.notificationIds]);

  const handlePress = useCallback(() => {
    markRead();
    if (item.entityType === 'post' || item.entityType === 'reply') {
      router.push(`/p/${item.entityId}`);
    } else if (item.entityType === 'profile' && resolvedPrimary.handle) {
      router.push(`/@${resolvedPrimary.handle}`);
    }
  }, [markRead, item.entityType, item.entityId, resolvedPrimary.handle, router]);

  // Long-press opens a small action sheet offering "Mark as read" (only when the
  // row is unread) and a destructive "Delete". Dismissing the sheet is the
  // implicit cancel. Tapping a row acts, then closes the sheet.
  const handleLongPress = useCallback(() => {
    const rows: { key: string; icon: React.ReactNode; label: string; onPress: () => void; destructive?: boolean }[] = [];
    if (hasUnread) {
      rows.push({
        key: 'mark-read',
        icon: <DoneAllIcon size={ACTION_ICON_SIZE} color={theme.colors.textSecondary} />,
        label: t('notification.mark_read', { defaultValue: 'Mark as read' }),
        onPress: () => {
          bottomSheet.openBottomSheet(false);
          onMarkAsRead(item.notificationIds);
        },
      });
    }
    rows.push({
      key: 'delete',
      icon: <TrashIcon size={ACTION_ICON_SIZE} color={theme.colors.error} />,
      label: t('notification.delete', { defaultValue: 'Delete' }),
      destructive: true,
      onPress: () => {
        bottomSheet.openBottomSheet(false);
        onDelete(item.notificationIds);
      },
    });

    bottomSheet.setBottomSheetContent(
      <View className="bg-background p-4">
        {rows.map((row, index) => (
          <NotificationActionRow
            key={row.key}
            icon={row.icon}
            label={row.label}
            onPress={row.onPress}
            destructive={row.destructive}
            isFirst={index === 0}
            isLast={index === rows.length - 1}
          />
        ))}
      </View>,
    );
    bottomSheet.openBottomSheet(true);
  }, [hasUnread, theme.colors.textSecondary, theme.colors.error, t, bottomSheet, onMarkAsRead, onDelete, item.notificationIds]);

  const openActorProfile = useCallback((actor: ResolvedActor) => {
    if (actor.handle) router.push(`/@${actor.handle}`);
  }, [router]);

  const inviter = useMemo<PostUser>(() => ({
    id: resolvedPrimary.id,
    username: resolvedPrimary.username,
    name: { displayName: resolvedPrimary.displayName ?? bylineName },
    avatar: resolvedPrimary.avatar ?? null,
  }), [resolvedPrimary, bylineName]);

  const runAccept = useCallback(async () => {
    if (!postId) return;
    setActionLoading(true);
    try {
      const result = await feedService.acceptCollabInvite(postId);
      if (result.post) {
        // Flip this row's own source of truth (drives the resolved state) AND
        // propagate the newly-accepted co-authorship to every feed + the post
        // detail via the shared posts store, so the collaboration shows
        // everywhere without a manual refresh.
        queryClient.setQueryData(queryKeys.post(postId), result.post);
        cachePosts([result.post]);
      }
      onMarkAsRead(item.notificationIds);
      bottomSheet.openBottomSheet(false);
      toast(t('collab.acceptedToast', { defaultValue: "You're now a collaborator on this post" }), { type: 'success' });
    } catch (error) {
      logger.error('Failed to accept collab invite', { error });
      toast(t('collab.acceptFailed', { defaultValue: 'Failed to accept invite' }), { type: 'error' });
    } finally {
      setActionLoading(false);
    }
  }, [postId, queryClient, cachePosts, onMarkAsRead, item.notificationIds, bottomSheet, t]);

  const runDecline = useCallback(async () => {
    if (!postId) return;
    setActionLoading(true);
    try {
      const result = await feedService.declineCollabInvite(postId);
      if (result.post) {
        // Flip this row to the resolved state and reflect the declined status on
        // any cached copy of the post (private posts return no post here, in which
        // case the actionable UI is simply dropped — the viewer lost view access).
        queryClient.setQueryData(queryKeys.post(postId), result.post);
        cachePosts([result.post]);
      }
      onMarkAsRead(item.notificationIds);
      bottomSheet.openBottomSheet(false);
    } catch (error) {
      logger.error('Failed to decline collab invite', { error });
      toast(t('collab.declineFailed', { defaultValue: 'Failed to decline invite' }), { type: 'error' });
    } finally {
      setActionLoading(false);
    }
  }, [postId, queryClient, cachePosts, onMarkAsRead, item.notificationIds, bottomSheet, t]);

  const openAcceptSheet = useCallback(() => {
    bottomSheet.setBottomSheetContent(
      <CollabAcceptSheet
        inviter={inviter}
        loading={actionLoading}
        onAccept={runAccept}
        onDecline={runDecline}
        onClose={() => bottomSheet.openBottomSheet(false)}
      />,
    );
    bottomSheet.openBottomSheet(true);
  }, [bottomSheet, inviter, actionLoading, runAccept, runDecline]);

  const toggleExpanded = useCallback(() => setExpanded((v) => !v), []);

  const showStrip = isGroup && resolvedActors.length > 1 && !expanded;

  // Row anatomy copied (NOT imported) from PostItem + PostHeader: a full-width,
  // edge-to-edge Pressable (background + bottom border span the whole width, the
  // group-hover wash matches the feed) with the horizontal padding living INSIDE
  // via the px-3 wrapper — exactly how PostHeader insets its content. Unread rows
  // get the same subtle primary tint the feed uses for emphasis.
  return (
    <Pressable
      className={cn('group w-full bg-background border-b border-border py-3', hasUnread && 'bg-primary/5')}
      onPress={handlePress}
      onLongPress={handleLongPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <SubtleHover />
      <View className="px-3">
        <View className="flex-row items-start justify-between">
          {/* Avatar column: avatar + themed action-badge overlay. */}
          <View className="relative mr-3">
            <Avatar source={resolvedPrimary.avatar} size={AVATAR_SIZE} variant={MEDIA_VARIANT_AVATAR} />
            <View
              className="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full border-2 border-background items-center justify-center"
              style={{ backgroundColor: badgeColor }}
            >
              {descriptor.iconComponent ? (
                <descriptor.iconComponent size={BADGE_ICON_SIZE} color={BADGE_GLYPH_COLOR} />
              ) : (
                <Ionicons name={descriptor.icon} size={BADGE_ICON_SIZE} color={BADGE_GLYPH_COLOR} />
              )}
            </View>
          </View>

          {/* Content column — mirrors PostHeader's flex-1 name/handle/time byline
              plus the muted action phrase and the text preview. */}
          <View className="flex-1 gap-1">
            {showStrip ? <AvatarStrip actors={resolvedActors} totalActors={item.totalActors} /> : null}

            {/* Byline: bold name + muted @handle + federated badge + "· time". */}
            <View className="flex-row items-end gap-2">
              <View className="flex-row items-end flex-shrink min-w-0">
                <UserName
                  name={bylineName}
                  verified={isSingleActor && resolvedPrimary.verified}
                  style={{ container: { flexShrink: 0 } }}
                />
                {showHandleLine ? (
                  <Text
                    className="text-muted-foreground text-[15px] leading-5"
                    style={{ flexShrink: 10, minWidth: 0 }}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                  >
                    {` @${resolvedPrimary.handle}`}
                  </Text>
                ) : null}
                {isSingleActor && resolvedPrimary.isFederated ? (
                  <RemoteActorBadge size={13} className="text-muted-foreground" containerClassName="self-center ml-1" />
                ) : null}
              </View>
              {timeLabel ? (
                <Text className="text-muted-foreground text-[15px] leading-5 shrink-0 web:whitespace-nowrap">
                  {'·'} {timeLabel}
                </Text>
              ) : null}
            </View>

            {actionText ? (
              <Text className="text-muted-foreground text-[15px] leading-5" numberOfLines={2}>
                {actionText}
              </Text>
            ) : null}

            {previewText ? <NotificationPreview text={previewText} /> : null}

            {isGroup && item.expandable ? (
              <View className="mt-1 gap-2">
                {expanded ? (
                  <View className="gap-2">
                    {resolvedActors.map((actor) => (
                      <Pressable
                        key={actor.id}
                        onPress={() => openActorProfile(actor)}
                        className="flex-row items-center gap-2"
                        accessibilityRole="button"
                      >
                        <Avatar source={actor.avatar} size={STACK_AVATAR_SIZE} variant={MEDIA_VARIANT_AVATAR} />
                        <UserName name={actorLabel(actor, someone)} variant="small" />
                      </Pressable>
                    ))}
                  </View>
                ) : null}
                <Pressable onPress={toggleExpanded} hitSlop={8} accessibilityRole="button">
                  <Text className="text-primary text-sm font-semibold">
                    {expanded
                      ? t('notification.group.showLess', { defaultValue: 'Show less' })
                      : t('notification.group.showAll', { defaultValue: 'Show all' })}
                  </Text>
                </Pressable>
              </View>
            ) : null}

            {/* Accept/Decline are shown ONLY while the invite is genuinely pending.
                Once the viewer has responded, the row shows a resolved label
                instead — so a handled invite is never actionable again. */}
            {isCollabInvite && collabInvitePending ? (
              <View className="flex-row gap-2 mt-2">
                <Button className="flex-1" onPress={openAcceptSheet} disabled={actionLoading}>
                  {t('collab.accept', { defaultValue: 'Accept' })}
                </Button>
                <Button variant="secondary" className="flex-1" onPress={runDecline} disabled={actionLoading}>
                  {t('collab.decline', { defaultValue: 'Decline' })}
                </Button>
              </View>
            ) : null}

            {isCollabInvite && collabAccepted ? (
              <View className="flex-row items-center gap-1.5 mt-1">
                <Ionicons name="checkmark-circle" size={16} color={theme.colors.success} />
                <Text className="text-muted-foreground text-[15px] leading-5">
                  {t('collab.youAccepted', { defaultValue: 'You accepted' })}
                </Text>
              </View>
            ) : null}

            {isCollabInvite && collabDeclined ? (
              <View className="flex-row items-center gap-1.5 mt-1">
                <Ionicons name="close-circle" size={16} color={theme.colors.textSecondary} />
                <Text className="text-muted-foreground text-[15px] leading-5">
                  {t('collab.youDeclined', { defaultValue: 'You declined' })}
                </Text>
              </View>
            ) : null}
          </View>

          {/* Trailing media chip — a compact square still of the post's first
              image, mirroring the feed's thumb variant. Decorative: the row's
              own accessibilityLabel already describes the notification. */}
          {thumbnailUrl ? (
            <Image
              source={{ uri: thumbnailUrl }}
              className="bg-secondary self-center ml-3 rounded-lg"
              style={{ width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE }}
              contentFit="cover"
              transition={150}
              cachePolicy="memory-disk"
              accessibilityElementsHidden
              importantForAccessibility="no"
            />
          ) : null}

          {hasUnread ? <View className="w-2 h-2 rounded-full bg-primary self-center ml-2" /> : null}
        </View>
      </View>
    </Pressable>
  );
};

// Memoized: a realtime patch to one notification (or a parent re-render) must not
// re-render every row — the parent passes a stable `item` and a memoized
// `onMarkAsRead`.
export const NotificationItem = React.memo(NotificationItemComponent);

export default NotificationItem;
