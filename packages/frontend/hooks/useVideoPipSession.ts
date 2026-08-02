import { useCallback, useEffect, useState } from 'react';

/**
 * The Picture-in-Picture **session**: what the reel becomes once the OS lifts one
 * player out of the app's layout and into its own window.
 *
 * The window is bound to ONE player for as long as it is open, so the reel
 * cannot service a "next" the way it does on screen — mounting the next slide's
 * player would leave the OS showing the previous one, frozen. Instead the
 * surface that entered PiP stays the owner and the session moves its own
 * **cursor** through the loaded list; the screen swaps the SOURCE on that same
 * player (`player.replaceAsync`), and the playback authority keeps the owner
 * playing through `ownsSession` even though the pager never moved.
 *
 * **Pagination** stops working while the app is backgrounded, and the session
 * owns it because nothing else is running: the list pages by scrolling — the
 * document scroll listener on web, `onEndReached` on native — and nothing
 * scrolls in a background tab or a backgrounded app, so the session tops itself
 * up as its cursor approaches the end of the loaded set.
 *
 * What the session does NOT own is impressions. The viewability callbacks are
 * just as dead in a background tab, but the SCREEN reports for both of its
 * watched-video sources through one shared tracker (`useReelImpressions`),
 * reading `playing` from here. A tracker of its own would dedupe separately, so
 * entering PiP on the video already being watched would emit a SECOND impression
 * of it — carrying only the dwell since the window opened, which is short enough
 * to land as a skip.
 *
 * On exit the caller re-syncs the pager to the cursor, so coming back to the app
 * lands on the video that was actually being watched.
 */

/**
 * How close to the end of the loaded list the cursor may get before the session
 * fetches another page itself. Three videos of runway is enough for a fetch to
 * land before the cursor reaches the end at reels pace, without pulling pages
 * the viewer will never reach.
 */
const SESSION_TOP_UP_DISTANCE = 3;

/** The minimum an item needs to be addressable by a session. */
export interface VideoPipSessionItem {
  id: string;
}

export interface UseVideoPipSessionOptions<T extends VideoPipSessionItem> {
  /** The loaded list the cursor walks. */
  items: readonly T[];
  /**
   * Re-sync the pager to the index the session ended on, so leaving PiP lands on
   * the video that was playing rather than the one it started from.
   */
  onEnded: (index: number) => void;
  /** Fetch the next page — the session's own top-up. */
  loadMore: () => void;
  /** Whether another page exists at all. */
  hasMore: boolean;
}

export interface VideoPipSession<T extends VideoPipSessionItem> {
  /** Id of the item whose surface owns the OS window; `null` when closed. */
  ownerId: string | null;
  /** What the session is playing right now; `null` when closed. */
  playing: T | null;
  /** Open a session owned by this item's surface (it just entered PiP). */
  start: (itemId: string) => void;
  /** Close the session this item's surface owns; a non-owner is ignored. */
  end: (itemId: string) => void;
  goToNext: () => void;
  goToPrevious: () => void;
}

interface SessionState {
  ownerId: string;
  /** Index into `items` of the video the owner's player is loaded with. */
  cursor: number;
}

export function useVideoPipSession<T extends VideoPipSessionItem>({
  items,
  onEnded,
  loadMore,
  hasMore,
}: UseVideoPipSessionOptions<T>): VideoPipSession<T> {
  const [session, setSession] = useState<SessionState | null>(null);

  // A session opens where its owner already is: the surface that can enter PiP
  // is the one the viewer is watching, so its own position in the list is the
  // cursor's origin. An item that is not in the list cannot anchor a session.
  const start = useCallback((itemId: string) => {
    const index = items.findIndex((item) => item.id === itemId);
    if (index < 0) return;
    setSession({ ownerId: itemId, cursor: index });
  }, [items]);

  const end = useCallback((itemId: string) => {
    if (session === null || session.ownerId !== itemId) return;
    setSession(null);
    onEnded(session.cursor);
  }, [session, onEnded]);

  // Written through the updater rather than from the closure: the OS transport
  // buttons can fire twice before React has re-rendered — more easily than on
  // screen, since a background tab's renders are throttled — and a second press
  // reading the first press's cursor would be swallowed.
  const move = useCallback((delta: number) => {
    setSession((previous) => {
      if (previous === null) return previous;
      const cursor = Math.min(Math.max(previous.cursor + delta, 0), items.length - 1);
      return cursor === previous.cursor ? previous : { ...previous, cursor };
    });
  }, [items.length]);

  const goToNext = useCallback(() => move(1), [move]);
  const goToPrevious = useCallback(() => move(-1), [move]);

  // The list's own pagination is scroll-driven and nothing scrolls while the app
  // is backgrounded, so without this the session dead-ends on the last loaded
  // video. Derived from the committed cursor, so a burst of presses cannot skip
  // the trigger; `loadMore` itself is a no-op while a page is already in flight.
  const needsTopUp =
    session !== null && hasMore && session.cursor >= items.length - SESSION_TOP_UP_DISTANCE;
  useEffect(() => {
    if (needsTopUp) loadMore();
  }, [needsTopUp, loadMore]);

  const playing = session === null ? null : items.at(session.cursor) ?? null;

  return {
    ownerId: session?.ownerId ?? null,
    playing,
    start,
    end,
    goToNext,
    goToPrevious,
  };
}
