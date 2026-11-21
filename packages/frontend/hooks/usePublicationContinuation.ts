import { useCallback, useLayoutEffect, useRef } from 'react';
import { useAuth } from '@oxy.so/services/ui/client';
import { useOxyRuntime } from '@oxy.so/services/runtime';

/**
 * Fence UI continuations after a screen or projected session changes.
 * A transient owner may outlive a presentation remount; it must still prove its
 * own lifetime. Viewer and session-epoch checks remain identical in both cases.
 * This is not bearer-to-viewer proof and must never authorize a request.
 */
export function usePublicationContinuation(ownerStillActive?: () => boolean) {
  const { user, oxyServices } = useAuth();
  const oxyRuntime = useOxyRuntime();
  const viewerId = user?.id ?? null;
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const capture = useCallback(() => {
    if (
      !mounted.current ||
      !viewerId ||
      oxyRuntime.getSnapshot().account?.id !== viewerId ||
      (ownerStillActive && !ownerStillActive())
    )
      return null;
    const epoch = oxyServices.http.getSessionEpoch();
    return () =>
      (ownerStillActive ? ownerStillActive() : mounted.current) &&
      oxyRuntime.getSnapshot().account?.id === viewerId &&
      oxyServices.http.getSessionEpoch() === epoch;
  }, [oxyServices, oxyRuntime, viewerId, ownerStillActive]);

  const isMounted = useCallback(() => mounted.current, []);
  return { capture, isMounted };
}
