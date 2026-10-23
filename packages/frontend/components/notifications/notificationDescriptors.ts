import type { ComponentProps } from 'react';
import type Ionicons from '@/components/common/Ionicons';
import type { Theme } from '@oxy.so/bloom/theme';

import type { BloomIconComponent } from '@oxy.so/bloom';
import { RiChat3Line } from '@oxy.so/bloom/icons/RiChat3Line';
import { RiGroupFill } from '@oxy.so/bloom/icons/RiGroupFill';
import { RiHeart3Fill } from '@oxy.so/bloom/icons/RiHeart3Fill';
import { RiRepeat2Line } from '@oxy.so/bloom/icons/RiRepeat2Line';
import { RiUserAddFill } from '@oxy.so/bloom/icons/RiUserAddFill';

export type IoniconName = ComponentProps<typeof Ionicons>['name'];

/** A Bloom theme color token — resolved at render time as `theme.colors[token]`. */
export type ColorToken = keyof Theme['colors'];

/** The i18next `t` signature used to build localized notification strings. */
export type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/**
 * Single source of truth for how each notification `type` renders: its action
 * badge icon, its semantic color token (NEVER a hardcoded hex — resolved through
 * the active Bloom preset/mode), whether it carries a text preview, and the
 * localized action phrase.
 *
 * The row is laid out like a feed post byline: the actor's bold name + `@handle`
 * (or the grouped-actor string) is the first line, and {@link actionPhrase} is
 * the muted second line — so the phrase is NAME-LESS ("liked your post"), never
 * repeating the actor already shown in the byline.
 */
export interface NotificationDescriptor {
  /**
   * Ionicon shown inside the small action badge overlaid on the avatar. When
   * {@link iconComponent} is set it takes precedence, but a sensible Ionicon is
   * kept here as the semantic fallback.
   */
  icon: IoniconName;
  /**
   * Optional Bloom glyph. When present it renders instead of the {@link icon}
   * Ionicon, at the same badge size and colour.
   */
  iconComponent?: BloomIconComponent;
  /** Semantic color token for the action badge fill. */
  colorToken: ColorToken;
  /** Whether this type has an associated post whose text is previewed inline. */
  hasPreview: boolean;
  /**
   * Localized, NAME-LESS action phrase rendered as the muted second byline line
   * (e.g. "liked your post", "started following you"). Shared by single and
   * grouped rows — the actor(s) are the bold name above it.
   */
  actionPhrase: (t: TranslateFn) => string;
}

/**
 * Fallback descriptor for unknown/unhandled types. Neutral bell icon, brand
 * color, no preview. Mirrors the previous `default` switch arm.
 */
const DEFAULT_DESCRIPTOR: NotificationDescriptor = {
  icon: 'notifications',
  colorToken: 'primary',
  hasPreview: false,
  actionPhrase: (t) =>
    t('notification.action.default', { defaultValue: 'interacted with your content' }),
};

/**
 * Per-type descriptor map. Colors map the old hardcoded hexes to semantic Bloom
 * tokens: like/boost -> success, reply/poke -> warning, and everything else
 * (mention/follow/quote/post/collab/welcome) -> primary.
 */
const DESCRIPTORS: Record<string, NotificationDescriptor> = {
  event_updated: {
    icon: 'calendar',
    colorToken: 'primary',
    hasPreview: true,
    actionPhrase: (t) =>
      t('events.noticeUpdated', { defaultValue: 'updated an event you are attending' }),
  },
  event_cancelled: {
    icon: 'calendar',
    colorToken: 'warning',
    hasPreview: true,
    actionPhrase: (t) =>
      t('events.noticeCancelled', { defaultValue: 'cancelled an event you are attending' }),
  },
  like: {
    icon: 'heart',
    iconComponent: RiHeart3Fill,
    colorToken: 'success',
    hasPreview: true,
    actionPhrase: (t) => t('notification.action.like', { defaultValue: 'liked your post' }),
  },
  boost: {
    icon: 'repeat',
    iconComponent: RiRepeat2Line,
    colorToken: 'success',
    hasPreview: true,
    actionPhrase: (t) => t('notification.action.boost', { defaultValue: 'boosted your post' }),
  },
  reply: {
    icon: 'chatbubble',
    iconComponent: RiChat3Line,
    colorToken: 'warning',
    hasPreview: true,
    actionPhrase: (t) => t('notification.action.reply', { defaultValue: 'replied to your post' }),
  },
  mention: {
    icon: 'chatbubble-ellipses',
    colorToken: 'primary',
    hasPreview: true,
    actionPhrase: (t) => t('notification.action.mention', { defaultValue: 'mentioned you' }),
  },
  quote: {
    icon: 'chatbox-ellipses',
    colorToken: 'primary',
    hasPreview: true,
    actionPhrase: (t) => t('notification.action.quote', { defaultValue: 'quoted your post' }),
  },
  follow: {
    icon: 'person-add',
    iconComponent: RiUserAddFill,
    colorToken: 'primary',
    hasPreview: false,
    actionPhrase: (t) => t('notification.action.follow', { defaultValue: 'started following you' }),
  },
  post: {
    icon: 'create',
    colorToken: 'primary',
    hasPreview: true,
    actionPhrase: (t) => t('notification.action.post', { defaultValue: 'posted a new update' }),
  },
  poke: {
    icon: 'hand-left',
    colorToken: 'warning',
    hasPreview: false,
    actionPhrase: (t) => t('notification.action.poke', { defaultValue: 'poked you' }),
  },
  collab_invite: {
    icon: 'people',
    iconComponent: RiGroupFill,
    colorToken: 'primary',
    hasPreview: true,
    actionPhrase: (t) =>
      t('collab.actionInvite', { defaultValue: 'invited you to collaborate on a post' }),
  },
  collab_accepted: {
    icon: 'people',
    colorToken: 'primary',
    hasPreview: false,
    actionPhrase: (t) =>
      t('collab.actionAccepted', { defaultValue: 'accepted your collaboration invite' }),
  },
  collab_declined: {
    icon: 'people',
    colorToken: 'primary',
    hasPreview: false,
    actionPhrase: (t) =>
      t('collab.actionDeclined', { defaultValue: 'declined your collaboration invite' }),
  },
  welcome: {
    icon: 'notifications',
    colorToken: 'primary',
    hasPreview: false,
    // Welcome has no actor: the byline shows the welcome title and this phrase
    // is the welcome body (see NotificationItem's `isWelcome` branch).
    actionPhrase: (t) => t('notification.welcome.body'),
  },
};

/**
 * Resolves the descriptor for a notification type, falling back to a neutral
 * default for unknown types (no unchecked index access, no `as any`).
 */
export function getDescriptor(type: string): NotificationDescriptor {
  return DESCRIPTORS[type] ?? DEFAULT_DESCRIPTOR;
}
