import { useMemo } from 'react';
import { useAuth } from '@oxyhq/services';
import { getCachedFileDownloadUrlSync } from '@/utils/imageUrlCache';

export function useAvatarUrl(avatar: string | undefined | null): string | undefined {
  const { oxyServices } = useAuth();
  return useMemo(() => {
    if (!avatar) return undefined;
    if (typeof avatar === 'string' && avatar.startsWith('http')) return avatar;
    if (!oxyServices) return undefined;
    try {
      return getCachedFileDownloadUrlSync(oxyServices, String(avatar), 'thumb');
    } catch {
      return undefined;
    }
  }, [avatar, oxyServices]);
}
