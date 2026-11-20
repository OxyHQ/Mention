import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { createVideoPlayer, type VideoPlayer } from 'expo-video';
import { setVideoHasRenderedFrame } from '@oxy.so/bloom/video-playback';
import { VIDEO_BUFFER_OPTIONS, videoSourceFor } from '@/utils/videoSource';
import { needsJsHlsDecoder } from '@/lib/hlsPlayback';
import { createLogger } from '@oxy.so/core/logger';

const logger = createLogger('VideoPlayerRegistry');

/**
 * ONE `VideoPlayer` PER PIECE OF MEDIA, OWNED BY NOBODY IN PARTICULAR.
 *
 * `useVideoPlayer` ties a player's lifetime to the component that called it: it
 * is built on `useReleasingSharedObject`, which releases the player when that
 * component unmounts and REBUILDS it whenever the source (or the builder
 * options) change. That is the right default for a surface that owns its video
 * outright, and it is exactly wrong for a video that has to survive the surface
 * — a feed row scrolling out from under a still-playing video, or the same clip
 * appearing in two places at once. The decoder dies with the component, and the
 * position dies with the decoder.
 *
 * `createVideoPlayer` builds the same player with no component attached and no
 * automatic release, which moves one question from React to us: who calls
 * `release()`, and when. Getting that wrong fails in both directions, and the
 * two failures look nothing alike. A player nobody releases is a leaked
 * hardware decoder — invisible until the platform runs out of them and later
 * videos silently refuse to load. A player released while a `VideoView` still
 * points at it is a native crash on the spot, because the view is holding the
 * shared object by id (`VideoView.js` passes `player.__expo_shared_object_id__`
 * across the bridge, not the JS object) and nothing tells it the object went
 * away.
 *
 * So the answer here is a reference count with a deliberately narrow job:
 * identity and lifetime, nothing else. It decides WHICH player a key gets and
 * WHEN that player dies. It does not configure players (`loop`, `muted`,
 * `timeUpdateEventInterval` belong to whoever is presenting the video, and two
 * consumers may legitimately disagree), it does not play or pause them, and it
 * does not swap their sources — a live player changes video through
 * `replaceAsync`, never by being rebuilt, which is the whole reason this exists.
 *
 * A PLAYER NOBODY HOLDS IS PARKED, NOT DESTROYED. Building an expo-video player
 * on Android builds an ExoPlayer, its playback thread and a MediaSession, and a
 * feed attaches and detaches players constantly as rows enter and leave the
 * preload window, as the reel does on every swipe. So the last release parks
 * the player emptied (paused, source cleared, which frees its decoder and its
 * buffer), and the next acquire for any key, from either, takes a parked player
 * and hands it the new source. Media3's own short-form sample does the same
 * with a pool of three. At most {@link MAX_PARKED_PLAYERS} wait; past that a
 * released player is destroyed.
 */

/**
 * A player is identified by the MEDIA, not by the surface showing it: a clip the
 * feed carries into the reels pager is one video and must be one decoder,
 * holding one position. A post can carry several videos, so the post id alone is
 * not enough. The reel's own slides lease under a namespace of their own
 * (`reelPlayerKey` in the videos screen): a player paints into one view at a
 * time, and the feed under the reel keeps its on-screen rows.
 */
export type VideoPlayerKey = string & { readonly __brand: 'VideoPlayerKey' };

export function videoPlayerKey(postId: string, mediaId: string): VideoPlayerKey {
  return `${postId}:${mediaId}` as VideoPlayerKey;
}

export interface VideoPlayerEntry {
  readonly player: VideoPlayer;
  /**
   * The source the player was CONSTRUCTED with — not necessarily what it is
   * playing now. A consumer that needs a different video calls
   * `player.replaceAsync`; re-acquiring with another source deliberately does
   * not rebuild, so this stays as a record of where the player started.
   */
  readonly source: string;
  /** How many live leases are holding this player open. Never below 1: an entry at zero is deleted. */
  readonly refCount: number;
}

