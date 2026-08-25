import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { createVideoPlayer, type VideoPlayer } from 'expo-video';
import { createLogger } from '@oxyhq/core/logger';

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
 */

/**
 * A player is identified by the MEDIA, not by the surface showing it: the same
 * clip reached from the feed and from the reels pager is one video and must be
 * one decoder, holding one position. A post can carry several videos, so the
 * post id alone is not enough.
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
        const player = existing?.player ?? createVideoPlayer(source);

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
            releasePlayer(entry.player, key);
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
    const [lease] = useState(() => acquireVideoPlayer(key, source));
    useEffect(() => () => lease.release(), [lease]);
    return lease.player;
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
}
