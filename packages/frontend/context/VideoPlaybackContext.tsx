import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { AppState, Dimensions, Platform } from 'react-native';
import { useIsFocused } from 'expo-router';

/**
 * The single app-wide authority answering "may this player play right now?".
 *
 * Three inputs:
 *
 * - **Visible** — on screen AND its screen is focused AND the app/tab is in the
 *   foreground. Applies to EVERY player, GIFs included; anything else pauses.
 * - **Active** — among the *visible audible* players, exactly one may play: the
 *   one closest to the viewport's ideal line (web) or highest in the list's
 *   viewable order (native). Silent players (GIF mode) never compete, so several
 *   visible GIFs may animate at once.
 * - **Session owner** — the one player the OS is presenting OUTSIDE the app's
 *   own layout, in the Picture-in-Picture window. While a session is open the
 *   layout no longer describes what the viewer is watching, so the owner is
 *   eligible whatever its viewability source says, takes the audible slot
 *   outright, and is exempt from the foreground gate. Its screen may keep
 *   feeding it new content — the reel advances by swapping the SOURCE on this
 *   same player — and the authority must not pull the slot out from under it
 *   when the surface it was mounted for stops being the on-screen one.
 *
 * Visibility is *reported*, never guessed, and the source is per platform:
 * web players observe themselves with an `IntersectionObserver`; native players
 * inside a list read the viewable keys the list publishes through
 * {@link VideoViewabilityProvider}, either by their own key or through a
 * {@link VideoViewabilityScope} when the list cannot address them individually;
 * a native player with no list above it (post detail, single-video screens, the
 * GIF picker) is visible while its screen is focused.
 *
 * Where a source EXISTS, an unmatched player is NOT visible. "Unknown, so assume
 * yes" is precisely how an off-screen video keeps playing, which is the bug this
 * authority exists to kill — so every ambiguous case falls to silence.
 */

const IS_WEB = Platform.OS === 'web';

/**
 * The viewport line the audible video is chosen against — a fraction of the
 * window height, so slightly above the centre (the line the eye rests on while
 * scrolling a feed).
 */
const IDEAL_VIEWPORT_LINE_DIVISOR = 2.5;

/**
 * App/tab foreground, tracked ONCE for the whole app instead of per player.
 * Exposed through `useSyncExternalStore` because `AppState` / `document` are
 * external mutable state: the React Compiler would freeze a plain render-time
 * read forever.
 */
function subscribeForeground(onStoreChange: () => void): () => void {
  if (IS_WEB) {
    if (typeof document === 'undefined') return () => {};
    document.addEventListener('visibilitychange', onStoreChange);
    return () => document.removeEventListener('visibilitychange', onStoreChange);
  }
  // `addEventListener` THROWS when AppState has no native module behind it, so
  // this is a guard against a crash, not a nicety.
  if (!AppState.isAvailable) return () => {};
  const subscription = AppState.addEventListener('change', onStoreChange);
  return () => subscription.remove();
}

function getForegroundSnapshot(): boolean {
  if (IS_WEB) {
    return typeof document === 'undefined' || document.visibilityState === 'visible';
  }
  // iOS reports a transient 'inactive' (app switcher, incoming call), which is
  // genuinely not foreground. But `AppState.currentState` is null until the
  // native module answers — and stays null forever where AppState is
  // unavailable — so only a POSITIVELY reported non-active state may mute the
  // app. Treating "no answer" as backgrounded would silence every video
  // everywhere the module is missing, and an absent AppState is not evidence
  // that the app is in the background.
  const state = AppState.currentState;
  return state == null || state === 'active';
}

/** Server render: nothing is playing yet, so foreground is the neutral answer. */
function getForegroundServerSnapshot(): boolean {
  return true;
}

