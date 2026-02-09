export { useSpaceUsers, getDisplayName } from '@mention/agora-shared';
export type { UserEntity } from '@mention/agora-shared';

import { getAvatarUrl as _getAvatarUrl } from '@mention/agora-shared';
import { getCachedFileDownloadUrlSync } from '@/utils/imageUrlCache';

/**
 * Backward-compatible wrapper — the shared version requires a third
 * `getCachedFileDownloadUrlSync` argument; this binds the frontend's
 * implementation so existing callers don't need to change.
 */
export function getAvatarUrl(
  userProfile: import('@mention/agora-shared').UserEntity | undefined,
  oxyServices: any,
): string | undefined {
  return _getAvatarUrl(userProfile, oxyServices, getCachedFileDownloadUrlSync);
}
