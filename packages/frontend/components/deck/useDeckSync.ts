// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useEffect, useLayoutEffect } from 'react';
import { onlineManager } from '@tanstack/react-query';
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
    // React Query's online state is the app's one network signal: the browser's
    // `online` event on web, NetInfo on native (`app/_layout.tsx`).
    const unsubscribe = onlineManager.subscribe((online) => {
      if (online) sync.retry();
    });
    return () => {
      sync.stop();
      unsubscribe();
    };
  }, [viewer, user?.id, isAuthResolved, canUsePrivateApi]);
}
