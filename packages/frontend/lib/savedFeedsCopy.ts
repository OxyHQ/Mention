/**
 * The signed-in account's saved feed layout, kept across restarts so a returning
 * viewer's first paint shows their home tabs instead of shifting the feed down.
 *
 * It lives in the account's `@oxy.so/bloom-data` store, which Services opens per
 * account and deletes on sign-out: another account never reads it. The record
 * also names its viewer, and is only handed back to that viewer.
 */

import { currentStore, model, useModel, withStore } from '@oxy.so/bloom-data';
import type { FeedPreferences } from '@mention/shared-types/mtn/presetFeeds';

/** How long a kept layout may stand in for the server's. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface SavedFeedsCopy {
  viewerId: string;
  /** When the server answered with it. */
  readAt: number;
  preferences: FeedPreferences;
}

/** Bump `version` when `FeedPreferences` changes shape: kept copies are then dropped. */
export const SavedFeeds = model<SavedFeedsCopy>('mention.saved-feeds', {
  persist: { version: 1 },
});

/** Read the signed-in account's copy from disk, ahead of the screen that shows it. */
export function loadSavedFeedsCopy(): Promise<void> {
  return SavedFeeds.load();
}

/**
 * A writer into the copy of the account that is signed in now: take it before the
 * request. Services closes that account's store when the account is left, so a
 * late answer is dropped.
 */
export function savedFeedsWriter(viewerId: string): (preferences: FeedPreferences) => void {
  const store = currentStore();
  return (preferences) => {
    if (store.closed) return;
    withStore(store, () => SavedFeeds.set({ viewerId, readAt: Date.now(), preferences }));
  };
}

/** Whether a kept copy is recent enough to show. Asked outside a render. */
export function isRecentCopy(copy: SavedFeedsCopy): boolean {
  return Date.now() - copy.readAt <= MAX_AGE_MS;
}

/** The copy the signed-in account's store holds, only if it is `viewerId`'s. */
export function useSavedFeedsCopy(viewerId: string | undefined): SavedFeedsCopy | undefined {
  const copy = useModel(SavedFeeds);
  return copy && copy.viewerId === viewerId ? copy : undefined;
}
