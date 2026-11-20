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

import React from 'react';
import TestRenderer from 'react-test-renderer';

const mockError = jest.fn();

jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
  createLogger: () => ({ error: (...args: unknown[]) => mockError(...args) }),
}));

/**
 * `givenBack` counts the times the registry let go of the player: destroyed
 * (`release()`) or parked for the next video (`replaceAsync(null)`). Which of
 * the two is the pool's business, asserted on its own below; the reference
 * count only decides WHEN a player is given back.
 */
interface FakePlayer {
  readonly id: number;
  readonly source: string;
  givenBack: number;
  destroyed: boolean;
  replacedWith: unknown[];
  pause: jest.Mock;
  muted: boolean;
  loop: boolean;
  timeUpdateEventInterval: number;
  bufferOptions?: unknown;
  status: string;
  addListener: () => { remove: () => void };
  release: () => void;
  replaceAsync: (source: unknown) => Promise<void>;
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
      givenBack: 0,
      destroyed: false,
      replacedWith: [],
      pause: jest.fn(),
      muted: false,
      loop: true,
      timeUpdateEventInterval: 0.25,
      status: 'idle',
      addListener: () => ({ remove: () => {} }),
      release: () => {
        player.givenBack += 1;
        player.destroyed = true;
        if (mockVideo.releaseThrows) throw new Error('already released');
      },
      replaceAsync: (next: unknown) => {
        player.replacedWith.push(next);
        if (next === null) player.givenBack += 1;
        return Promise.resolve();
      },
    };
    mockVideo.created.push(player);
    return player;
  },
}));

// Whether hls.js will own a source is a browser question; each test answers it.
const mockNeedsJsHlsDecoder = jest.fn((_source: string) => false);
jest.mock('@/lib/hlsPlayback', () => ({
  needsJsHlsDecoder: (source: string) => mockNeedsJsHlsDecoder(source),
}));

import {
  __resetVideoPlayerRegistry,
  acquireVideoPlayer,
  holdAcrossTransition,
  pendingVideoTransition,
  releaseTransitionHold,
  peekVideoPlayer,
  useAttachedVideoPlayer,
  useVideoPlayerLease,
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
  // A hold outlives a test by design, so it has to be cleared between them.
  releaseTransitionHold(videoPlayerKey('post-1', 'media-1'));
  releaseTransitionHold(videoPlayerKey('post-1', 'media-2'));
  __resetVideoPlayerRegistry();
  mockVideo.created.length = 0;
  mockVideo.releaseThrows = false;
  mockError.mockClear();
  mockNeedsJsHlsDecoder.mockReset();
  mockNeedsJsHlsDecoder.mockReturnValue(false);
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

  // On a browser that decodes HLS through hls.js, the playlist must not reach
  // the element: hls.js attaches its own MediaSource, and an element holding
  // the url would first start — and fail — a native load of it.
  it('builds the player WITHOUT a source when hls.js will decode it', () => {
    mockNeedsJsHlsDecoder.mockReturnValue(true);
    acquire(KEY, SOURCE);

    expect(mockNeedsJsHlsDecoder).toHaveBeenCalledWith(SOURCE);
    expect(mockVideo.created[0]?.source).toBeNull();
  });

  it('builds the player WITH its source when the platform decodes it', () => {
    acquire(KEY, SOURCE);
    expect(mockVideo.created[0]?.source).not.toBeNull();
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
    expect(player.givenBack).toBe(0);
    expect(entryFor(KEY).refCount).toBe(1);

    second.release();

    expect(player.givenBack).toBe(1);
    expect(entryFor(KEY)).toBeUndefined();
  });

  it('releases a single-holder player as soon as that holder lets go', () => {
    const only = acquire(KEY, SOURCE);
    const player = only.player as unknown as FakePlayer;

    expect(player.givenBack).toBe(0);
    only.release();

    expect(player.givenBack).toBe(1);
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
    expect(player.givenBack).toBe(0);

    leases[2].release();
    expect(player.givenBack).toBe(1);
  });

  it('lets a key be acquired again after it was fully released, from a clean entry', () => {
    const first = acquire(KEY, SOURCE);
    first.release();
    expect(entryFor(KEY)).toBeUndefined();

    const second = acquire(KEY, SOURCE);

    // A stranded entry would be the leak's quiet form: the key survives with
    // a dead player and every later video for that media is unplayable.
    expect(entryFor(KEY).refCount).toBe(1);
    expect((second.player as unknown as FakePlayer).destroyed).toBe(false);
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
    expect(player.givenBack).toBe(0);
    expect(entryFor(KEY).refCount).toBe(1);

    second.release();
    expect(player.givenBack).toBe(1);
  });

  it('does not release the player twice when the last lease is released twice', () => {
    const only = acquire(KEY, SOURCE);
    const player = only.player as unknown as FakePlayer;

    only.release();
    only.release();

    expect(player.givenBack).toBe(1);
  });

  it('survives a lease released after the registry was reset', () => {
    const only = acquire(KEY, SOURCE);
    const player = only.player as unknown as FakePlayer;

    __resetVideoPlayerRegistry();
    expect(player.givenBack).toBe(1);

    expect(() => only.release()).not.toThrow();
    expect(player.givenBack).toBe(1);
  });
});

