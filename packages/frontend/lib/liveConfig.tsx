import type { LiveConfig, LiveTheme, UserEntity } from '@syra.fm/live';
import { createRoomsService } from '@syra.fm/live';
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
 * Syra-pointed HTTP client for live rooms. Mirrors Mention's global
 * `authenticatedClient` (`utils/api.ts`) — an Oxy linked client adapted into the
 * `{ data }` response shape the live-room engine expects — but targets Syra's
 * rooms backend (`SYRA_API_URL`) instead of `api.mention.earth`. The Oxy bearer
 * token authenticates cross-app (same Oxy identity). GET caching stays off (the
 * linked client defaults to no-cache); do NOT re-enable it here.
 */
const syraLinkedClient = oxyServices.createLinkedClient({ baseURL: SYRA_API_URL }).client;
type SyraRequestConfig = NonNullable<Parameters<typeof syraLinkedClient.get>[1]>;
type SyraDeleteConfig = NonNullable<Parameters<typeof syraLinkedClient.delete>[1]>;

const syraRoomsClient = {
  async get<T = unknown>(endpoint: string, config?: SyraRequestConfig): Promise<{ data: T }> {
    const data = await syraLinkedClient.get<T>(endpoint, config);
    return { data };
  },
  async post<T = unknown>(endpoint: string, body?: unknown, config?: SyraRequestConfig): Promise<{ data: T }> {
    const data = await syraLinkedClient.post<T>(endpoint, body, config);
    return { data };
  },
  async put<T = unknown>(endpoint: string, body?: unknown, config?: SyraRequestConfig): Promise<{ data: T }> {
    const data = await syraLinkedClient.put<T>(endpoint, body, config);
    return { data };
  },
  async delete<T = unknown>(endpoint: string, config?: SyraDeleteConfig): Promise<{ data: T }> {
    const data = await syraLinkedClient.delete<T>(endpoint, config);
    return { data };
  },
  async patch<T = unknown>(endpoint: string, body?: unknown, config?: SyraRequestConfig): Promise<{ data: T }> {
    const data = await syraLinkedClient.patch<T>(endpoint, body, config);
    return { data };
  },
};

/**
 * The one live-rooms service — the engine's `createRoomsService` bound to the
 * Syra client above. Exposed at module scope so non-React callers (Zustand
 * stores) and screens can reuse it without re-instantiating a client. React
 * components can equivalently read `useLiveConfig().roomsService`.
 */
export const roomsService = createRoomsService(syraRoomsClient);

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
  httpClient: syraRoomsClient,
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
