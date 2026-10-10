import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth, useOxy } from '@oxy.so/services/ui/client';
import { colorViewerForUser } from '@/lib/colorEntitlement';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

/** Private, non-persisted capability read. Account/session changes never reuse permission. */
export function useMentionColorViewer() {
  const { user, oxyServices, canUsePrivateApi } = useAuth();
  const { activeSessionId } = useOxy();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [user?.id, activeSessionId]);
  const query = useQuery({
    queryKey: viewerQueryKeys.mentionPersonalization(user?.id, activeSessionId, canUsePrivateApi),
    enabled: canUsePrivateApi && !!user?.id && !!activeSessionId,
    queryFn: async () => {
      const subject = user!.id;
      const result = await oxyServices.users.me({ cache: false });
      if (result.id !== subject) throw new Error('Personalization subject changed');
      return result;
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: 15000,
    refetchOnWindowFocus: 'always',
  });
  // Missing or failed authority never retains a premium selection.
  return colorViewerForUser(
    query.isError || !canUsePrivateApi
      ? { username: canUsePrivateApi ? user?.username : undefined }
      : query.data?.id === user?.id
        ? query.data
        : { username: user?.username },
    now,
  );
}
