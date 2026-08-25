/**
 * The lifetime half of the shared video player registry: which key gets which
 * player object, and when that player is released.
 *
 * Both failure directions are asserted in the SAME test wherever they share a
 * setup, because a reference count is the kind of logic that passes a
 * one-sided test with its comparison inverted. "Released at zero" alone is
 * satisfied by releasing on every call; "not released while a holder remains"
 * alone is satisfied by never releasing at all. Only the pair pins the count.
 *
 * Nothing here touches a real decoder — `createVideoPlayer` is faked. What is
 * being measured is the bookkeeping, which is entirely ours; whether the native
 * object actually frees its hardware is expo-video's contract, not this file's.
 */

const mockError = jest.fn();

jest.mock('@oxyhq/core/logger', () => ({
    ...jest.requireActual('@oxyhq/core/logger'),
    createLogger: () => ({ error: (...args: unknown[]) => mockError(...args) }),
}));

interface FakePlayer {
    readonly id: number;
    readonly source: string;
    releaseCount: number;
    release: () => void;
}

// Prefixed `mock` so the hoisted `jest.mock` factory below may reference it.
const mockVideo = {
    created: [] as FakePlayer[],
    releaseThrows: false,
};

jest.mock('expo-video', () => ({
    createVideoPlayer: (source: string): FakePlayer => {
        const player: FakePlayer = {
            id: mockVideo.created.length,
            source,
            releaseCount: 0,
            release: () => {
                player.releaseCount += 1;
                if (mockVideo.releaseThrows) throw new Error('already released');
            },
        };
        mockVideo.created.push(player);
        return player;
    },
}));

import {
    __resetVideoPlayerRegistry,
    useVideoPlayerRegistry,
    videoPlayerKey,
    type VideoPlayerKey,
} from '../videoPlayerRegistry';

const acquire = (key: VideoPlayerKey, source: string) =>
    useVideoPlayerRegistry.getState().acquire(key, source);

const entryFor = (key: VideoPlayerKey) => useVideoPlayerRegistry.getState().entries[key];

const KEY = videoPlayerKey('post-1', 'media-1');
const OTHER_KEY = videoPlayerKey('post-1', 'media-2');
const SOURCE = 'https://cdn.example/one.m3u8';

beforeEach(() => {
    __resetVideoPlayerRegistry();
    mockVideo.created.length = 0;
    mockVideo.releaseThrows = false;
    mockError.mockClear();
});

describe('videoPlayerKey', () => {
    it('identifies the media, so one post with two videos is two players', () => {
        expect(videoPlayerKey('post-1', 'media-1')).not.toBe(videoPlayerKey('post-1', 'media-2'));
        expect(videoPlayerKey('post-1', 'media-1')).toBe(videoPlayerKey('post-1', 'media-1'));
    });
});

describe('acquiring', () => {
    it('hands the second consumer the SAME player, built once', () => {
        const first = acquire(KEY, SOURCE);
        const second = acquire(KEY, SOURCE);

        expect(second.player).toBe(first.player);
        expect(mockVideo.created).toHaveLength(1);
        expect(entryFor(KEY).refCount).toBe(2);
    });

    it('gives a different key its own player', () => {
        const first = acquire(KEY, SOURCE);
        const other = acquire(OTHER_KEY, 'https://cdn.example/two.m3u8');

        expect(other.player).not.toBe(first.player);
        expect(mockVideo.created).toHaveLength(2);
    });

    it('does NOT rebuild a live player when a later acquire names another source', () => {
        // Rebuilding is the behaviour this registry exists to avoid: it is what
        // `useVideoPlayer` does on a source change, and it drops the decoder and
        // the position mid-playback. A different video goes through
        // `player.replaceAsync`, which is the consumer's call to make.
        const first = acquire(KEY, SOURCE);
        const second = acquire(KEY, 'https://cdn.example/switched.m3u8');

        expect(second.player).toBe(first.player);
        expect(mockVideo.created).toHaveLength(1);
        expect(entryFor(KEY).source).toBe(SOURCE);
    });
});