/**
 * A single acquisition's handle on a player. `release` is idempotent PER LEASE,
 * which is the point of handing one back instead of exposing `release(key)`.
 *
 * With a bare key-based release, a consumer that released twice — a double
 * cleanup, a re-run effect, a teardown racing an unmount — would decrement a
 * count it no longer owned and free a player somebody else is still rendering.
 * That is the native-crash direction, and it is not a bug a caller can see
 * coming. A lease can only ever spend the one reference it took, so the
 * arithmetic cannot be corrupted by a caller getting its own bookkeeping wrong.
 */
export interface VideoPlayerLease {
  readonly key: VideoPlayerKey;
  readonly player: VideoPlayer;
  readonly release: () => void;
}

interface VideoPlayerRegistryState {
  /**
   * Reactive: consumers read through this store (zustand is backed by
   * `useSyncExternalStore`) rather than through a module-level map or a ref
   * read during render. The React Compiler is on, and external mutable state
   * read from a memoized position is frozen at its first value — for a
   * registry that would mean rendering a `VideoView` against a player that has
   * already been released.
   */
  readonly entries: Readonly<Record<string, VideoPlayerEntry>>;
  acquire: (key: VideoPlayerKey, source: string) => VideoPlayerLease;
}

export const useVideoPlayerRegistry = create<VideoPlayerRegistryState>((set, get) => ({
  entries: {},

  acquire: (key, source) => {
    const existing = get().entries[key];
    const player = existing?.player ?? takePlayer(source);

    set((state) => ({
      entries: {
        ...state.entries,
        [key]: existing
          ? { ...existing, refCount: existing.refCount + 1 }
          : { player, source, refCount: 1 },
      },
    }));

    // Spent by the first `release()` call on THIS lease, so a caller that
    // releases twice cannot reach the shared count a second time.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;

      const entry = get().entries[key];
      // Absent means the registry was reset out from under this lease
      // (`__resetVideoPlayerRegistry`). The player is already gone; there
      // is nothing left to count down.
      if (!entry) return;

      if (entry.refCount > 1) {
        set((state) => ({
          entries: { ...state.entries, [key]: { ...entry, refCount: entry.refCount - 1 } },
        }));
        return;
      }

      // Last holder: drop the entry FIRST, so nothing can observe — or
      // re-acquire — an entry whose player is being torn down.
      set((state) => {
        const { [key]: _dropped, ...rest } = state.entries;
        return { entries: rest };
      });
      parkPlayer(entry.player, key);
    };

    return { key, player, release };
  },
}));

/**
 * Take a lease from outside React.
 *
 * The store is named `useVideoPlayerRegistry`, and the React Compiler refuses a
 * `use`-prefixed identifier referenced as a VALUE inside a hook — "Hooks may not
 * be referenced as normal values, they must be called". At module scope the same
 * call carries no such ambiguity, which is why the imperative entry point lives
 * here rather than inline.
 */
export function acquireVideoPlayer(key: VideoPlayerKey, source: string): VideoPlayerLease {
  return useVideoPlayerRegistry.getState().acquire(key, source);
}

/**
 * The live player for `key`, or `null` when nothing holds one.
 *
 * A READ, not a lease: the caller is looking at a player somebody else is
 * keeping alive (a tap handler asking what the row under the finger is
 * playing), so it must not touch the count. Module scope for the same reason as
 * `acquireVideoPlayer` — inside a component the compiler refuses to see a
 * `use`-prefixed identifier used as a value.
 */
export function peekVideoPlayer(key: VideoPlayerKey): VideoPlayer | null {
  return useVideoPlayerRegistry.getState().entries[key]?.player ?? null;
}