interface PlayerRegistration {
  /** Silent players (GIF mode) never compete for the single audible slot. */
  silent: boolean;
  /**
   * Visible AND on a focused screen — or the owner of an open session, whose
   * surface is deliberately no longer the on-screen one. Screen focus belongs in
   * candidacy, not only in the final gate: a blurred screen's player is often
   * still intersecting the viewport, and if it could still hold the audible slot
   * it would silence the video on the screen the viewer actually navigated to.
   */
  eligible: boolean;
  /**
   * Ordering input for the audible slot. Web: the player's viewport centre-Y,
   * turned into a distance from the ideal line at selection time (the authority
   * owns the window height). Native: the player's index in its list's viewable
   * order, so the topmost viewable video wins.
   */
  order: number;
  /**
   * Web: read this player's CURRENT centre-Y, called at selection time.
   *
   * `order` is published from an `IntersectionObserver`, which only fires when a
   * threshold is crossed — so a player that stays visible while the page scrolls
   * keeps reporting the position it had when it last crossed. Measured on a
   * profile with two video rows: the upper one sat 159px from the ideal line and
   * the lower one 370px, and the LOWER one held the slot in four runs out of
   * four, because the upper one's published position was the one it had on the
   * way in. Ranking by a remembered position ranks the past.
   */
  measureOrder?: () => number | undefined;
  /** This player owns the OS Picture-in-Picture window (see the session note above). */
  ownsSession: boolean;
}

interface VideoPlaybackContextValue {
  /** The single player allowed to be audible, or `null` when nothing qualifies. */
  activeId: string | null;
  foreground: boolean;
  publish: (id: string, registration: PlayerRegistration) => void;
  unpublish: (id: string) => void;
  claimActive: (id: string) => void;
}

const VideoPlaybackContext = createContext<VideoPlaybackContextValue | null>(null);
VideoPlaybackContext.displayName = 'VideoPlaybackContext';

/**
 * What the nearest viewability owner says about the players below it.
 *
 * - `keys` — a list publishing everything currently on screen as `key → index in
 *   on-screen order`. A player matches by its own `viewabilityKey`.
 * - `scope` — one already-resolved answer for a whole subtree, used where the
 *   list renders players it cannot address by key (its `ListHeaderComponent`, a
 *   non-post row such as a profile's pinned post).
 *
 * `null` means no owner at all, which is the only case that resolves to visible.
 */
type ViewabilitySource =
  | { kind: 'keys'; order: ReadonlyMap<string, number> }
  | { kind: 'scope'; visible: boolean; order: number };

const VideoViewabilityContext = createContext<ViewabilitySource | null>(null);
VideoViewabilityContext.displayName = 'VideoViewabilityContext';

/**
 * Native visibility + the audible-slot ordering for one player, resolved from
 * the nearest viewability owner. An unmatched player under an existing owner is
 * NOT visible: assuming otherwise is what leaves a scrolled-past video playing.
 */
function resolveNativeVisibility(
  source: ViewabilitySource | null,
  viewabilityKey: string | undefined,
): { visible: boolean; order: number } {
  if (source === null) return { visible: true, order: 0 };
  if (source.kind === 'scope') return { visible: source.visible, order: source.order };
  const rank = viewabilityKey === undefined ? undefined : source.order.get(viewabilityKey);
  return { visible: rank !== undefined, order: rank ?? 0 };
}

