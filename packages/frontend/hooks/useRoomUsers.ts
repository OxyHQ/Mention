export { useRoomUsers, getDisplayName } from '@syra.fm/sdk';
export type { UserEntity } from '@syra.fm/sdk';

import { getAvatarUrl as _getAvatarUrl } from '@syra.fm/sdk';
import { getCachedFileDownloadUrlSync } from '@/utils/imageUrlCache';

/**
 * Frontend wrapper — the shared version requires a third
 * `getCachedFileDownloadUrlSync` argument; this binds the frontend's
 * implementation so existing callers don't need to change.
 */
export function getAvatarUrl(
  userProfile: import('@syra.fm/sdk').UserEntity | undefined,
  oxyServices: unknown,
): string | undefined {
  return _getAvatarUrl(userProfile, oxyServices, getCachedFileDownloadUrlSync);
}
