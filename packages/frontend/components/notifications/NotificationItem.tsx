import React, { useCallback, useContext, useMemo, useState } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { PressableScale } from '@oxyhq/bloom/pressable-scale';
import { Avatar } from '@oxyhq/bloom/avatar';
import { Button } from '@oxyhq/bloom/button';
import { useTheme } from '@oxyhq/bloom/theme';
import { show as toast } from '@oxyhq/bloom/toast';
import type { PostUser } from '@mention/shared-types';

import { ThemedText } from '../ThemedText';
import UserName from '../UserName';
import { LinkifiedText } from '../common/LinkifiedText';
import CollabAcceptSheet from '@/components/Compose/CollabAcceptSheet';
import { getDescriptor, type TranslateFn } from './notificationDescriptors';
import type { GroupedNotification } from '@/utils/groupNotifications';
import { POST_ITEM_SPACING } from '@/styles/shared';
import { formatRelativeTimeLocalized } from '@/utils/dateUtils';
import { displayNameOrHandle } from '@/utils/displayName';
import { confirmDialog } from '@/utils/alerts';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { feedService } from '@/services/feedService';
import { queryKeys } from '@/hooks/useOptimizedQuery';
import { cn } from '@/lib/utils';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('NotificationItem');

type GroupedActor = GroupedNotification['actors'][number];

// Layout tokens copied (NOT imported) from the Post anatomy so notification rows
// share the feed's avatar-column + content-column rhythm.
const AVATAR_SIZE = POST_ITEM_SPACING.AVATAR_SIZE;
const AVATAR_GAP = POST_ITEM_SPACING.AVATAR_GAP;
const HPAD = POST_ITEM_SPACING.HPAD;
const VPAD = POST_ITEM_SPACING.VPAD;

const BADGE_SIZE = 20;
const BADGE_ICON_SIZE = 12;
// The action badge FILL is themed (`theme.colors[colorToken]`); this white glyph
// sits on top of that saturated fill for contrast across every preset/mode. A
// named constant, not a stray magic hex.
const BADGE_GLYPH_COLOR = '#ffffff';

const STACK_AVATAR_SIZE = 24;
const STACK_OVERLAP = -8;
// Actors shown in the collapsed avatar strip before collapsing into "+N".
const COLLAPSED_STRIP_LIMIT = 3;
// Matches a bare Oxy user id so it is never surfaced as a display name.
const OXY_ID_PATTERN = /^[a-f0-9]{24}$/i;

/**
 * Resolve an actor to a human label WITHOUT ever surfacing a raw Oxy id
 * (ghost-handle rule). `groupNotifications` falls back `name = actorId` when no
 * display name resolved, so treat an id-like or empty name as "no name" and drop
 * to `@handle`, then to a neutral "Someone".
 */
function resolveActorDisplay(actor: GroupedActor | undefined, t: TranslateFn): string {
  const someone = t('notification.someone', { defaultValue: 'Someone' });
  if (!actor) return someone;
  const rawName = actor.name?.trim();
  const isIdLike = !rawName || rawName === actor.id || OXY_ID_PATTERN.test(rawName);
  const handleFallback = actor.username ? `@${actor.username}` : someone;
  return displayNameOrHandle(isIdLike ? undefined : rawName, handleFallback);
}

