export { useSpaceUsers, getDisplayName } from '@mention/spaces-shared';
export type { UserEntity } from '@mention/spaces-shared';

import { getAvatarUrl as _getAvatarUrl } from '@mention/spaces-shared';
import { getCachedFileDownloadUrlSync } from '@/utils/imageUrlCache';

/**
 * Backward-compatible wrapper — the shared version requires a third
 * `getCachedFileDownloadUrlSync` argument; this binds the frontend's
 * implementation so existing callers don't need to change.
 */
export function getAvatarUrl(
  userProfile: import('@mention/spaces-shared').UserEntity | undefined,
  oxyServices: any,
): string | undefined {
  return _getAvatarUrl(userProfile, oxyServices, getCachedFileDownloadUrlSync);
}
