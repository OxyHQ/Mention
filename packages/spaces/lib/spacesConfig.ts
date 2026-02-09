import type { SpacesConfig } from '@mention/spaces-shared';
import { authenticatedClient } from '@/utils/api';
import { API_URL_SOCKET } from '@/config';
import { useTheme } from '@/hooks/useTheme';
import { useIsScreenNotMobile } from '@/hooks/useMediaQuery';
import { useUserById, useUsersStore } from '@/stores/usersStore';
import { getCachedFileDownloadUrl, getCachedFileDownloadUrlSync } from '@/utils/imageUrlCache';
import Avatar from '@/components/Avatar';
import { toast } from 'sonner-native';

export const spacesConfig: SpacesConfig = {
  httpClient: authenticatedClient,
  socketUrl: API_URL_SOCKET,
  useTheme,
  useIsDesktop: useIsScreenNotMobile,
  useUserById,
  ensureUserById: useUsersStore.getState().ensureById,
  getCachedFileDownloadUrl,
  getCachedFileDownloadUrlSync,
  AvatarComponent: Avatar as SpacesConfig['AvatarComponent'],
  toast: Object.assign(
    (message: string) => toast(message),
    {
      success: (message: string) => toast.success(message),
      error: (message: string) => toast.error(message),
    }
  ),
  introSound: undefined,
};
