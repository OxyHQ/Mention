import type { ComponentProps } from 'react';
import { Ionicons } from '@expo/vector-icons';
import type { Theme } from '@oxyhq/bloom/theme';

export type IoniconName = ComponentProps<typeof Ionicons>['name'];

/** A Bloom theme color token — resolved at render time as `theme.colors[token]`. */
export type ColorToken = keyof Theme['colors'];

/** The i18next `t` signature used to build localized notification titles. */
export type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/**
 * Single source of truth for how each notification `type` renders: its action
 * badge icon, its semantic color token (NEVER a hardcoded hex — resolved through
 * the active Bloom preset/mode), whether it carries a text preview, and the
 * localized title builders. Replaces the three parallel `switch` functions that
 * used to live in `NotificationItem` and `GroupedNotificationItem`.
 */
export interface NotificationDescriptor {
  /** Ionicon shown inside the small action badge overlaid on the avatar. */
  icon: IoniconName;
  /** Semantic color token for the action badge fill. */
  colorToken: ColorToken;
  /** Whether this type has an associated post whose text is previewed inline. */
  hasPreview: boolean;
  /** Localized single-row title (e.g. "Ana liked your post"). */
  buildTitle: (t: TranslateFn, actorName: string) => string;
  /**
   * Localized grouped title (e.g. "Ana, Bob and 3 others liked your post").
   * Only groupable types (like/boost/follow/quote) provide this.
   */
  buildGroupTitle?: (t: TranslateFn, actorString: string) => string;
}

/**
 * Fallback descriptor for unknown/unhandled types. Neutral bell icon, brand
 * color, no preview. Mirrors the previous `default` switch arm.
 */
const DEFAULT_DESCRIPTOR: NotificationDescriptor = {
  icon: 'notifications',
  colorToken: 'primary',
  hasPreview: false,
  buildTitle: (t, actorName) =>
    t('notification.like', { actorName, defaultValue: '{{actorName}} interacted with your content' }),
};

/**
 * Per-type descriptor map. Colors map the old hardcoded hexes to semantic Bloom
 * tokens: like/boost -> success, reply/poke -> warning, and everything else
 * (mention/follow/quote/post/collab/welcome) -> primary.
 */
const DESCRIPTORS: Record<string, NotificationDescriptor> = {
  like: {
    icon: 'heart',
    colorToken: 'success',
    hasPreview: true,
    buildTitle: (t, actorName) => t('notification.like', { actorName }),
    buildGroupTitle: (t, actors) =>
      t('notification.group.liked', { actors, defaultValue: '{{actors}} liked your post' }),
  },
  boost: {
    icon: 'repeat',
    colorToken: 'success',
    hasPreview: true,
    buildTitle: (t, actorName) => t('notification.boost', { actorName }),
    buildGroupTitle: (t, actors) =>
      t('notification.group.boosted', { actors, defaultValue: '{{actors}} boosted your post' }),
  },
  reply: {
    icon: 'chatbubble',
    colorToken: 'warning',
    hasPreview: true,
    buildTitle: (t, actorName) => t('notification.reply', { actorName }),
  },
  mention: {
    icon: 'chatbubble-ellipses',
    colorToken: 'primary',
    hasPreview: true,
    buildTitle: (t, actorName) => t('notification.mention', { actorName }),
  },
  quote: {
    icon: 'chatbox-ellipses',
    colorToken: 'primary',
    hasPreview: true,
    buildTitle: (t, actorName) => t('notification.quote', { actorName }),
    buildGroupTitle: (t, actors) =>
      t('notification.group.quoted', { actors, defaultValue: '{{actors}} quoted your post' }),
  },
  follow: {
    icon: 'person-add',
    colorToken: 'primary',
    hasPreview: false,
    buildTitle: (t, actorName) => t('notification.follow', { actorName }),
    buildGroupTitle: (t, actors) =>
      t('notification.group.followed', { actors, defaultValue: '{{actors}} followed you' }),
  },
  post: {
    icon: 'create',
    colorToken: 'primary',
    hasPreview: true,
    buildTitle: (t, actorName) =>
      t('notification.post', { actorName, defaultValue: '{{actorName}} posted a new update' }),
  },
  poke: {
    icon: 'hand-left',
    colorToken: 'warning',
    hasPreview: false,
    buildTitle: (t, actorName) => t('notification.poke', { actorName }),
  },
  collab_invite: {
    icon: 'people',
    colorToken: 'primary',
    hasPreview: true,
    buildTitle: (t, actorName) =>
      t('collab.notificationInvite', { actorName, defaultValue: '{{actorName}} invited you to collaborate on a post' }),
  },
  collab_accepted: {
    icon: 'people',
    colorToken: 'primary',
    hasPreview: false,
    buildTitle: (t, actorName) =>
      t('collab.notificationAccepted', { actorName, defaultValue: '{{actorName}} accepted your collaboration invite' }),
  },
  collab_declined: {
    icon: 'people',
    colorToken: 'primary',
    hasPreview: false,
    buildTitle: (t, actorName) =>
      t('collab.notificationDeclined', { actorName, defaultValue: '{{actorName}} declined your collaboration invite' }),
  },
  welcome: {
    icon: 'notifications',
    colorToken: 'primary',
    hasPreview: false,
    buildTitle: (t) => t('notification.welcome.title'),
  },
};

/**
 * Resolves the descriptor for a notification type, falling back to a neutral
 * default for unknown types (no unchecked index access, no `as any`).
 */
export function getDescriptor(type: string): NotificationDescriptor {
  return DESCRIPTORS[type] ?? DEFAULT_DESCRIPTOR;
}
