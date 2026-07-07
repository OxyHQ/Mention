/**
 * Cross-screen handoff for media shared into the app via the native OS share
 * sheet (`expo-share-intent`).
 *
 * The share-intent bridge (`lib/shareIntent.native.ts`) fires from the root
 * layout with a `router` push to `/compose`, but the shared FILES must be
 * uploaded first and then attached to the composer. Rather than serialize
 * already-uploaded file descriptors through URL query params (bloat + escaping),
 * the bridge uploads them, stashes the resulting ids here, and navigates. The
 * compose screen consumes them once on mount.
 *
 * Single-slot, consume-once: reading clears the buffer so a later plain
 * `/compose` open never re-attaches stale media.
 */

/** An already-uploaded media asset to attach to the composer on next open. */
export interface PendingShareMediaItem {
  /** Oxy file id. */
  id: string;
  /** MIME type (e.g. `image/png`, `video/mp4`) used to derive the composer media type. */
  contentType: string;
}

let pending: PendingShareMediaItem[] = [];

/** Stash uploaded share media to be attached on the next compose mount. */
export const setPendingShareMedia = (items: PendingShareMediaItem[]): void => {
  pending = items.slice();
};

/** Read and clear the pending share media (consume-once). */
export const consumePendingShareMedia = (): PendingShareMediaItem[] => {
  const items = pending;
  pending = [];
  return items;
};
