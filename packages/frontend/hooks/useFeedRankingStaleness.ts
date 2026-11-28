// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useCallback, useSyncExternalStore } from 'react';
import type { FeedReadIdentity } from '@/stores/feedStaleness';
import {
  isFeedCacheStaleForRanking,
  subscribeToFeedRankingChanges,
} from '@/stores/feedRankingInvalidation';

/** Hide old social evidence immediately while an accepted rule change reloads its feed. */
export function useFeedRankingStaleness(
  { type, userId, viewerId }: FeedReadIdentity,
  readAt: number,
  enabled: boolean,
): boolean {
  const subscribe = useCallback(
    (listener: () => void) =>
      enabled
        ? subscribeToFeedRankingChanges({ type, userId, viewerId }, listener)
        : () => undefined,
    [type, userId, viewerId, enabled],
  );
  const getSnapshot = useCallback(
    () => enabled && isFeedCacheStaleForRanking({ type, userId, viewerId }, readAt),
    [type, userId, viewerId, readAt, enabled],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
