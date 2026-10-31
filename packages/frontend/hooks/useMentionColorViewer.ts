import { useEffect, useMemo, useReducer } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth, useOxy } from '@oxy.so/services/ui/client';
import { colorViewerForUser } from '@/lib/colorEntitlement';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

/** Private, non-persisted capability read. Account/session changes never reuse permission. */
export function useMentionColorViewer() {
  const { user, oxyServices, canUsePrivateApi } = useAuth();
  const { activeSessionId } = useOxy();
  const [, refreshAtExpiry] = useReducer((version: number) => version + 1, 0);
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
  const subject =
    query.isError || !canUsePrivateApi
      ? { username: canUsePrivateApi ? user?.username : undefined }
      : query.data?.id === user?.id
        ? query.data
        : { username: user?.username };
  const grant =
    subject && 'personalization' in subject ? subject.personalization?.mentionMono : undefined;
  const expiresAt = grant?.allowed && grant.expiresAt ? Date.parse(grant.expiresAt) : NaN;

  useEffect(() => {
    if (!Number.isFinite(expiresAt)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        refreshAtExpiry();
        return;
      }
      // Timers have a signed 32-bit delay limit on web and native runtimes.
      timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
    };
    schedule();
    return () => clearTimeout(timer);
  }, [expiresAt]);

  const { username, mentionMono } = colorViewerForUser(subject);
  return useMemo(() => ({ username, mentionMono }), [username, mentionMono]);
}
