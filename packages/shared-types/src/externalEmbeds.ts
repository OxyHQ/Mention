/**
 * External media embed preferences.
 *
 * Some posts link out to third-party media providers (YouTube, Spotify, GIPHY,
 * …). Rather than auto-loading those providers' players — which can phone home
 * to the provider before the user has chosen to play the embed — Mention lets
 * each viewer decide, per provider, whether the inline player is allowed.
 *
 * The preference is tri-state:
 *  - `'show'`  — always render the provider's inline player
 *  - `'hide'`  — never render it (only the link/card is shown)
 *  - absent (`undefined`) — ask on first play
 *
 * This module is the SINGLE source of truth for the provider keys, their human
 * labels, and the preference shape. It is consumed by both the backend
 * (UserSettings model + `PUT /profile/settings` whitelist) and the frontend.
 */

/**
 * Canonical, ordered list of supported external embed providers. The order is
 * the display order in the settings UI.
 */
export const EXTERNAL_EMBED_SOURCES = [
  'youtube',
  'youtubeShorts',
  'vimeo',
  'twitch',
  'giphy',
  'spotify',
  'appleMusic',
  'soundcloud',
  'flickr',
  'bandcamp',
] as const;

/** A single supported external embed provider key. */
export type EmbedPlayerSource = (typeof EXTERNAL_EMBED_SOURCES)[number];

/** Human-readable label for each provider, shown in the settings UI. */
export const externalEmbedLabels: Record<EmbedPlayerSource, string> = {
  youtube: 'YouTube',
  youtubeShorts: 'YouTube Shorts',
  vimeo: 'Vimeo',
  twitch: 'Twitch',
  giphy: 'GIPHY',
  spotify: 'Spotify',
  appleMusic: 'Apple Music',
  soundcloud: 'SoundCloud',
  flickr: 'Flickr',
  bandcamp: 'Bandcamp',
};

/**
 * The stored per-provider preference. Absence of the key means "ask on first
 * play"; only an explicit `'show'`/`'hide'` is ever persisted.
 */
export type ExternalEmbedPref = 'show' | 'hide';

/**
 * The persisted preferences map — a partial record so unset providers simply
 * have no key (which the player treats as "ask on first play").
 */
export type ExternalEmbedsSettings = Partial<Record<EmbedPlayerSource, ExternalEmbedPref>>;

/**
 * The concrete embed type a resolved external URL maps to. This is finer-grained
 * than {@link EmbedPlayerSource} because a single provider exposes several
 * playable shapes (e.g. a Spotify URL can be an album, a playlist, or a song).
 */
export type EmbedPlayerType =
  | 'youtube_video'
  | 'youtube_short'
  | 'twitch_video'
  | 'spotify_album'
  | 'spotify_playlist'
  | 'spotify_song'
  | 'soundcloud_track'
  | 'soundcloud_set'
  | 'apple_music_playlist'
  | 'apple_music_album'
  | 'apple_music_song'
  | 'vimeo_video'
  | 'giphy_gif'
  | 'flickr_album'
  | 'bandcamp_album'
  | 'bandcamp_track';
