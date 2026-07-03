import type { AgoraConfig, AgoraTheme, UserEntity } from '@mention/agora-shared';
import type { ComponentType } from 'react';
import type { ViewStyle } from 'react-native';
import { queryKeys } from '@oxyhq/services';
import { authenticatedClient } from '@/utils/api';
import { API_URL_SOCKET } from '@/config';
import { useTheme as useBloomTheme } from '@oxyhq/bloom/theme';
import { useUserById } from '@/hooks/useCachedUser';
import { queryClient } from '@/lib/queryClient';
import { getCachedFileDownloadUrl, getCachedFileDownloadUrlSync } from '@/utils/imageUrlCache';
import { Avatar } from '@oxyhq/bloom/avatar';
import { show } from '@oxyhq/bloom/toast';
import i18n from '@/lib/i18n';
import { useAppearanceStore } from '@/store/appearanceStore';

const useAgoraTheme = (): AgoraTheme => {
  const theme = useBloomTheme();
  return {
    isDark: theme.isDark,
    colors: { ...theme.colors } as AgoraTheme['colors'],
  };
};

interface AgoraAvatarProps {
  size: number;
  source?: string;
  shape?: string;
  style?: ViewStyle;
}

const AgoraAvatar: ComponentType<AgoraAvatarProps> = ({ shape, ...rest }) => {
  const safeShape: 'circle' | 'squircle' | undefined =
    shape === 'squircle' ? 'squircle' : shape === 'circle' ? 'circle' : undefined;
  return <Avatar {...rest} shape={safeShape} />;
};

/**
 * Cache-first user fetch for Agora — reads/writes the shared React Query cache.
 * Returns the cached user when fresh, otherwise runs the caller's loader and
 * primes the cache via `fetchQuery`.
 */
const ensureUserById: AgoraConfig['ensureUserById'] = (id, loader) =>
  queryClient.fetchQuery<UserEntity | null | undefined>({
    queryKey: queryKeys.users.detail(id),
    queryFn: () => loader(id),
    staleTime: 5 * 60 * 1000,
  }).then((user) => user ?? undefined);

/**
 * Localize the shared live-room UI via Mention's i18n instance. `i18n.t` is
 * stable and resolves keys flat (see `lib/i18n.ts`); the agora-shared components
 * only ask for plain strings, so `String()` collapses i18next's wide return type.
 */
const translate: NonNullable<AgoraConfig['t']> = (key, options) => String(i18n.t(key, options));

/**
 * Resolve the viewer's pinned Syra podcast from their profile media so the
 * podcast stream picker can offer a one-tap quick-start row. Reads the appearance
 * store (loading it once if cold); returns `null` when the viewer has no pinned
 * podcast (or has a pinned song instead).
 */
const getPinnedPodcast: NonNullable<AgoraConfig['getPinnedPodcast']> = async () => {
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

export const agoraConfig: AgoraConfig = {
  httpClient: authenticatedClient,
  socketUrl: API_URL_SOCKET,
  useTheme: useAgoraTheme,
  t: translate,
  getPinnedPodcast,
  useUserById,
  ensureUserById,
  getCachedFileDownloadUrl,
  getCachedFileDownloadUrlSync,
  AvatarComponent: AgoraAvatar,
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
