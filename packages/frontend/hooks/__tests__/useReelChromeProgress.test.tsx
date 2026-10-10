import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * The reel's playhead lives in a shared value, not React state: `timeUpdate`
 * fires four times a second, and as state every tick re-rendered the whole
 * slide overlay just to move a 2px bar. These pin what the listener writes, and
 * that the buffer-ahead report and the event cadence it rides on still work.
 */

type Listener = (payload: Record<string, unknown>) => void;
const mockListeners = new Map<string, Listener>();

jest.mock('react-native-reanimated', () => ({
  // One object per mount, like the real hook — a new one per render would
  // reset the playhead the test is reading back.
  useSharedValue: (value: unknown) => {
    const { useState } = jest.requireActual<typeof import('react')>('react');
    const [shared] = useState(() => {
      const created = {
        value,
        get: () => created.value,
        set: (next: unknown) => {
          created.value = next;
        },
      };
      return created;
    });
    return shared;
  },
  // Evaluated on every call so a re-render reads the current value.
  useAnimatedStyle: (worklet: () => unknown) => worklet(),
  withSequence: (...args: unknown[]) => args[0],
  withTiming: (value: unknown) => value,
}));
jest.mock('expo', () => ({
  useEventListener: (_player: unknown, event: string, listener: Listener) => {
    mockListeners.set(event, listener);
  },
}));
jest.mock('expo-video', () => ({ VideoView: () => null }));
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => {}),
  deactivateKeepAwake: jest.fn(async () => {}),
}));
jest.mock('@oxy.so/core/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));
jest.mock('@/context/VideoPlaybackContext', () => ({
  useVideoPlayback: () => ({
    shouldPlay: true,
    claimActive: () => {},
    reportVisibility: () => {},
  }),
}));
jest.mock('@/hooks/usePipAspectRatio', () => ({ usePipAspectRatio: () => undefined }));

import { REEL_TIME_UPDATE_INTERVAL_S, useReelChrome } from '../useReelChrome';

function fakePlayer(duration: number) {
  return {
    currentTime: 0,
    loop: true,
    muted: true,
    playing: false,
    status: 'readyToPlay' as const,
    timeUpdateEventInterval: 0,
    duration,
    bufferedPosition: 0,
    play: jest.fn(),
    pause: jest.fn(),
    seekBy: jest.fn(),
    replaceAsync: jest.fn(async () => {}),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    removeListener: jest.fn(),
  };
}

let latest: { progressStyle: { width?: string } } | null = null;

function Harness({
  player,
  onBufferAhead,
  initialDurationSec,
}: {
  player: object;
  onBufferAhead?: (seconds: number) => void;
  initialDurationSec?: number;
}) {
  latest = useReelChrome({
    player,
    restartOnActivate: true,
    postId: 'post-1',
    videoUrl: 'https://example.test/clip.mp4',
    posterUrl: undefined,
    initialDurationSec,
    isActive: true,
    onBufferAhead,
    screenFocused: true,
    windowHeight: 800,
    muted: true,
    onMutedChange: () => {},
    onError: () => {},
    t: ((key: string) => key) as never,
    isLiked: false,
    onLikePost: () => {},
    ownsSession: false,
    sessionActive: false,
    sessionSource: undefined,
    onSessionStart: () => {},
    onSessionEnd: () => {},
    onRegisterTransportSeek: () => () => {},
  } as never) as never;
  return null;
}

function mount(props: React.ComponentProps<typeof Harness>) {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    renderer = TestRenderer.create(<Harness {...props} />);
  });
  return renderer as unknown as TestRenderer.ReactTestRenderer;
}

function tick(currentTime: number) {
  act(() => {
    mockListeners.get('timeUpdate')?.({ currentTime });
  });
}

beforeEach(() => {
  mockListeners.clear();
  latest = null;
});

describe('the reel playhead', () => {
  it('raises an adopted player to the reel cadence, so the scrubber has events to follow', () => {
    const player = fakePlayer(20);
    mount({ player });
    expect(player.timeUpdateEventInterval).toBe(REEL_TIME_UPDATE_INTERVAL_S);
  });

  it('measures progress against the known duration', () => {
    const player = fakePlayer(0);
    const renderer = mount({ player, initialDurationSec: 40 });
    tick(10);
    // The style is derived from the shared value; re-render to read it back.
    act(() => renderer.update(<Harness player={player} initialDurationSec={40} />));
    expect(latest?.progressStyle.width).toBe('25%');
  });

  it('falls back to the player duration, and shows nothing when neither is known', () => {
    const withPlayerDuration = fakePlayer(50);
    const first = mount({ player: withPlayerDuration });
    tick(25);
    act(() => first.update(<Harness player={withPlayerDuration} />));
    expect(latest?.progressStyle.width).toBe('50%');

    const unknown = fakePlayer(0);
    const second = mount({ player: unknown });
    tick(5);
    act(() => second.update(<Harness player={unknown} />));
    expect(latest?.progressStyle.width).toBe('0%');
  });

  it('reports how much is buffered ahead of the playhead', () => {
    const player = fakePlayer(30);
    player.bufferedPosition = 12;
    const onBufferAhead = jest.fn();
    mount({ player, onBufferAhead });
    tick(4);
    expect(onBufferAhead).toHaveBeenCalledWith(8);
  });
});