/**
 * THE ONE MOMENT NO COMPONENT OWNS THE PLAYER.
 *
 * A hand-off between two screens has a gap in the middle: the origin's surface
 * unmounts with the route that held its lease, and the destination has not
 * mounted to take one yet. Measured, that gap is real and the count reaches
 * ZERO inside it — the registry does exactly what it is asked, releases the
 * player, and the destination then builds a fresh one that starts at zero. The
 * flying surface keeps painting because the web element outlives the object,
 * which is what made this look like it was working.
 *
 * So a transition takes a reference of its own, and holds it across the gap.
 *
 * At most ONE is held app-wide: a transition is a single user action, and
 * bounding it to one means a hand-off that never completes strands one decoder
 * rather than accumulating them. Taking a new hold releases the previous.
 */
let transitionHold: (VideoPlayerLease & { retireFlight?: () => void }) | null = null;

export function holdAcrossTransition(
  key: VideoPlayerKey,
  source: string,
  retireFlight?: () => void,
): () => boolean {
  const previous = transitionHold;
  const lease = { ...acquireVideoPlayer(key, source), retireFlight };
  transitionHold = lease;
  // A new media target supersedes the prior flight as well as its bridge.
  // Retapping the same target transfers ownership of the existing flight.
  if (previous && previous.key !== key) previous.retireFlight?.();
  previous?.release();
  return () => {
    if (transitionHold !== lease) return false;
    transitionHold = null;
    lease.release();
    return true;
  };
}

/** Capture only this navigation's bridge; stale cleanup cannot cancel a newer tap. */
export function pendingVideoTransition(postId: string) {
  const lease = transitionHold;
  if (!lease?.key.startsWith(`${postId}:`)) return null;
  return {
    key: lease.key,
    release: () => {
      if (transitionHold !== lease) return false;
      transitionHold = null;
      lease.release();
      return true;
    },
  };
}

/**
 * Let go of the transition's reference, once a real owner has taken one.
 *
 * Called from `useVideoPlayerLease` AFTER it has acquired, never before: the
 * count has to go 1 → 2 → 1, and releasing first would take it through zero and
 * destroy the very player being handed over.
 */
export function releaseTransitionHold(key: VideoPlayerKey): void {
  if (transitionHold?.key !== key) return;
  transitionHold.release();
  transitionHold = null;
}

/**
 * Hold the registry's player for `key` for as long as the calling component is
 * mounted, and let go on unmount.
 *
 * The player has to exist on the FIRST render: a surface that mounted with its
 * own player and adopted the shared one a commit later would restart the video
 * at exactly the moment this mechanism exists to make seamless. A lazy
 * `useState` initialiser is the shape that gives that without reading a ref
 * during render — which the React Compiler rejects outright here, not merely
 * bails on (`Ref values (the current property) may not be accessed during
 * render`). That was read off the app's own compiler rather than reasoned
 * about, after a first attempt that mirrored expo-video's internal
 * `useReleasingSharedObject` was refused.
 *
 * CALLER CONTRACT: give the component a React `key` carrying the same identity
 * as `key` here, so a different video is a different component instance. The
 * lease is taken once per mount and deliberately does not re-key — a recycled
 * row pointed at another video would otherwise keep the previous player.
 */
export function useVideoPlayerLease(key: VideoPlayerKey, source: string): VideoPlayer {
  const [lease] = useState(() => {
    const own = acquireVideoPlayer(key, source);
    // A real owner has arrived, so the transition's bridge is done. After
    // acquiring, never before — see `releaseTransitionHold`.
    releaseTransitionHold(key);
    return own;
  });
  useEffect(() => () => lease.release(), [lease]);
  return lease.player;
}

/**
 * The registry's player for `key` while `attached`, and `null` otherwise: a
 * feed row's player, held while the row is inside its list's preload window
 * (`useViewableNear`) and given back once it leaves, so the pool lends it to
 * the next row. The row keeps drawing its poster and controls either way.
 *
 * The lease is a subscription (taken in an effect, released by its cleanup)
 * and the player is READ from the store, so attaching and detaching are
 * ordinary re-renders of the one row. A row that mounts already attached
 * takes its first lease while rendering, as `useVideoPlayerLease` does, so a
 * row mounting on screen has its player in its first commit; the effect then
 * takes the lasting lease before letting that one go (1 → 2 → 1).
 *
 * Same caller contract as `useVideoPlayerLease`: a React `key` carrying `key`.
 */