describe('reference counting', () => {
    it('releases only once the LAST lease lets go', () => {
        const first = acquire(KEY, SOURCE);
        const second = acquire(KEY, SOURCE);
        const player = first.player as unknown as FakePlayer;

        first.release();

        // The control for the assertion below: a count that released eagerly
        // would already be at 1 here, and a `VideoView` still pointing at this
        // player would be holding a freed shared object.
        expect(player.releaseCount).toBe(0);
        expect(entryFor(KEY).refCount).toBe(1);

        second.release();

        expect(player.releaseCount).toBe(1);
        expect(entryFor(KEY)).toBeUndefined();
    });

    it('releases a single-holder player as soon as that holder lets go', () => {
        const only = acquire(KEY, SOURCE);
        const player = only.player as unknown as FakePlayer;

        expect(player.releaseCount).toBe(0);
        only.release();

        expect(player.releaseCount).toBe(1);
        expect(entryFor(KEY)).toBeUndefined();
    });

    it('counts three holders down one at a time', () => {
        const leases = [acquire(KEY, SOURCE), acquire(KEY, SOURCE), acquire(KEY, SOURCE)];
        const player = leases[0].player as unknown as FakePlayer;

        expect(entryFor(KEY).refCount).toBe(3);
        leases[0].release();
        expect(entryFor(KEY).refCount).toBe(2);
        leases[1].release();
        expect(entryFor(KEY).refCount).toBe(1);
        expect(player.releaseCount).toBe(0);

        leases[2].release();
        expect(player.releaseCount).toBe(1);
    });

    it('lets a key be acquired again after it was fully released, with a fresh player', () => {
        const first = acquire(KEY, SOURCE);
        first.release();

        const second = acquire(KEY, SOURCE);

        // A stranded entry would be the leak's quiet form: the key survives with
        // a dead player and every later video for that media is unplayable.
        expect(second.player).not.toBe(first.player);
        expect(mockVideo.created).toHaveLength(2);
        expect(entryFor(KEY).refCount).toBe(1);
    });
});

describe('over-release', () => {
    it('spends a lease exactly once, however many times it is released', () => {
        const first = acquire(KEY, SOURCE);
        const second = acquire(KEY, SOURCE);
        const player = first.player as unknown as FakePlayer;

        first.release();
        first.release();
        first.release();

        // The whole reason `release` lives on the lease rather than taking a
        // key: three calls from one holder must not spend the OTHER holder's
        // reference and free a player it is still rendering.
        expect(player.releaseCount).toBe(0);
        expect(entryFor(KEY).refCount).toBe(1);

        second.release();
        expect(player.releaseCount).toBe(1);
    });

    it('does not release the player twice when the last lease is released twice', () => {
        const only = acquire(KEY, SOURCE);
        const player = only.player as unknown as FakePlayer;

        only.release();
        only.release();

        expect(player.releaseCount).toBe(1);
    });

    it('survives a lease released after the registry was reset', () => {
        const only = acquire(KEY, SOURCE);
        const player = only.player as unknown as FakePlayer;

        __resetVideoPlayerRegistry();
        expect(player.releaseCount).toBe(1);

        expect(() => only.release()).not.toThrow();
        expect(player.releaseCount).toBe(1);
    });
});

describe('a player whose release throws', () => {
    it('reports it and still drops the entry, so the key is not stranded', () => {
        mockVideo.releaseThrows = true;
        const only = acquire(KEY, SOURCE);

        expect(() => only.release()).not.toThrow();
        expect(entryFor(KEY)).toBeUndefined();
        expect(mockError).toHaveBeenCalledWith(
            'Releasing a video player threw',
            expect.any(Error),
            { key: KEY },
        );

        mockVideo.releaseThrows = false;
        expect(acquire(KEY, SOURCE).player).toBeDefined();
    });
});

describe('store reactivity', () => {
    it('notifies subscribers when a key appears and when it goes', () => {
        // Consumers read the registry through zustand (`useSyncExternalStore`)
        // rather than a module-level map, because the React Compiler freezes
        // external mutable state read from a memoized position. A subscription
        // that never fires would mean a surface rendering against a released
        // player.
        const seen: number[] = [];
        const unsubscribe = useVideoPlayerRegistry.subscribe((state) => {
            seen.push(Object.keys(state.entries).length);
        });

        const only = acquire(KEY, SOURCE);
        only.release();
        unsubscribe();

        expect(seen).toEqual([1, 0]);
    });
});
