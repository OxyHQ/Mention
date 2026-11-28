// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
  /**
   * Whether the feed is ranked by engagement rather than shown in the order it
   * was posted. A `protected` feed profile (a minor's account, oxy ADR 0068) is
   * served no ranked feed, so these are not offered to it. The backend's
   * definitions are the authority; a test holds this flag equal to them.
   */
  ranked: boolean;
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
  /**
   * The title of every PINNED custom feed the viewer may still read, keyed by
   * feed id — what the tab bar labels them with. A pinned feed missing here was
   * deleted or made private by its owner. Sent by `GET /feed/preferences` only.
   */
  customFeedTitles?: Record<string, string>;
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
    ranked: true,
  },
  {
    id: 'following',
    labelKey: 'feeds.presets.following.label',
    descriptionKey: 'feeds.presets.following.description',
    descriptor: 'following',
    icon: 'users',
    defaultPinned: true,
    requiresAuth: true,
    ranked: false,
  },
  {
    id: 'trending',
    labelKey: 'feeds.presets.trending.label',
    descriptionKey: 'feeds.presets.trending.description',
    descriptor: 'trending',
    icon: 'flame',
    defaultPinned: false,
    requiresAuth: false,
    ranked: true,
  },
  {
    id: 'explore',
    labelKey: 'feeds.presets.explore.label',
    descriptionKey: 'feeds.presets.explore.description',
    descriptor: 'explore',
    icon: 'compass',
    defaultPinned: false,
    requiresAuth: false,
    ranked: true,
  },
  {
    id: 'mutuals',
    labelKey: 'feeds.presets.mutuals.label',
    descriptionKey: 'feeds.presets.mutuals.description',
    descriptor: 'mutuals',
    icon: 'user-check',
    defaultPinned: false,
    requiresAuth: true,
    ranked: false,
  },
  {
    id: 'friends_popular',
    labelKey: 'feeds.presets.friends_popular.label',
    descriptionKey: 'feeds.presets.friends_popular.description',
    descriptor: 'friends_popular',
    icon: 'heart-handshake',
    defaultPinned: false,
    requiresAuth: true,
    ranked: true,
  },
  {
    id: 'friends_of_friends',
    labelKey: 'feeds.presets.friends_of_friends.label',
    descriptionKey: 'feeds.presets.friends_of_friends.description',
    descriptor: 'friends_of_friends',
    icon: 'users',
    defaultPinned: false,
    requiresAuth: true,
    ranked: false,
  },
];

/**
 * The saved feeds a viewer is OFFERED: for a `protected` feed profile (a
 * minor's account, oxy ADR 0068), every ranked preset is left out, so the home
 * tabs open on Following. Everything else is returned unchanged, in the same
 * order.
 *
 * This is presentation. The server decides what is served from the same
 * profile, and refuses a ranked feed to a protected viewer whoever asks.
 */
export function savedFeedsOfferedTo(
  savedFeeds: readonly SavedFeed[],
  feedProfile: 'standard' | 'protected',
): SavedFeed[] {
  if (feedProfile !== 'protected') return [...savedFeeds];
  const rankedPresets = new Set(
    PRESET_FEEDS.filter((preset) => preset.ranked).map((preset) => preset.descriptor),
  );
  return savedFeeds.filter((feed) => !rankedPresets.has(feed.descriptor));
}