export function VideoPlaybackProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [activeId, setActiveId] = useState<string | null>(null);
  const foreground = useSyncExternalStore(
    subscribeForeground,
    getForegroundSnapshot,
    getForegroundServerSnapshot,
  );

  // Mounted players and the viewer's manual override live outside React state on
  // purpose: registrations churn while scrolling and must not re-render the tree.
  // Only the resulting `activeId` does.
  const playersRef = useRef<Map<string, PlayerRegistration>>(new Map());
  const manualIdRef = useRef<string | null>(null);

  // Re-elects the audible player from the current registry. Called from event
  // handlers and effects — never during render — so reading the imperative
  // registry (and the live window height) here is safe under the React Compiler.
  const reselect = useCallback(() => {
    const players = playersRef.current;
    const idealY = Dimensions.get('window').height / IDEAL_VIEWPORT_LINE_DIVISOR;

    // A session owner outranks BOTH the manual override and the viewport
    // ranking: the OS is showing that player outside the app, so it is the only
    // one the viewer can actually see, and the two ordering rules below rank
    // surfaces against a layout the viewer is not looking at. Only one player
    // can hold the OS window, but a tie is resolved on the id anyway so the
    // winner never depends on Map insertion order.
    let sessionId: string | null = null;
    for (const [id, registration] of players) {
      if (registration.ownsSession && (sessionId === null || id < sessionId)) {
        sessionId = id;
      }
    }
    if (sessionId !== null) {
      setActiveId(sessionId);
      return;
    }

    // A manually played video keeps the slot while it stays visible. Once it
    // scrolls out of view (or unmounts) the override is dropped for good and the
    // slot is contested again.
    const manualId = manualIdRef.current;
    if (manualId !== null) {
      const manual = players.get(manualId);
      if (manual && manual.eligible && !manual.silent) {
        setActiveId(manualId);
        return;
      }
      manualIdRef.current = null;
    }

    let bestId: string | null = null;
    let bestRank = Infinity;
    for (const [id, registration] of players) {
      if (registration.silent || !registration.eligible) continue;
      // Measured HERE rather than read from the registration: this runs in an
      // event handler or an effect, never in render, so touching the DOM is
      // safe — and it is the only moment at which "closest to the line" can be
      // answered about now instead of about the last threshold crossing.
      const current = IS_WEB ? registration.measureOrder?.() : undefined;
      const order = current ?? registration.order;
      const rank = IS_WEB ? Math.abs(order - idealY) : order;
      // Equal rank is real, not theoretical: two videos in ONE multi-media post
      // share a viewability key and therefore a rank. Resolve it on the id, so the
      // winner is a function of the CANDIDATES alone — never of Map insertion or
      // mount order. (Preferring the incumbent would be kinder to flapping but is
      // itself path-dependent, which is the same defect.)
      if (rank < bestRank || (rank === bestRank && bestId !== null && id < bestId)) {
        bestRank = rank;
        bestId = id;
      }
    }
    // No visible audible candidate — e.g. the viewer scrolled past the last
    // video — so NOTHING plays until one reports itself visible again.
    setActiveId(bestId);
  }, []);

  const publish = useCallback(
    (id: string, registration: PlayerRegistration) => {
      playersRef.current.set(id, registration);
      reselect();
    },
    [reselect],
  );

  const unpublish = useCallback(
    (id: string) => {
      playersRef.current.delete(id);
      reselect();
    },
    [reselect],
  );

  const claimActive = useCallback(
    (id: string) => {
      manualIdRef.current = id;
      reselect();
    },
    [reselect],
  );

  const value = useMemo<VideoPlaybackContextValue>(
    () => ({ activeId, foreground, publish, unpublish, claimActive }),
    [activeId, foreground, publish, unpublish, claimActive],
  );

  return (
    <VideoPlaybackContext.Provider value={value}>
      {children}
    </VideoPlaybackContext.Provider>
  );
}

/** Mounted by a list that owns viewability for the players inside it (native feeds). */
export function VideoViewabilityProvider({
  viewableKeys,
  children,
}: {
  viewableKeys: ReadonlySet<string>;
  children: React.ReactNode;
}): React.ReactElement {
  // A `Set` keeps insertion order, so the publisher's order (top of the list
  // first) becomes the index a player is ranked by for the audible slot.
  const source = useMemo<ViewabilitySource>(() => {
    const order = new Map<string, number>();
    let index = 0;
    for (const key of viewableKeys) {
      order.set(key, index);
      index += 1;
    }
    return { kind: 'keys', order };
  }, [viewableKeys]);

  return (
    <VideoViewabilityContext.Provider value={source}>
      {children}
    </VideoViewabilityContext.Provider>
  );
}

/**
 * Binds a whole subtree to ONE key of the nearest viewability source, for the
 * parts of a list whose players it cannot address individually: its
 * `ListHeaderComponent` (not a data row at all, so it never appears in
 * `onViewableItemsChanged`) and non-post rows such as a profile's pinned post,
 * whose players are keyed by post id the list does not know.
 *
 * Every player inside is visible exactly while `viewabilityKey` is on screen —
 * and NOT visible once it is absent, so a subtree that scrolls away goes silent.
 * With no key source above (a scope used without its list) nothing inside plays:
 * the ambiguous direction is silence, never sound.
 */
