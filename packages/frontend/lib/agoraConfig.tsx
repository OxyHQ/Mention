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

export const agoraConfig: AgoraConfig = {
  httpClient: authenticatedClient,
  socketUrl: API_URL_SOCKET,
  useTheme: useAgoraTheme,
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
};
