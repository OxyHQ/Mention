import TestRenderer, { act } from 'react-test-renderer';
import { PlayButton } from '@oxy.so/bloom/media-controls';
import VideoPlayer from '../VideoPlayer';

type Listener = (payload: { isPlaying: boolean }) => void;
const mockListeners = new Map<string, Set<Listener>>();
const mockPlaybackReads = jest.fn();
const mockToggleMuted = jest.fn();
const mockPlayer = {
  playing: false,
  muted: false,
  loop: false,
  currentTime: 0,
  duration: 0,
  timeUpdateEventInterval: 0,
  play: jest.fn(),
  pause: jest.fn(),
  addListener(event: string, listener: Listener) {
    const listeners = mockListeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    mockListeners.set(event, listeners);
    return { remove: () => listeners.delete(listener) };
  },
};

const mockUseVideoPlayer = jest.fn(() => mockPlayer);
jest.mock('expo-video', () => ({
  useVideoPlayer: () => mockUseVideoPlayer(),
}));
jest.mock('expo', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const useEventListener = (player: typeof mockPlayer, event: string, listener: Listener) => {
    const current = React.useRef(listener);
    current.current = listener;
    React.useEffect(() => {
      const subscription = player.addListener(event, (value) => current.current(value));
      return () => {
        subscription.remove();
      };
    }, [player, event]);
  };
  return {
    useEventListener,
    useEvent: (player: typeof mockPlayer, event: string, initial: { isPlaying: boolean }) => {
      const [state, setState] = React.useState(initial);
      useEventListener(player, event, setState);
      return state;
    },
  };
});
jest.mock('@oxy.so/bloom/styles', () => ({ tokens: { hitSlop: { md: 8 } } }));
jest.mock('@oxy.so/bloom/media-controls', () => ({ PlayButton: () => null }));
jest.mock('@oxy.so/bloom/media-flight', () => ({ MediaFlightHost: () => null }));
jest.mock('@oxy.so/bloom/video-playback', () => ({
  useVideoPlayback: () => {
    mockPlaybackReads();
    return { shouldPlay: true, claimActive: jest.fn() };
  },
  // A painted frame once a player is attached; none before.
  useVideoPlaybackControl: (player: unknown) => player !== null,
}));
jest.mock('@oxy.so/bloom/icons', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    RiExpandDiagonalSLine: () => null,
    RiVolumeMuteLine: function MuteIcon() {
      React.useEffect(() => {
        mockMounts.muteIcon += 1;
      }, []);
      return null;
    },
    RiVolumeUpLine: () => null,
  };
});
// Counts mounts, so a remount on attach or detach shows up as a second one.
const mockMounts = { poster: 0, muteIcon: 0 };
jest.mock('expo-image', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    Image: function Poster() {
      React.useEffect(() => {
        mockMounts.poster += 1;
      }, []);
      return null;
    },
  };
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@/stores/videoMuteStore', () => ({
  useVideoMuteStore: (
    selector: (state: { isMuted: boolean; toggleMuted: typeof mockToggleMuted }) => unknown,
  ) => selector({ isMuted: true, toggleMuted: mockToggleMuted }),
}));
jest.mock('../PlaybackVideoView', () => ({ PlaybackVideoView: () => null }));
jest.mock('@/lib/hlsPlayback', () => ({ needsJsHlsDecoder: () => false }));

const SOURCE = 'https://media.example.test/video.mp4';
const emitPlaying = (isPlaying: boolean) => {
  mockPlayer.playing = isPlaying;
  act(() => {
    for (const listener of mockListeners.get('playingChange') ?? []) listener({ isPlaying });
  });
};

beforeEach(() => {
  jest.useFakeTimers();
  mockListeners.clear();
  mockPlayer.playing = false;
  mockPlayer.play.mockClear();
  mockPlayer.pause.mockClear();
  mockPlaybackReads.mockClear();
  mockUseVideoPlayer.mockClear();
});

// On Android every expo-video player builds an ExoPlayer whatever its source,
// so a surface handed a player (a feed row's registry lease) must build none.
it('builds a player only for a surface that owns its video', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <VideoPlayer src={SOURCE} player={mockPlayer as never} onPress={jest.fn()} />,
    );
  });
  expect(mockUseVideoPlayer).not.toHaveBeenCalled();
  act(() => renderer.update(<VideoPlayer src={SOURCE} onPress={jest.fn()} />));
  expect(mockUseVideoPlayer).toHaveBeenCalled();
  act(() => renderer.unmount());
});
afterEach(() => {
  jest.useRealTimers();
});

// A feed row outside its list's preload window holds no player. It must look
// exactly as it does before a first frame (poster, mute button), and the pool
// attaching a player must not remount either: a remounted poster fades in again.
it('a lent surface keeps its poster and mute button through attach and detach', () => {
  const { Image } = jest.requireMock<{ Image: React.FC }>('expo-image');
  mockMounts.poster = 0;
  mockMounts.muteIcon = 0;
  let renderer!: TestRenderer.ReactTestRenderer;
  const at = (player: unknown) => (
    <VideoPlayer
      src={SOURCE}
      poster="https://media.example.test/poster.jpg"
      player={player as never}
      onPress={jest.fn()}
    />
  );
  act(() => {
    renderer = TestRenderer.create(at(null));
  });
  // Detached: the poster and the mute button, and no player listened to or built.
  expect(renderer.root.findAllByType(Image)).toHaveLength(1);
  expect(mockMounts).toEqual({ poster: 1, muteIcon: 1 });
  expect(mockUseVideoPlayer).not.toHaveBeenCalled();
  expect(mockListeners.size).toBe(0);

  // Attached: its frame is painted, so the poster goes; the button stays put.
  act(() => renderer.update(at(mockPlayer)));
  expect(renderer.root.findAllByType(Image)).toHaveLength(0);
  expect(mockMounts.muteIcon).toBe(1);
  expect(mockListeners.get('playingChange')?.size).toBe(1);

  // Detached again: the listeners go with the player, the button never moved.
  act(() => renderer.update(at(null)));
  expect(renderer.root.findAllByType(Image)).toHaveLength(1);
  expect(mockMounts.muteIcon).toBe(1);
  expect(mockListeners.get('playingChange')?.size).toBe(0);
  act(() => renderer.unmount());
});

