import type { LiveConfig, LiveTheme, RoomsServiceInstance, UserEntity } from '@syra.fm/sdk';
import { createRoomsService } from '@syra.fm/sdk';
import type { ComponentType } from 'react';
import type { ViewStyle } from 'react-native';
import { queryKeys } from '@oxyhq/services';
import { oxyServices } from '@/lib/oxyServices';
import { SYRA_API_URL, SYRA_SOCKET_URL } from '@/config';
import { useTheme as useBloomTheme } from '@oxyhq/bloom/theme';
import { useUserById } from '@/hooks/useCachedUser';
import { queryClient } from '@/lib/queryClient';
import { getCachedFileDownloadUrl, getCachedFileDownloadUrlSync } from '@/utils/imageUrlCache';
import { Avatar } from '@oxyhq/bloom/avatar';
import { show } from '@oxyhq/bloom/toast';
import i18n from '@/lib/i18n';
import { useAppearanceStore } from '@/store/appearanceStore';

/**
 * Syra-pointed Oxy linked client for live rooms — the SAME `createLinkedClient`
 * Mention uses everywhere, just aimed at Syra's rooms backend (`SYRA_API_URL`)
 * instead of `api.mention.earth`. The Oxy bearer authenticates cross-app (same
 * identity). The `@syra.fm/sdk` engine consumes this client directly (its
 * methods resolve to the parsed body), so there is NO per-app adapter. GET
 * caching stays off (the linked client defaults to no-cache).
 */
const syraLinkedClient = oxyServices.createLinkedClient({ baseURL: SYRA_API_URL }).client;

/**
 * The one live-rooms service — the engine's `createRoomsService` bound to the
 * Syra client above. Exposed at module scope so non-React callers (Zustand
 * stores) and screens can reuse it without re-instantiating a client. React
 * components can equivalently read `useLiveConfig().roomsService`.
 */
export const roomsService: RoomsServiceInstance = createRoomsService(syraLinkedClient);

/**
 * A user currently live in a Syra room. `userId` is the Oxy user id (the same id
 * Mention post authors and profiles carry), `roomId` the live room to join.
 */
export interface LiveUserEntry {
  userId: string;
  roomId: string;
}

/**
 * The viewer's own live-visibility preference — governs WHEN their avatar shows
 * the live badge to others: `'active'` = whenever they are in a live room,
 * `'speaking'` = only while they hold the mic.
 */
export type LiveVisibility = 'active' | 'speaking';

/**
 * Live-presence reads/writes that live on Syra's rooms backend but are NOT part
 * of the engine's `roomsService`. They reuse the SAME Syra client the live config
 * is built on, so every call hits `api.syra.fm` (cross-app Oxy identity), never
 * `api.mention.earth`.
 */
export const getLiveUsers = async (): Promise<LiveUserEntry[]> => {
  const data = await syraLinkedClient.get<{ liveUsers: LiveUserEntry[] }>('/rooms/live-users');
  return data.liveUsers ?? [];
};

export const getLivePresencePreference = async (): Promise<LiveVisibility> => {
  const data = await syraLinkedClient.get<{ liveVisibility: LiveVisibility }>('/rooms/me/presence-preference');
  return data.liveVisibility;
};

export const updateLivePresencePreference = async (liveVisibility: LiveVisibility): Promise<LiveVisibility> => {
  const data = await syraLinkedClient.put<{ liveVisibility: LiveVisibility }>('/rooms/me/presence-preference', {
    liveVisibility,
  });
  return data.liveVisibility ?? liveVisibility;
};

const useLiveTheme = (): LiveTheme => {
  const theme = useBloomTheme();
  return {
    isDark: theme.isDark,
    colors: { ...theme.colors } as LiveTheme['colors'],
  };
};

interface LiveAvatarProps {
  size: number;
  source?: string;
  shape?: string;
  style?: ViewStyle;
}

const LiveAvatar: ComponentType<LiveAvatarProps> = ({ shape, ...rest }) => {
  const safeShape: 'circle' | 'squircle' | undefined =
    shape === 'squircle' ? 'squircle' : shape === 'circle' ? 'circle' : undefined;
  return <Avatar {...rest} shape={safeShape} />;
};

/**
 * Cache-first user fetch for live rooms — reads/writes the shared React Query
 * cache. Returns the cached user when fresh, otherwise runs the caller's loader
 * and primes the cache via `fetchQuery`.
 */
const ensureUserById: LiveConfig['ensureUserById'] = (id, loader) =>
  queryClient.fetchQuery<UserEntity | null | undefined>({
    queryKey: queryKeys.users.detail(id),
    queryFn: () => loader(id),
    staleTime: 5 * 60 * 1000,
  }).then((user) => user ?? undefined);

/**
 * Localize the shared live-room UI via Mention's i18n instance. `i18n.t` is
 * stable and resolves keys flat (see `lib/i18n.ts`); the live-room components
 * only ask for plain strings, so `String()` collapses i18next's wide return type.
 */
const translate: NonNullable<LiveConfig['t']> = (key, options) => String(i18n.t(key, options));

/**
 * Resolve the viewer's pinned Syra podcast from their profile media so the
 * podcast stream picker can offer a one-tap quick-start row. Reads the appearance
 * store (loading it once if cold); returns `null` when the viewer has no pinned
 * podcast (or has a pinned song instead).
 */
const getPinnedPodcast: NonNullable<LiveConfig['getPinnedPodcast']> = async () => {
  const store = useAppearanceStore.getState();
  let settings = store.mySettings;
  if (!settings) {
    await store.loadMySettings(true);
    settings = useAppearanceStore.getState().mySettings;
  }
  const media = settings?.profileMedia;
  if (!media || media.type !== 'podcast') return null;
  return { syraPodcastId: media.syraPodcastId, title: media.title, artworkUrl: media.artworkUrl };
};

export const liveConfig: LiveConfig = {
  // Live-presence just changed for the local user (they started/stopped a room
  // or stream). Invalidate the shared `['live-users']` query (see
  // hooks/useLiveUsers.ts) so every avatar's LIVE badge updates instantly
  // instead of waiting for the 60s background poll.
  onRoomChanged: () => {
    queryClient.invalidateQueries({ queryKey: ['live-users'] });
  },
  httpClient: syraLinkedClient,
  socketUrl: SYRA_SOCKET_URL,
  useTheme: useLiveTheme,
  t: translate,
  getPinnedPodcast,
  useUserById,
  ensureUserById,
  getCachedFileDownloadUrl,
  getCachedFileDownloadUrlSync,
  AvatarComponent: LiveAvatar,
  toast: Object.assign(
    (message: string) => show(message),
    {
      success: (message: string) => show(message, { type: 'success' }),
      error: (message: string) => show(message, { type: 'error' }),
    }
  ),
  isDesktop: false, // Will be overridden at runtime if needed
  // Mention's web shell uses a DOCUMENT-scroll model (global.css forces
  // html/body/#root to height:auto + overflow:visible, so the window is the
  // scroller). `web:fixed` pins the floating live-room dock + backdrop to the
  // VIEWPORT bottom; without it `position: absolute` resolves against the tall
  // document and the dock sinks to the page bottom (only visible after
  // scrolling all the way down). No-op on native. The literal lives here (a
  // Tailwind-scanned `lib/` file) so the `web:fixed` utility is generated.
  dockClassName: 'web:fixed',
};
