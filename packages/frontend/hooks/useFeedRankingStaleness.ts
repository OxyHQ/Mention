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
