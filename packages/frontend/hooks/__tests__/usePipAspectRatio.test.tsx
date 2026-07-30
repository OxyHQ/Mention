import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { resolvePipAspectSize, usePipAspectRatio } from '../usePipAspectRatio';

/**
 * The JS half of the Android Picture-in-Picture aspect ratio: which size the OS
 * window is told about, when it is told, and what happens when the call fails.
 *
 * Nothing here says anything about Android. No `PictureInPictureParams`, no
 * `Rational` and no OS window is reachable from jest — the window's actual shape
 * needs a device build and a screenshot. What IS pinned is every decision made
 * before the native call: that a portrait size reaches it at all, that it is
 * re-issued PER VIDEO rather than once (the staleness half of the bug), that a
 * neighbour which is not being watched publishes nothing, and that a rejection is
 * reported rather than swallowed.
 */

// Prefixed `mock` so the hoisted `jest.mock` factories may reference it.
const mockNative = {
  calls: [] as { width: number; height: number }[],
  rejection: null as Error | null,
};

const mockWarn = jest.fn();

jest.mock('@/lib/logger', () => ({
  createScopedLogger: () => ({ warn: (...args: unknown[]) => mockWarn(...args) }),
}));

jest.mock('@/modules/pip-transport', () => ({
  setPipAspectRatio: (width: number, height: number) => {
    mockNative.calls.push({ width, height });
    return mockNative.rejection
      ? Promise.reject(mockNative.rejection)
      : Promise.resolve();
  },
}));

/**
 * `useEventListener` from `expo`, reduced to what this hook uses: it subscribes
 * once per player and always invokes the latest listener. The fake player below
 * keeps the listener so a test can fire a track change.
 */
jest.mock('expo', () => ({
  useEventListener: (
    player: FakePlayer,
    event: string,
    listener: (payload: { videoTrack: { size: { width: number; height: number } } | null }) => void,
  ) => {
    player.listeners[event] = listener;
  },
}));

interface FakePlayer {
  videoTrack: { size: { width: number; height: number } } | null;
  listeners: Record<string, ((payload: { videoTrack: FakePlayer['videoTrack'] }) => void) | undefined>;
}

function makePlayer(track: FakePlayer['videoTrack'] = null): FakePlayer {
  return { videoTrack: track, listeners: {} };
}

interface HarnessProps {
  player: FakePlayer;
  active: boolean;
  persistedSize?: { width: number; height: number };
  /** Whether the OS window is showing this surface's player. */
  sessionOwner?: boolean;
  postId?: string;
}

function Harness({ player, active, persistedSize, sessionOwner = false, postId = 'post-1' }: HarnessProps) {
  usePipAspectRatio({
    // The fake stands in for the parts of `VideoPlayer` this hook touches.
    player: player as unknown as Parameters<typeof usePipAspectRatio>[0]['player'],
    active,
    persistedSize,
    sessionOwner,
    postId,
  });
  return null;
}

function render(props: HarnessProps) {
  let tree: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    tree = TestRenderer.create(<Harness {...props} />);
  });
  return tree as unknown as TestRenderer.ReactTestRenderer;
}

beforeEach(() => {
  mockNative.calls = [];
  mockNative.rejection = null;
  mockWarn.mockClear();
});

// ── Which size wins ──────────────────────────────────────────────────────────

describe('resolvePipAspectSize', () => {
  it('prefers the playing track over what the feed persisted', () => {
    // The track is the truth about the decoded stream; the persisted value can be
    // stale or describe a different rendition.
    expect(resolvePipAspectSize({ width: 720, height: 1280 }, { width: 1080, height: 1920 }))
      .toEqual({ width: 720, height: 1280 });
  });

  it('falls back to the persisted size, which is what makes the FIRST window right', () => {
    // Before playback there is no track, and that is exactly the moment expo-video
    // has nothing either — so this is the case the bug lives in.
    expect(resolvePipAspectSize(undefined, { width: 1080, height: 1920 }))
      .toEqual({ width: 1080, height: 1920 });
  });

  it('yields null when neither is known, so nothing is published', () => {
    // A zero or negative axis is rejected natively, so the caller must not send
    // one; `null` is how it declines rather than guessing 16:9.
    expect(resolvePipAspectSize(undefined, undefined)).toBeNull();
  });
});

