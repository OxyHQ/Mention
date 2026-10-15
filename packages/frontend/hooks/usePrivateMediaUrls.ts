import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';

/** Own compose/draft media uses the same canonical asset access as published posts. */
export function usePrivateMediaUrls(fileIds: readonly string[]): (fileId: string) => string {
  const { oxyServices, user, canUsePrivateApi } = useAuth();
  const ids = useMemo(
    () => [...new Set(fileIds.filter((id) => id && !/^https?:\/\//i.test(id)))].sort(),
    [fileIds],
  );
  const query = useQuery({
    queryKey: viewerQueryKeys.composeMedia(user?.id, canUsePrivateApi, ids),
    enabled: canUsePrivateApi && Boolean(user?.id) && ids.length > 0,
    queryFn: async () => {
      const urls: Record<string, string> = {};
      for (let index = 0; index < ids.length; index += 100)
        Object.assign(
          urls,
          await oxyServices.assets.urls(
            ids.slice(index, index + 100).map((fileId) => ({ fileId })),
            { context: 'mention-compose' },
          ),
        );
      return urls;
    },
    staleTime: 0,
    gcTime: 0,
  });
  return useCallback(
    (fileId: string) => {
      if (/^https?:\/\//i.test(fileId)) return fileId;
      return canUsePrivateApi && query.isSuccess ? (query.data[fileId] ?? '') : '';
    },
    [canUsePrivateApi, query.isSuccess, query.data],
  );
}
