import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { getLiveUsers } from '@/lib/syraApi';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { setLivePresence, useHasLivePresenceDemand } from '@/stores/livePresenceStore';

/**
 * The app's single poll of who is live in a Syra room. Mounted ONCE, at the app
 * root inside `AccountSwitchReset`, it owns the only QueryObserver on the
 * viewer-scoped `['live-users']` query and copies each result into the keyed
 * `livePresenceStore`, which every avatar reads through `useLiveUser(userId)`.
 *
 * The query runs only while something is reading presence (an avatar or a
 * profile header is mounted), exactly as when each avatar held its own
 * observer. Fails soft: an error keeps the last good list (or none), so live
 * presence never breaks a feed or profile. `liveConfig.onRoomChanged`
 * invalidates the same query family for an instant refresh.
 */
export function LivePresencePoller(): null {
  const { user } = useAuth();
  const hasDemand = useHasLivePresenceDemand();
  const { data } = useQuery({
    queryKey: viewerQueryKeys.liveUsers(user?.id),
    queryFn: getLiveUsers,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
    enabled: hasDemand,
  });

  useEffect(() => {
    setLivePresence(data);
  }, [data]);

  return null;
}
