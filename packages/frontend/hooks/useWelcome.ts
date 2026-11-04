/**
 * The first-run `/welcome` flow's one piece of state: whether this account has
 * finished (or skipped) it. The server owns the answer
 * (`user_settings.welcome_completed_at`), so a person who finishes it on one
 * device is not sent there again on another. It is a field of the viewer's
 * settings document, read through the one shared settings query.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import {
  updateCachedViewerSettings,
  viewerSettingsQuery,
  type UserSettingsResponse,
} from '@/lib/viewerSettings';
import { authenticatedClient } from '@/utils/api';

const selectNeedsWelcome = (settings: UserSettingsResponse): boolean =>
  settings.welcomeCompletedAt === null;

/**
 * `needsWelcome` is true only once the server has ANSWERED that the flow is
 * unfinished (`welcomeCompletedAt: null`). Loading, signed out, a failed read and
 * a server that does not send the field at all (one that predates the flow) all
 * say false: a person is never sent to `/welcome` on a guess.
 */
export function useWelcomeStatus(): { needsWelcome: boolean } {
  const { user, canUsePrivateApi } = useAuth();
  const viewerId = user?.id;
  const query = useQuery({
    ...viewerSettingsQuery(viewerId),
    enabled: canUsePrivateApi && Boolean(viewerId),
    select: selectNeedsWelcome,
  });
  return { needsWelcome: query.isSuccess && query.data };
}

/** Record that the viewer finished or skipped `/welcome`. Idempotent server-side. */
export function useCompleteWelcome() {
  const { user } = useAuth();
  const viewerId = user?.id;
  const client = useQueryClient();
  // A failed write must not trap the person in the flow either: this session
  // treats it as done, and the server asks again next time it is read.
  const markDone = (completedAt?: string | null) =>
    updateCachedViewerSettings(client, viewerId, (current) => ({
      ...current,
      welcomeCompletedAt: completedAt ?? current.welcomeCompletedAt ?? new Date().toISOString(),
    }));
  return useMutation({
    mutationFn: async () =>
      (
        await authenticatedClient.post<{ welcomeCompletedAt?: string | null }>(
          '/profile/settings/welcome',
        )
      ).data,
    onSuccess: (data) => markDone(data?.welcomeCompletedAt),
    onError: () => markDone(),
  });
}
