import { useCallback, useLayoutEffect, useRef } from 'react';
import { useAuth, useAuthStore } from '@oxy.so/services/ui/client';

/**
 * Fence UI continuations after a screen or projected session changes.
 * This is not bearer-to-viewer proof and must never authorize a request.
 */
export function usePublicationContinuation() {
  const { user, oxyServices } = useAuth();
  const viewerId = user?.id ?? null;
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const capture = useCallback(() => {
    if (!mounted.current || !viewerId || useAuthStore.getState().user?.id !== viewerId) return null;
    const epoch = oxyServices.http.getSessionEpoch();
    return () =>
      mounted.current &&
      useAuthStore.getState().user?.id === viewerId &&
      oxyServices.http.getSessionEpoch() === epoch;
  }, [oxyServices, viewerId]);

  const isMounted = useCallback(() => mounted.current, []);
  return { capture, isMounted };
}