/** Build the "Alice, Bob and 3 more" actor clause for grouped titles. */
function buildActorString(actors: GroupedActor[], totalActors: number, t: TranslateFn): string {
  const names = actors.map((a) => resolveActorDisplay(a, t));
  const someone = t('notification.someone', { defaultValue: 'Someone' });
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

/**
 * Lightweight text preview of the related post — the same `LinkifiedText`
 * primitive the feed uses, WITHOUT mounting a `PostItem` (no per-row engagement
 * hooks or SQLite reads). Renders nothing when there is no text.
 */
const NotificationPreview: React.FC<{ text: string }> = ({ text }) => (
  <LinkifiedText text={text} numberOfLines={2} className="text-muted-foreground" style={styles.preview} />
);

/** Collapsed stacked-avatar strip (up to 3 + "+N") for grouped rows. */
const AvatarStrip: React.FC<{ actors: GroupedActor[]; totalActors: number }> = ({ actors, totalActors }) => {
  const shown = actors.slice(0, COLLAPSED_STRIP_LIMIT);
  const extra = totalActors - shown.length;
  return (
    <View style={styles.stripRow}>
      {shown.map((actor, index) => (
        <View
          key={actor.id}
          style={[styles.stripItem, { marginLeft: index > 0 ? STACK_OVERLAP : 0, zIndex: shown.length - index }]}
        >
          <View className="border-background" style={styles.stripAvatarBorder}>
            <Avatar source={actor.avatar} size={STACK_AVATAR_SIZE} />
          </View>
        </View>
      ))}
      {extra > 0 ? (
        <View style={[styles.stripItem, { marginLeft: STACK_OVERLAP }]}>
          <View className="bg-primary border-background" style={styles.moreBadge}>
            <ThemedText className="text-primary-foreground" style={styles.moreText}>
              +{extra}
            </ThemedText>
          </View>
        </View>
      ) : null}
    </View>
  );
};

interface NotificationItemProps {
  item: GroupedNotification;
  /** Marks the given notification ids read (single -> `[id]`, group -> all ids). */
  onMarkAsRead: (ids: string[]) => void;
}

const NotificationItemComponent: React.FC<NotificationItemProps> = ({ item, onMarkAsRead }) => {
  const router = useRouter();
  const { t } = useTranslation();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const bottomSheet = useContext(BottomSheetContext);

  const descriptor = getDescriptor(item.type);
  const primaryActor = item.actors[0];
  const hasUnread = item.hasUnread;
  const isGroup = item.isGroup;
  const isCollabInvite = item.type === 'collab_invite';
  const postId = String(item.leadNotification.entityId ?? '');

  const [expanded, setExpanded] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // Collab invites carry no backend preview — fetch the invited post's text via
  // React Query (replaces the old useEffect + useState load).
  const { data: collabPost } = useQuery({
    queryKey: queryKeys.post(postId),
    queryFn: () => feedService.getPostById(postId),
    enabled: isCollabInvite && !!postId,
    staleTime: 60_000,
  });

  const badgeColor = theme.colors[descriptor.colorToken];
  const primaryDisplay = useMemo(() => resolveActorDisplay(primaryActor, t), [primaryActor, t]);
  const timeLabel = formatRelativeTimeLocalized(item.createdAt, t);

  const title = useMemo(() => {
    if (isGroup && descriptor.buildGroupTitle) {
      return descriptor.buildGroupTitle(t, buildActorString(item.actors, item.totalActors, t));
    }
    return descriptor.buildTitle(t, primaryDisplay);
  }, [isGroup, descriptor, item.actors, item.totalActors, primaryDisplay, t]);

  const previewText = useMemo(() => {
    if (!descriptor.hasPreview) return undefined;
    const backend = item.leadNotification.preview?.trim();
    if (backend) return backend;
    const source = isCollabInvite ? collabPost?.content : item.leadNotification.post?.content;
    return postContentText(source)?.trim() || undefined;
  }, [descriptor.hasPreview, item.leadNotification.preview, item.leadNotification.post, isCollabInvite, collabPost]);

  const markRead = useCallback(() => {
    if (hasUnread) onMarkAsRead(item.notificationIds);
  }, [hasUnread, onMarkAsRead, item.notificationIds]);

  const handlePress = useCallback(() => {
    markRead();
    if (item.entityType === 'post' || item.entityType === 'reply') {
      router.push(`/p/${item.entityId}`);
    } else if (item.entityType === 'profile' && primaryActor?.username) {
      router.push(`/@${primaryActor.username}`);
    }
  }, [markRead, item.entityType, item.entityId, primaryActor?.username, router]);

  const handleLongPress = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t('notification.options.title'),
      message: t('notification.options.message'),
      okText: t('notification.mark_read', { defaultValue: 'Mark as read' }),
      cancelText: t('cancel', { defaultValue: 'Cancel' }),
    });
    if (confirmed) onMarkAsRead(item.notificationIds);
  }, [t, onMarkAsRead, item.notificationIds]);

  const openActorProfile = useCallback((actor: GroupedActor) => {
    if (actor.username) router.push(`/@${actor.username}`);
  }, [router]);

  const inviter = useMemo<PostUser>(() => ({
    id: primaryActor?.id ?? '',
    username: primaryActor?.username,
    name: { displayName: primaryDisplay },
    avatar: primaryActor?.avatar ?? null,
  }), [primaryActor?.id, primaryActor?.username, primaryActor?.avatar, primaryDisplay]);

  const runAccept = useCallback(async () => {
    if (!postId) return;
    setActionLoading(true);
    try {
      const result = await feedService.acceptCollabInvite(postId);
      if (result.post) queryClient.setQueryData(queryKeys.post(postId), result.post);
      onMarkAsRead(item.notificationIds);
      bottomSheet.openBottomSheet(false);
      toast(t('collab.acceptedToast', { defaultValue: "You're now a collaborator on this post" }), { type: 'success' });
    } catch (error) {
      logger.error('Failed to accept collab invite', { error });
      toast(t('collab.acceptFailed', { defaultValue: 'Failed to accept invite' }), { type: 'error' });
    } finally {
      setActionLoading(false);
    }
  }, [postId, queryClient, onMarkAsRead, item.notificationIds, bottomSheet, t]);

  const runDecline = useCallback(async () => {
    if (!postId) return;
    setActionLoading(true);
    try {
      await feedService.declineCollabInvite(postId);
      onMarkAsRead(item.notificationIds);
      bottomSheet.openBottomSheet(false);
    } catch (error) {
      logger.error('Failed to decline collab invite', { error });
      toast(t('collab.declineFailed', { defaultValue: 'Failed to decline invite' }), { type: 'error' });
    } finally {
      setActionLoading(false);
    }
  }, [postId, onMarkAsRead, item.notificationIds, bottomSheet, t]);

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

  const showStrip = isGroup && item.actors.length > 1 && !expanded;

  return (
    <PressableScale
      className={cn('border-border', hasUnread && 'bg-primary/5')}
      style={styles.container}
      onPress={handlePress}
      onLongPress={handleLongPress}
    >
      <View style={styles.avatarColumn}>
        <Avatar source={primaryActor?.avatar} size={AVATAR_SIZE} />
        <View className="border-background" style={[styles.actionBadge, { backgroundColor: badgeColor }]}>
          <Ionicons name={descriptor.icon} size={BADGE_ICON_SIZE} color={BADGE_GLYPH_COLOR} />
        </View>
      </View>

      <View style={styles.content}>
        {showStrip ? <AvatarStrip actors={item.actors} totalActors={item.totalActors} /> : null}

        <ThemedText
          className={cn(hasUnread ? 'text-foreground' : 'text-muted-foreground')}
          style={[styles.title, hasUnread && styles.titleUnread]}
          numberOfLines={3}
        >
          {title}
          <ThemedText className="text-muted-foreground" style={styles.time}>
            {`  · ${timeLabel}`}
          </ThemedText>
        </ThemedText>

        {previewText ? <NotificationPreview text={previewText} /> : null}

        {isGroup && item.expandable ? (
          <View style={styles.expandBlock}>
            {expanded ? (
              <View style={styles.actorList}>
                {item.actors.map((actor) => (
                  <Pressable
                    key={actor.id}
                    onPress={() => openActorProfile(actor)}
                    style={styles.actorRow}
                    accessibilityRole="button"
                  >
                    <Avatar source={actor.avatar} size={STACK_AVATAR_SIZE} />
                    <UserName name={resolveActorDisplay(actor, t)} variant="small" style={{ name: styles.actorListName }} />
                  </Pressable>
                ))}
              </View>
            ) : null}
            <Pressable onPress={toggleExpanded} hitSlop={8} accessibilityRole="button">
              <ThemedText className="text-primary" style={styles.toggle}>
                {expanded
                  ? t('notification.group.showLess', { defaultValue: 'Show less' })
                  : t('notification.group.showAll', { defaultValue: 'Show all' })}
              </ThemedText>
            </Pressable>
          </View>
        ) : null}

        {isCollabInvite ? (
          <View style={styles.collabActions}>
            <Button className="flex-1" onPress={openAcceptSheet} disabled={actionLoading}>
              {t('collab.accept', { defaultValue: 'Accept' })}
            </Button>
            <Button variant="secondary" className="flex-1" onPress={runDecline} disabled={actionLoading}>
              {t('collab.decline', { defaultValue: 'Decline' })}
            </Button>
          </View>
        ) : null}
      </View>

      {hasUnread ? <View className="bg-primary" style={styles.unreadDot} /> : null}
    </PressableScale>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    paddingHorizontal: HPAD,
    paddingVertical: VPAD,
    borderBottomWidth: 1,
    backgroundColor: 'transparent',
  },
  avatarColumn: {
    position: 'relative',
    marginRight: AVATAR_GAP,
  },
  actionBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: BADGE_SIZE,
    height: BADGE_SIZE,
    borderRadius: BADGE_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  content: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 15,
    lineHeight: 20,
  },
  titleUnread: {
    fontWeight: '600',
  },
  time: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '400',
  },
  preview: {
    fontSize: 14,
    lineHeight: 19,
    marginTop: 2,
  },
  stripRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  stripItem: {},
  stripAvatarBorder: {
    borderWidth: 2,
    borderRadius: 14,
  },
  moreBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  moreText: {
    fontSize: 9,
    fontWeight: '700',
  },
  expandBlock: {
    marginTop: 4,
    gap: 8,
  },
  actorList: {
    gap: 8,
  },
  actorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  actorListName: {
    fontSize: 14,
  },
  toggle: {
    fontSize: 14,
    fontWeight: '600',
  },
  collabActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    alignSelf: 'center',
    marginLeft: 8,
  },
});

// Memoized: a realtime patch to one notification (or a parent re-render) must not
// re-render every row — the parent passes a stable `item` and a memoized
// `onMarkAsRead`.
export const NotificationItem = React.memo(NotificationItemComponent);

export default NotificationItem;
