import type { AgoraConfig, AgoraTheme } from '@mention/agora-shared';
import type { ComponentType } from 'react';
import type { ViewStyle } from 'react-native';
import { authenticatedClient } from '@/utils/api';
import { API_URL_SOCKET } from '@/config';
import { useTheme as useBloomTheme } from '@oxyhq/bloom/theme';
import { useUserById, useUsersStore } from '@/stores/usersStore';
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

export const agoraConfig: AgoraConfig = {
  httpClient: authenticatedClient,
  socketUrl: API_URL_SOCKET,
  useTheme: useAgoraTheme,
  useUserById,
  ensureUserById: useUsersStore.getState().ensureById,
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