describe('a player whose release throws', () => {
  it('reports it and still drops the entry, so the key is not stranded', () => {
    // Fill the park, so the last release below destroys rather than parks.
    const parked = [videoPlayerKey('p', 'a'), videoPlayerKey('p', 'b')].map((k) =>
      acquire(k, SOURCE),
    );
    const only = acquire(KEY, SOURCE);
    for (const lease of parked) lease.release();
    mockVideo.releaseThrows = true;

    expect(() => only.release()).not.toThrow();
    expect(entryFor(KEY)).toBeUndefined();
    expect(mockError).toHaveBeenCalledWith('Releasing a video player threw', expect.any(Error), {
      key: KEY,
    });

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

describe('reaching the registry from outside a component', () => {
  it('acquires the same player the store action does, and counts it', () => {
    const first = acquireVideoPlayer(KEY, SOURCE);
    const second = acquireVideoPlayer(KEY, SOURCE);

    expect(second.player).toBe(first.player);
    expect(entryFor(KEY).refCount).toBe(2);
    expect(mockVideo.created).toHaveLength(1);
  });

  it('peeks without taking a reference', () => {
    // The distinction the whole read exists for: a tap handler asking what
    // the row under the finger is playing must not become a holder of it,
    // or the player would outlive every surface by one.
    const only = acquireVideoPlayer(KEY, SOURCE);

    expect(peekVideoPlayer(KEY)).toBe(only.player);
    expect(entryFor(KEY).refCount).toBe(1);

    only.release();
    expect(entryFor(KEY)).toBeUndefined();
  });

  it('peeks null for a key nobody holds', () => {
    expect(peekVideoPlayer(KEY)).toBeNull();
  });
});

describe('useVideoPlayerLease', () => {
  /** Minimal host: the hook's whole contract is what it returns and when it lets go. */
  function Surface({ id, source }: { id: VideoPlayerKey; source: string }) {
    seen.push(useVideoPlayerLease(id, source) as unknown as FakePlayer);
    return null;
  }
  let seen: FakePlayer[] = [];
  beforeEach(() => {
    seen = [];
  });

  it('hands the player back on the FIRST render, not a commit later', () => {
    // A surface that mounted without a player and adopted one afterwards
    // would restart the video at the moment this exists to make seamless.
    TestRenderer.act(() => {
      TestRenderer.create(React.createElement(Surface, { id: KEY, source: SOURCE }));
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(entryFor(KEY).player);
  });

  it('keeps the same player across re-renders and releases on unmount', () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;
    TestRenderer.act(() => {
      tree = TestRenderer.create(React.createElement(Surface, { id: KEY, source: SOURCE }));
    });
    const player = seen[0];
    TestRenderer.act(() => {
      tree!.update(React.createElement(Surface, { id: KEY, source: SOURCE }));
    });

    expect(seen[1]).toBe(player);
    expect(player.givenBack).toBe(0);

    TestRenderer.act(() => {
      tree!.unmount();
    });
    expect(player.givenBack).toBe(1);
    expect(entryFor(KEY)).toBeUndefined();
  });

  it('lets two surfaces share one player, and the first to go does not take it', () => {
    // This is the hand-off in miniature: the feed row and the reel slide are
    // both mounted for a moment, and the origin unmounting must not free the
    // decoder the destination is rendering.
    let feed: TestRenderer.ReactTestRenderer | null = null;
    let reel: TestRenderer.ReactTestRenderer | null = null;
    TestRenderer.act(() => {
      feed = TestRenderer.create(React.createElement(Surface, { id: KEY, source: SOURCE }));
    });
    TestRenderer.act(() => {
      reel = TestRenderer.create(React.createElement(Surface, { id: KEY, source: SOURCE }));
    });

    const player = seen[0];
    expect(seen[1]).toBe(player);
    expect(mockVideo.created).toHaveLength(1);
    expect(entryFor(KEY).refCount).toBe(2);

    TestRenderer.act(() => {
      feed!.unmount();
    });
    expect(player.givenBack).toBe(0);
    expect(entryFor(KEY).refCount).toBe(1);

    TestRenderer.act(() => {
      reel!.unmount();
    });
    expect(player.givenBack).toBe(1);
  });
});

describe('holding a player across a route change', () => {
  /** The gap this exists for, as the sequence that produced it. */
  it('survives the origin unmounting before the destination mounts', () => {
    const feed = acquireVideoPlayer(KEY, SOURCE);
    const player = feed.player as unknown as FakePlayer;

    holdAcrossTransition(KEY, SOURCE); // the tap
    feed.release(); // the origin route unmounts

    // Without the hold this is where the count reached zero and the player
    // was destroyed, so the destination built a fresh one starting at 0.
    expect(player.givenBack).toBe(0);
    expect(entryFor(KEY).refCount).toBe(1);

    const reel = acquireVideoPlayer(KEY, SOURCE);
    expect(reel.player).toBe(feed.player);
    expect(mockVideo.created).toHaveLength(1);
  });

  it('is let go once a real owner has one, and never through zero', () => {
    holdAcrossTransition(KEY, SOURCE);
    const player = entryFor(KEY).player as unknown as FakePlayer;

    const owner = acquireVideoPlayer(KEY, SOURCE);
    releaseTransitionHold(KEY);

    expect(entryFor(KEY).refCount).toBe(1);
    expect(player.givenBack).toBe(0);

    owner.release();
    expect(player.givenBack).toBe(1);
  });

  it('holds at most one, so a hand-off that never lands strands one player', () => {
    holdAcrossTransition(KEY, SOURCE);
    const first = entryFor(KEY).player as unknown as FakePlayer;

    holdAcrossTransition(OTHER_KEY, 'https://cdn.example/two.m3u8');

    // The previous hold is spent by the new one: a transition is a single
    // user action, so two live holds would mean a decoder nobody will free.
    expect(first.givenBack).toBe(1);
    expect(entryFor(KEY)).toBeUndefined();
    expect(entryFor(OTHER_KEY).refCount).toBe(1);
  });

  it('ignores a release for a key it is not holding', () => {
    holdAcrossTransition(KEY, SOURCE);
    releaseTransitionHold(OTHER_KEY);

    expect(entryFor(KEY).refCount).toBe(1);
  });

  it('re-holding the same key does not stack references', () => {
    holdAcrossTransition(KEY, SOURCE);
    holdAcrossTransition(KEY, SOURCE);

    expect(entryFor(KEY).refCount).toBe(1);
  });
});

describe('cancelled handoff', () => {
  it('releases the bridge while the mounted flight view keeps the decoder alive', () => {
    const origin = acquire(KEY, SOURCE);
    const view = acquire(KEY, SOURCE);
    const cancel = holdAcrossTransition(KEY, SOURCE);
    origin.release();
    expect(cancel()).toBe(true);
    expect(cancel()).toBe(false);
    expect(entryFor(KEY).refCount).toBe(1);
    expect(mockVideo.created[0].givenBack).toBe(0);
    view.release();
    expect(entryFor(KEY)).toBeUndefined();
    expect(mockVideo.created[0].givenBack).toBe(1);
  });

  it('does not let an old navigation cancel a newer bridge for the same media', () => {
    holdAcrossTransition(KEY, SOURCE);
    const old = pendingVideoTransition('post-1');
    expect(pendingVideoTransition('unrelated')).toBeNull();
    const cancel = holdAcrossTransition(KEY, SOURCE);
    expect(old?.release()).toBe(false);
    expect(entryFor(KEY).refCount).toBe(1);
    expect(cancel()).toBe(true);
    expect(entryFor(KEY)).toBeUndefined();
  });

  it('makes cancellation inert after a destination has acquired its lease', () => {
    const cancel = holdAcrossTransition(KEY, SOURCE);
    const destination = acquire(KEY, SOURCE);
    releaseTransitionHold(KEY);
    expect(cancel()).toBe(false);
    expect(entryFor(KEY).refCount).toBe(1);
    destination.release();
    expect(entryFor(KEY)).toBeUndefined();
  });
});

it('retires a superseded flight, but preserves the flight when the same media is retapped', () => {
  const retiredFirst = jest.fn();
  const retiredSecond = jest.fn();
  holdAcrossTransition(KEY, SOURCE, retiredFirst);
  holdAcrossTransition(KEY, SOURCE, retiredSecond);
  expect(retiredFirst).not.toHaveBeenCalled();
  holdAcrossTransition(OTHER_KEY, SOURCE);
  expect(retiredSecond).toHaveBeenCalledTimes(1);
  expect(entryFor(KEY)).toBeUndefined();
  expect(entryFor(OTHER_KEY).refCount).toBe(1);
});

it('cancels the captured pending transition exactly once and clears its lookup', () => {
  expect(pendingVideoTransition('post-1')).toBeNull();
  holdAcrossTransition(KEY, SOURCE);
  const pending = pendingVideoTransition('post-1');
  expect(pending?.key).toBe(KEY);
  expect(pending?.release()).toBe(true);
  expect(entryFor(KEY)).toBeUndefined();
  expect(mockVideo.created[0].givenBack).toBe(1);
  expect(pending?.release()).toBe(false);
  expect(pendingVideoTransition('post-1')).toBeNull();
});

describe('the parking pool', () => {
  const keys = ['a', 'b', 'c'].map((media) => videoPlayerKey('pool', media));
  const fake = (lease: { player: unknown }) => lease.player as unknown as FakePlayer;

  it('empties a player nobody holds and hands it to the next video instead of building one', () => {
    const first = acquire(keys[0], SOURCE);
    fake(first).muted = false;
    first.release();

    // Emptied, paused and silenced: no download, no decoder, no stray audio.
    expect(fake(first).destroyed).toBe(false);
    expect(fake(first).replacedWith).toEqual([null]);
    expect(fake(first).pause).toHaveBeenCalled();
    expect(fake(first)).toMatchObject({ muted: true, loop: false, timeUpdateEventInterval: 0 });

    const next = acquire(keys[1], 'https://cdn.example/two.mp4');
    expect(next.player).toBe(first.player);
    expect(mockVideo.created).toHaveLength(1);
    expect(fake(next).replacedWith.at(-1)).toBe('https://cdn.example/two.mp4');
  });

  it('keeps at most two waiting, and destroys the third', () => {
    const leases = keys.map((key) => acquire(key, SOURCE));
    for (const lease of leases) lease.release();

    expect(leases.map((lease) => fake(lease).destroyed)).toEqual([false, false, true]);
  });

  it('gives a parked player back the full forward buffer a preloading reel slide shortened', () => {
    const first = acquire(keys[0], SOURCE);
    fake(first).bufferOptions = { preferredForwardBufferDuration: 3, minBufferForPlayback: 1 };
    first.release();
    expect(fake(first).bufferOptions).toEqual({
      preferredForwardBufferDuration: 10,
      minBufferForPlayback: 1,
    });
  });

  it('builds every new player with the bounded forward buffer', () => {
    expect(fake(acquire(keys[0], SOURCE)).bufferOptions).toEqual({
      preferredForwardBufferDuration: 10,
      minBufferForPlayback: 1,
    });
  });

  it('destroys the parked players on reset', () => {
    const lease = acquire(keys[0], SOURCE);
    lease.release();
    __resetVideoPlayerRegistry();
    expect(fake(lease).destroyed).toBe(true);
  });
});

describe('useAttachedVideoPlayer', () => {
  let seen: (FakePlayer | null)[] = [];
  function Row({ attached }: { attached: boolean }) {
    seen.push(useAttachedVideoPlayer(KEY, SOURCE, attached) as unknown as FakePlayer | null);
    return null;
  }
  beforeEach(() => {
    seen = [];
  });

  it('has the player in its first render when it mounts attached', () => {
    TestRenderer.act(() => {
      TestRenderer.create(React.createElement(Row, { attached: true }));
    });
    expect(seen[0]).toBe(entryFor(KEY).player);
    expect(entryFor(KEY).refCount).toBe(1);
  });

  it('holds nothing while detached, then attaches and gives back without remounting', () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;
    TestRenderer.act(() => {
      tree = TestRenderer.create(React.createElement(Row, { attached: false }));
    });
    expect(seen.at(-1)).toBeNull();
    expect(entryFor(KEY)).toBeUndefined();

    TestRenderer.act(() => {
      tree!.update(React.createElement(Row, { attached: true }));
    });
    const player = seen.at(-1);
    expect(player).toBe(entryFor(KEY).player);
    expect(entryFor(KEY).refCount).toBe(1);

    TestRenderer.act(() => {
      tree!.update(React.createElement(Row, { attached: false }));
    });
    expect(seen.at(-1)).toBeNull();
    expect(entryFor(KEY)).toBeUndefined();
    expect(player?.givenBack).toBe(1);

    TestRenderer.act(() => {
      tree!.unmount();
    });
    expect(player?.givenBack).toBe(1);
  });
});