export function useAttachedVideoPlayer(
  key: VideoPlayerKey,
  source: string,
  attached: boolean,
): VideoPlayer | null {
  const [mountLease] = useState(() => {
    if (!attached) return null;
    const lease = acquireVideoPlayer(key, source);
    releaseTransitionHold(key);
    return lease;
  });
  useEffect(() => {
    if (!attached) {
      mountLease?.release();
      return;
    }
    const lease = acquireVideoPlayer(key, source);
    mountLease?.release();
    releaseTransitionHold(key);
    return lease.release;
  }, [attached, key, source, mountLease]);
  return useVideoPlayerRegistry((state) =>
    attached ? (state.entries[key]?.player ?? null) : null,
  );
}

/** Emptied players waiting for their next video: the decoders a feed scroll reuses. */
const MAX_PARKED_PLAYERS = 2;
const parkedPlayers: VideoPlayer[] = [];

/**
 * A player for `source`: a parked one handed the new source, or a new one.
 *
 * A source hls.js will decode (a federated playlist, on a browser that cannot
 * play one itself) is withheld from the player: hls.js attaches its own
 * MediaSource to the element, and a player holding the playlist url would
 * first start — and fail — a native load of it.
 */
function takePlayer(source: string): VideoPlayer {
  const playable = needsJsHlsDecoder(source) ? null : videoSourceFor(source);
  const parked = parkedPlayers.pop();
  if (!parked) {
    const player = createVideoPlayer(playable);
    player.bufferOptions = VIDEO_BUFFER_OPTIONS;
    return player;
  }
  parked.replaceAsync(playable).catch((error: unknown) => {
    logger.error('Handing a parked video player its source failed', error);
  });
  return parked;
}

/**
 * Give back a player nobody holds: emptied and parked for the next video, or
 * destroyed once enough are waiting. Emptying stops the download and frees the
 * decoder and the buffer; the playback control forgets the frame it painted,
 * so the next row shows its poster until its own video paints. Presentation
 * goes back to where a new player starts, because the next holder may not set
 * all of it (`timeUpdateEventInterval` is only ever raised by a surface).
 */
function parkPlayer(player: VideoPlayer, key: VideoPlayerKey): void {
  if (parkedPlayers.length >= MAX_PARKED_PLAYERS) {
    releasePlayer(player, key);
    return;
  }
  try {
    player.pause();
    Object.assign(player, { loop: false, muted: true, timeUpdateEventInterval: 0 });
    setVideoHasRenderedFrame(player, false);
    player.replaceAsync(null).catch((error: unknown) => {
      logger.error('Emptying a parked video player failed', error, { key });
    });
    parkedPlayers.push(player);
  } catch (error) {
    // A player that cannot be emptied cannot be trusted with another video.
    logger.error('Parking a video player threw', error, { key });
    releasePlayer(player, key);
  }
}

/**
 * A shared object that throws on `release` has already been released by someone
 * else, and the entry is gone either way — keeping it would strand the key so
 * the same video could never get a player again. Report it rather than swallow
 * it: it means two owners believed they held the last reference.
 */
function releasePlayer(player: VideoPlayer, key: VideoPlayerKey): void {
  try {
    player.release();
  } catch (error) {
    logger.error('Releasing a video player threw', error, { key });
  }
}

/**
 * Test-only teardown. Releases every player the registry still holds, so one
 * test's leases cannot leak a decoder into the next.
 */
export function __resetVideoPlayerRegistry(): void {
  const { entries } = useVideoPlayerRegistry.getState();
  useVideoPlayerRegistry.setState({ entries: {} });
  for (const [key, entry] of Object.entries(entries)) {
    releasePlayer(entry.player, key as VideoPlayerKey);
  }
  for (const player of parkedPlayers.splice(0)) {
    releasePlayer(player, 'parked' as VideoPlayerKey);
  }
}
