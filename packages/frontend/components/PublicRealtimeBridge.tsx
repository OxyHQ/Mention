/**
 * Keeps the PUBLIC realtime socket connected for every visitor.
 *
 * Deliberately ungated: no `useAuth`, no session check, no dependency that can
 * change. `RealtimePostsBridge` is the authenticated counterpart and is torn
 * down on every sign-in/sign-out; this one must not be, because the surfaces it
 * feeds (the trends widget, `/explore/trending`) are the ones a signed-out
 * reader sees.
 */

import { useEffect } from 'react';
import { publicRealtimeService } from '@/services/publicRealtimeService';

export function PublicRealtimeBridge() {
  useEffect(() => {
    publicRealtimeService.connect();
    return () => publicRealtimeService.disconnect();
  }, []);
  return null;
}
