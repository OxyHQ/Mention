import { useEffect, useLayoutEffect } from 'react';
import { useAuth } from '@oxy.so/services/ui/client';
import { authenticatedClient } from '@/utils/api';
import { useDeckSettings } from './deckSettings';
import { startDeckSync, type DeckResponse } from './deckSync';

/** Mount once in the app shell, so settings also sync when Deck is closed. */
export function useDeckSync() {
  const { user, canUsePrivateApi, isAuthResolved } = useAuth();
  const viewer = user?.id ? `user:${user.id}` : 'anonymous';
  useLayoutEffect(() => {
    if (isAuthResolved) useDeckSettings.getState().activate(viewer);
  }, [viewer, isAuthResolved]);
  useEffect(() => {
    if (!isAuthResolved || !canUsePrivateApi || !user?.id) return;
    const sync = startDeckSync(viewer, {
      load: async (signal) =>
        (await authenticatedClient.get<DeckResponse>('/deck', { signal })).data,
      save: async (baseRevision, state, signal) =>
        (await authenticatedClient.put<DeckResponse>('/deck', { baseRevision, state }, { signal }))
          .data,
    });
    const retry = () => sync.retry();
    if (typeof window !== 'undefined') window.addEventListener('online', retry);
    return () => {
      sync.stop();
      if (typeof window !== 'undefined') window.removeEventListener('online', retry);
    };
  }, [viewer, user?.id, isAuthResolved, canUsePrivateApi]);
}
