import type { SpacesConfig } from '@mention/spaces-shared';
import { authenticatedClient } from '@/utils/api';
import { API_URL_SOCKET } from '@/config';
import { useTheme } from '@/hooks/useTheme';
import { useUserById, useUsersStore } from '@/stores/usersStore';
import { getCachedFileDownloadUrl, getCachedFileDownloadUrlSync } from '@/utils/imageUrlCache';
import Avatar from '@/components/Avatar';
import { toast } from 'sonner';

export const spacesConfig: SpacesConfig = {
  httpClient: authenticatedClient,
  socketUrl: API_URL_SOCKET,
  useTheme,
  useUserById,
  ensureUserById: useUsersStore.getState().ensureById,
  getCachedFileDownloadUrl,
  getCachedFileDownloadUrlSync,
  AvatarComponent: Avatar,
  toast: Object.assign(
    (message: string, options?: any) => toast(message, options),
    {
      success: (message: string) => toast.success(message),
      error: (message: string) => toast.error(message),
    }
  ),
  introSound: require('@/assets/sounds/intro.mp3'),
  isDesktop: false, // Will be overridden at runtime if needed
};