export function VideoViewabilityScope({
  viewabilityKey,
  children,
}: {
  viewabilityKey: string;
  children: React.ReactNode;
}): React.ReactElement {
  const source = useContext(VideoViewabilityContext);
  const scope = useMemo<ViewabilitySource>(() => {
    const rank = source?.kind === 'keys' ? source.order.get(viewabilityKey) : undefined;
    return { kind: 'scope', visible: rank !== undefined, order: rank ?? 0 };
  }, [source, viewabilityKey]);

  return (
    <VideoViewabilityContext.Provider value={scope}>
      {children}
    </VideoViewabilityContext.Provider>
  );
}

export interface UseVideoPlaybackOptions {
  /** Stable identity of this player instance. */
  id: string;
  /**
   * Web: read this player's current viewport centre-Y. Memoize it — it is a
   * registration field, so a new identity on every render republishes.
   */
  measureOrder?: () => number | undefined;
  /** Key this player is known by to the nearest viewability source; omit outside a list. */
  viewabilityKey?: string;
  /** Silent players (GIF mode) never compete for the single audible slot. */
  silent?: boolean;
  /**
   * Set while this player owns the OS Picture-in-Picture window. It then keeps
   * the audible slot and the right to play whatever the app's layout is doing —
   * see the session note at the top of this file.
   */
  ownsSession?: boolean;
}

export interface UseVideoPlaybackResult {
  /** The ONLY playback signal a consumer needs. */
  shouldPlay: boolean;
  /** Manual play wins: claim the audible slot. */
  claimActive: () => void;
  /** Web: report viewport center-Y and intersection from an IntersectionObserver. */
  reportVisibility: (y: number, isIntersecting: boolean) => void;
}

interface WebVisibility {
  y: number;
  isIntersecting: boolean;
}

/**
 * Nothing has been observed yet, so a web player starts hidden: an off-screen
 * video must never get a head start on audio before its first observation.
 */
const UNOBSERVED: WebVisibility = { y: 0, isIntersecting: false };

export function useVideoPlayback({
  id,
  viewabilityKey,
  silent = false,
  ownsSession = false,
  measureOrder,
}: UseVideoPlaybackOptions): UseVideoPlaybackResult {
  const authority = useContext(VideoPlaybackContext);
  if (!authority) {
    throw new Error('useVideoPlayback must be used inside a <VideoPlaybackProvider>');
  }
  const { activeId, foreground, publish, unpublish, claimActive: claimActiveById } = authority;

  const viewabilitySource = useContext(VideoViewabilityContext);
  const screenFocused = useIsFocused();

  const [webVisibility, setWebVisibility] = useState<WebVisibility>(UNOBSERVED);
  const reportVisibility = useCallback((y: number, isIntersecting: boolean) => {
    setWebVisibility((previous) =>
      previous.y === y && previous.isIntersecting === isIntersecting
        ? previous
        : { y, isIntersecting },
    );
  }, []);

  // Visibility resolution: web → strictly the player's own observer; native →
  // the nearest viewability owner (see `resolveNativeVisibility`).
  const native = resolveNativeVisibility(viewabilitySource, viewabilityKey);
  const visible = IS_WEB ? webVisibility.isIntersecting : native.visible;
  const order = IS_WEB ? webVisibility.y : native.order;
  // A session owner is eligible whatever the layout reports about it: the screen
  // that opened the session leaves that surface behind on purpose (the pager
  // moves on, or the app is backgrounded entirely), so its viewability source is
  // describing something the viewer is no longer being shown.
  const eligible = ownsSession || (visible && screenFocused);

  // The authority is an imperative registry outside React's tree; publishing this
  // player's candidacy into it — and removing it on unmount, which is what
  // releases the audible slot — is the legitimate subscribe-with-cleanup effect.
  // Split in two so a scroll-driven position update never momentarily unpublishes
  // the player and hands the slot to someone else for a frame.
  useEffect(() => {
    publish(id, { silent, eligible, order, ownsSession, measureOrder });
  }, [publish, id, silent, eligible, order, ownsSession, measureOrder]);

  useEffect(() => () => unpublish(id), [unpublish, id]);

  const claimActive = useCallback(() => claimActiveById(id), [claimActiveById, id]);

  const shouldPlay =
    eligible && (foreground || ownsSession) && (silent || activeId === id);

  return { shouldPlay, claimActive, reportVisibility };
}