// ── What reaches the window ──────────────────────────────────────────────────

describe('usePipAspectRatio', () => {
  it('publishes a portrait size for the watched surface', () => {
    render({ player: makePlayer({ size: { width: 720, height: 1280 } }), active: true });

    expect(mockNative.calls).toEqual([{ width: 720, height: 1280 }]);
  });

  it('publishes the persisted size before the player reports a track', () => {
    render({
      player: makePlayer(null),
      active: true,
      persistedSize: { width: 1080, height: 1920 },
    });

    expect(mockNative.calls).toEqual([{ width: 1080, height: 1920 }]);
  });

  it('publishes nothing for a surface that is not being watched', () => {
    // The params are activity-wide, so a preloading neighbour would be describing a
    // video nobody is looking at.
    render({ player: makePlayer({ size: { width: 720, height: 1280 } }), active: false });

    expect(mockNative.calls).toEqual([]);
  });

  it('re-publishes when the video changes — the staleness half of the bug', () => {
    const player = makePlayer({ size: { width: 720, height: 1280 } });
    render({ player, active: true });
    expect(mockNative.calls).toEqual([{ width: 720, height: 1280 }]);

    // A `replaceAsync` swap reports a new track. expo-video would keep the first
    // video's ratio here; this must not.
    act(() => {
      player.listeners.videoTrackChange?.({ videoTrack: { size: { width: 1920, height: 1080 } } });
    });

    expect(mockNative.calls).toEqual([
      { width: 720, height: 1280 },
      { width: 1920, height: 1080 },
    ]);
  });

  it('does not re-publish the same shape on a re-render', () => {
    const player = makePlayer({ size: { width: 720, height: 1280 } });
    const tree = render({ player, active: true });

    act(() => {
      tree.update(<Harness player={player} active postId="post-1" />);
    });

    expect(mockNative.calls).toHaveLength(1);
  });

  it('publishes when a surface becomes the watched one', () => {
    const player = makePlayer({ size: { width: 720, height: 1280 } });
    const tree = render({ player, active: false });
    expect(mockNative.calls).toEqual([]);

    act(() => {
      tree.update(<Harness player={player} active />);
    });

    expect(mockNative.calls).toEqual([{ width: 720, height: 1280 }]);
  });

  it('re-states the ratio when the OS window opens', () => {
    // expo-video's params are activity-wide and pushed by every mounted `VideoView`;
    // one whose own source load produced no usable size still carries
    // `PiPParams.aspectRatio`'s `Rational(16, 9)` default, which is in range and so
    // lands. Measured: a correctly-published 720x1280 sat 38 seconds while its
    // neighbours loaded and its window then opened at 1.7797 — landscape. Publishing
    // once when the size is known is therefore not enough; the window opening is a
    // second moment where the truth has to be restated.
    const player = makePlayer({ size: { width: 720, height: 1280 } });
    const tree = render({ player, active: true });
    expect(mockNative.calls).toEqual([{ width: 720, height: 1280 }]);

    act(() => {
      tree.update(<Harness player={player} active sessionOwner postId="post-1" />);
    });

    expect(mockNative.calls).toEqual([
      { width: 720, height: 1280 },
      { width: 720, height: 1280 },
    ]);
  });

  it('ignores a track that reports no usable size', () => {
    // What ExoPlayer reports before it has decoded a frame. Sending it would earn a
    // native rejection we can predict.
    const player = makePlayer({ size: { width: 0, height: 0 } });
    render({ player, active: true, persistedSize: { width: 1080, height: 1920 } });

    expect(mockNative.calls).toEqual([{ width: 1080, height: 1920 }]);
  });

  it('reports a rejection instead of swallowing it', async () => {
    // A rejection means the activity is not PiP-capable, which is the one thing
    // worth knowing here — and it is invisible in a screenshot of a window that
    // never opened.
    mockNative.rejection = new Error('not PiP-capable');
    render({ player: makePlayer({ size: { width: 720, height: 1280 } }), active: true });

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockWarn).toHaveBeenCalledWith(
      'Could not set the Picture-in-Picture aspect ratio',
      expect.objectContaining({ postId: 'post-1', width: 720, height: 1280 }),
    );
  });
});
