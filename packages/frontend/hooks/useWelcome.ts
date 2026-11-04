/**
 * The first-run `/welcome` flow's one piece of state: whether this account has
 * finished (or skipped) it. The server owns the answer
 * (`user_settings.welcome_completed_at`), so a person who finishes it on one
 * device is not sent there again on another.
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { queryClient } from '@/lib/queryClient';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import type { UserSettingsResponse } from '@/hooks/usePrivacySettings';
import { authenticatedClient } from '@/utils/api';

/**
 * `needsWelcome` is true only once the server has ANSWERED that the flow is
 * unfinished. Loading, signed out and a failed read all say false: a person is
 * never sent to `/welcome` on a guess.
 */
export function useWelcomeStatus(): { needsWelcome: boolean } {
  const { user, canUsePrivateApi } = useAuth();
  const viewerId = user?.id;
  const query = useQuery({
    queryKey: viewerQueryKeys.welcomeStatus(viewerId),
    queryFn: async () => {
      const response = await authenticatedClient.get<UserSettingsResponse>('/profile/settings/me');
      return response.data.welcomeCompletedAt ?? null;
    },
    enabled: canUsePrivateApi && Boolean(viewerId),
    // It changes once, through `useCompleteWelcome`, which writes the cache.
    staleTime: Number.POSITIVE_INFINITY,
  });
  return { needsWelcome: query.isSuccess && query.data === null };
}

/** Record that the viewer finished or skipped `/welcome`. Idempotent server-side. */
export function useCompleteWelcome() {
  const { user } = useAuth();
  const viewerId = user?.id;
  return useMutation({
    mutationFn: async () => {
      const response = await authenticatedClient.post<{ welcomeCompletedAt: string }>(
        '/profile/settings/welcome',
      );
      return response.data.welcomeCompletedAt;
    },
    onSuccess: (welcomeCompletedAt) => {
      queryClient.setQueryData(viewerQueryKeys.welcomeStatus(viewerId), welcomeCompletedAt);
    },
    // A failed write must not trap the person in the flow: this session treats
    // it as done, and the server asks again next time it is read.
    onError: () => {
      queryClient.setQueryData(viewerQueryKeys.welcomeStatus(viewerId), new Date().toISOString());
    },
  });
}
