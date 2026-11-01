import { useCallback, useLayoutEffect, useRef } from 'react';
import { useAuth, useOxy } from '@oxy.so/services/ui/client';

/** Capture one operation's session and mounted screen, not the lifetime of a viewer. */
export function useViewerOperationGuard(): {
  captureOwner: () => (() => boolean) | null;
  isMounted: () => boolean;
} {
  const { oxyServices, user, canUsePrivateApi } = useAuth();
  const { sessionClient, sessionMode } = useOxy();
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const viewerId = user?.id ?? null;
  const isMounted = useCallback(() => mounted.current, []);
  const captureOwner = useCallback(() => {
    const matchesAvailableIdentity = () => {
      if (!oxyServices.session.isAuthenticated || !viewerId) return false;
      const bearerId = oxyServices.session.userId;
      if (bearerId && bearerId !== viewerId) return false;
      const device = sessionMode === 'account' ? sessionClient?.getState() : null;
      return !device || device.activeAccountId === viewerId;
    };
    if (!mounted.current || !canUsePrivateApi || !matchesAvailableIdentity()) return null;
    const epoch = oxyServices.http.getSessionEpoch();
    return () =>
      mounted.current && oxyServices.http.getSessionEpoch() === epoch && matchesAvailableIdentity();
  }, [oxyServices, canUsePrivateApi, viewerId, sessionClient, sessionMode]);
  return { captureOwner, isMounted };
}