it.each(['preview', 'gif'] as const)(
  '%s playback does not create a hidden-controls timer or later re-render',
  (mode) => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <VideoPlayer
          src={SOURCE}
          {...(mode === 'preview' ? { onPress: jest.fn() } : { gif: true })}
        />,
      );
    });
    try {
      const baselineTimers = jest.getTimerCount();
      emitPlaying(true);
      const rendersAfterPlaying = mockPlaybackReads.mock.calls.length;
      expect(jest.getTimerCount()).toBe(baselineTimers);
      act(() => jest.advanceTimersByTime(3000));
      expect(mockPlaybackReads).toHaveBeenCalledTimes(rendersAfterPlaying);
    } finally {
      act(() => renderer.unmount());
    }
  },
);

it.each(['preview', 'gif'] as const)(
  'full controls hide while playing and switching to %s cancels the timer',
  (mode) => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<VideoPlayer src={SOURCE} />);
    });
    try {
      const baselineTimers = jest.getTimerCount();
      expect(renderer.root.findAllByType(PlayButton)).toHaveLength(1);
      emitPlaying(true);
      expect(jest.getTimerCount()).toBe(baselineTimers + 1);
      act(() => jest.advanceTimersByTime(1000));
      emitPlaying(false);
      emitPlaying(true);
      expect(jest.getTimerCount()).toBe(baselineTimers + 1);
      act(() => jest.advanceTimersByTime(2999));
      expect(renderer.root.findAllByType(PlayButton)).toHaveLength(1);
      act(() => jest.advanceTimersByTime(1));
      expect(renderer.root.findAllByType(PlayButton)).toHaveLength(0);

      const pressTargets = renderer.root.findAll(
        (node) => typeof node.props.onPress === 'function',
      );
      expect(pressTargets.length).toBeGreaterThan(0);
      act(() => pressTargets[pressTargets.length - 1]?.props.onPress());
      expect(renderer.root.findAllByType(PlayButton)).toHaveLength(1);
      expect(jest.getTimerCount()).toBe(baselineTimers + 1);
      act(() => jest.advanceTimersByTime(3000));
      expect(renderer.root.findAllByType(PlayButton)).toHaveLength(0);

      emitPlaying(false);
      emitPlaying(true);
      expect(jest.getTimerCount()).toBe(baselineTimers + 1);
      act(() =>
        renderer.update(
          <VideoPlayer
            src={SOURCE}
            {...(mode === 'preview' ? { onPress: jest.fn() } : { gif: true })}
          />,
        ),
      );
      expect(jest.getTimerCount()).toBe(baselineTimers);
    } finally {
      act(() => renderer.unmount());
    }
  },
);

it('pausing cancels the hide timer and resuming schedules only one', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<VideoPlayer src={SOURCE} />);
  });
  try {
    const baselineTimers = jest.getTimerCount();
    emitPlaying(true);
    expect(jest.getTimerCount()).toBe(baselineTimers + 1);
    act(() => renderer.root.findByType(PlayButton).props.onPress());
    expect(mockPlayer.pause).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(baselineTimers);
    emitPlaying(false);
    act(() => renderer.root.findByType(PlayButton).props.onPress());
    expect(mockPlayer.play).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(baselineTimers + 1);
    emitPlaying(true);
    expect(jest.getTimerCount()).toBe(baselineTimers + 1);
  } finally {
    act(() => renderer.unmount());
  }
});

it('an external pause preserves the already scheduled controls deadline', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<VideoPlayer src={SOURCE} />);
  });
  try {
    const baselineTimers = jest.getTimerCount();
    emitPlaying(true);
    act(() => jest.advanceTimersByTime(1000));
    emitPlaying(false);
    expect(jest.getTimerCount()).toBe(baselineTimers + 1);
    act(() => jest.advanceTimersByTime(2000));
    expect(renderer.root.findAllByType(PlayButton)).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(baselineTimers);
  } finally {
    act(() => renderer.unmount());
  }
});

it('clears a pending hide timer on unmount', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<VideoPlayer src={SOURCE} />);
  });
  const baselineTimers = jest.getTimerCount();
  emitPlaying(true);
  expect(jest.getTimerCount()).toBe(baselineTimers + 1);
  act(() => renderer.unmount());
  expect(jest.getTimerCount()).toBe(baselineTimers);
});

it.each(['preview', 'gif'] as const)(
  'entering full controls from a playing %s starts a fresh hide timer',
  (mode) => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <VideoPlayer
          src={SOURCE}
          {...(mode === 'preview' ? { onPress: jest.fn() } : { gif: true })}
        />,
      );
    });
    try {
      emitPlaying(true);
      act(() => jest.advanceTimersByTime(2500));
      act(() => renderer.update(<VideoPlayer src={SOURCE} />));
      expect(renderer.root.findAllByType(PlayButton)).toHaveLength(1);
      act(() => jest.advanceTimersByTime(500));
      expect(renderer.root.findAllByType(PlayButton)).toHaveLength(1);
      act(() => jest.advanceTimersByTime(2500));
      expect(renderer.root.findAllByType(PlayButton)).toHaveLength(0);
    } finally {
      act(() => renderer.unmount());
    }
  },
);
