/**
 * MTN Preset Feed Catalog + server-side feed-preference types.
 *
 * `PRESET_FEEDS` is the static, shared metadata for every built-in feed the
 * feeds screen offers (label / description / icon / default-pinned / auth). It is
 * the single source of truth both the frontend feeds screen and the backend
 * `/feed/preferences` default-seed read, so a preset never drifts between them.
 *
 * `SavedFeed` / `FeedPreferences` describe a viewer's persisted feed layout
 * (which feeds are saved, pinned, and in what order) stored server-side.
 */

import type { FeedDescriptor } from './feedDescriptor';

/**
 * Static metadata for a built-in feed. `labelKey` / `descriptionKey` are i18n
 * keys resolved by the frontend; `icon` is a Lucide icon name. `defaultPinned`
 * seeds the initial pinned tab bar; `requiresAuth` marks viewer-relative feeds
 * that are hidden / disabled for anonymous viewers.
 */
export interface PresetFeed {
  id: string;
  labelKey: string;
  descriptionKey: string;
  descriptor: FeedDescriptor;
  icon: string;
  defaultPinned: boolean;
  requiresAuth: boolean;
  /** Optional dedicated screen route (feeds that are not just a home tab). */
  route?: string;
}

/**
 * A single entry in a viewer's persisted feed layout. `key` is a stable id for
 * the saved feed (the preset id, or `custom:<id>`); `descriptor` is what the
 * feed endpoint runs; `pinned` controls tab-bar presence; `order` is the display
 * order within its group (pinned bar and saved list).
 */
export interface SavedFeed {
  key: string;
  descriptor: FeedDescriptor;
  pinned: boolean;
  order: number;
}

/** A viewer's full persisted feed layout. */
export interface FeedPreferences {
  savedFeeds: SavedFeed[];
}

/**
 * The built-in preset feeds offered in the feeds screen. Ordering here is the
 * default display order; For You + Following are pinned into the tab bar by
 * default (every other preset starts saved-but-unpinned).
 */
export const PRESET_FEEDS: PresetFeed[] = [
  {
    id: 'for_you',
    labelKey: 'feeds.presets.for_you.label',
    descriptionKey: 'feeds.presets.for_you.description',
    descriptor: 'for_you',
    icon: 'sparkles',
    defaultPinned: true,
    requiresAuth: false,
  },
  {
    id: 'following',
    labelKey: 'feeds.presets.following.label',
    descriptionKey: 'feeds.presets.following.description',
    descriptor: 'following',
    icon: 'users',
    defaultPinned: true,
    requiresAuth: true,
  },
  {
    id: 'trending',
    labelKey: 'feeds.presets.trending.label',
    descriptionKey: 'feeds.presets.trending.description',
    descriptor: 'trending',
    icon: 'flame',
    defaultPinned: false,
    requiresAuth: false,
  },
  {
    id: 'explore',
    labelKey: 'feeds.presets.explore.label',
    descriptionKey: 'feeds.presets.explore.description',
    descriptor: 'explore',
    icon: 'compass',
    defaultPinned: false,
    requiresAuth: false,
  },
  {
    id: 'mutuals',
    labelKey: 'feeds.presets.mutuals.label',
    descriptionKey: 'feeds.presets.mutuals.description',
    descriptor: 'mutuals',
    icon: 'user-check',
    defaultPinned: false,
    requiresAuth: true,
  },
  {
    id: 'friends_popular',
    labelKey: 'feeds.presets.friends_popular.label',
    descriptionKey: 'feeds.presets.friends_popular.description',
    descriptor: 'friends_popular',
    icon: 'heart-handshake',
    defaultPinned: false,
    requiresAuth: true,
  },
  {
    id: 'videos',
    labelKey: 'feeds.presets.videos.label',
    descriptionKey: 'feeds.presets.videos.description',
    descriptor: 'videos',
    icon: 'clapperboard',
    defaultPinned: false,
    requiresAuth: false,
    route: '/videos',
  },
];
