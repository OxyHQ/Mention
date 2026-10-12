import TestRenderer, { act } from 'react-test-renderer';

/**
 * A tap starts a video the browser refused to start.
 *
 * Production, 2026-10-10: on an iPhone in Low Power Mode, Safari refused every
 * autoplay (`NotAllowedError`) and left each reel on its first frame. Taps did
 * not help: the first one only unmuted, and the pause toggle landed after the
 * double-tap window through a state change and an effect — outside the gesture,
 * where Safari refuses a play() again. And nothing on screen said a tap would
 * start it. So: a tap on a video that is not playing calls play() inside the
 * tap, and the play affordance shows whenever the watched video is not playing.
 */

jest.mock('react-native-reanimated', () => ({
  useSharedValue: (value: unknown) => {
    const shared = {
      value,
      get: () => shared.value,
      set: (next: unknown) => {
        shared.value = next;
      },
    };
    return shared;
  },
  useAnimatedStyle: () => ({}),
  withSequence: (...args: unknown[]) => args[0],
  withTiming: (value: unknown) => value,
}));
// The real subscription contract, reduced to one listener per event: the test
// emits `playingChange` the way expo-video's web player does on play/pause.
jest.mock('expo', () => ({
  useEventListener: (
    player: { listeners?: Map<string, (payload: unknown) => void> },
    event: string,
    listener: (payload: unknown) => void,
  ) => {
    player.listeners?.set(event, listener);
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
  // The hook destructures `shouldPlay` (renamed `playbackAllowed`),
  // `claimActive` and `reportVisibility`; the last is called DURING render, so
  // it has to exist or the first commit throws.
  useVideoPlayback: () => ({
    shouldPlay: true,
    claimActive: () => {},
    reportVisibility: () => {},
  }),
}));
jest.mock('@/hooks/usePipAspectRatio', () => ({ usePipAspectRatio: () => undefined }));

import { useReelChrome } from '../useReelChrome';

function fakePlayer(playing: boolean) {
  const listeners = new Map<string, (payload: unknown) => void>();
  const player = {
    listeners,
    currentTime: 0,
    loop: true,
    muted: true,
    playing,
    status: 'readyToPlay' as const,
    timeUpdateEventInterval: 0,
    duration: 30,
    bufferedPosition: 0,
    play: jest.fn(),
    pause: jest.fn(),
    seekBy: jest.fn(),
    replaceAsync: jest.fn(async () => {}),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    removeListener: jest.fn(),
  };
  /** What expo-video's web player does on the element's play/pause events. */
  const emitPlaying = (isPlaying: boolean) => {
    player.playing = isPlaying;
    act(() => listeners.get('playingChange')?.({ isPlaying }));
  };
  return { player, emitPlaying };
}

type Chrome = ReturnType<typeof useReelChrome>;

function render(player: object, muted = true) {
  const result: { current?: Chrome } = {};
  function Harness() {
    result.current = useReelChrome({
      player,
      restartOnActivate: true,
      postId: 'post-1',
      videoUrl: 'https://example.test/clip.mp4',
      posterUrl: undefined,
      isActive: true,
      screenFocused: true,
      windowHeight: 800,
      muted,
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
    } as never);
    return null;
  }
  act(() => {
    TestRenderer.create(<Harness />);
  });
  return result as { current: Chrome };
}

describe('a refused autoplay', () => {
  it('is started by the tap itself, synchronously, even while muted', () => {
    const fake = fakePlayer(false);
    const chrome = render(fake.player);
    fake.player.play.mockClear();

    // No timers advanced: the play() has to happen inside the tap.
    chrome.current.handleSurfacePress();

    expect(fake.player.play).toHaveBeenCalledTimes(1);
  });

  it('shows the play affordance while the video is not playing, and drops it once it plays', () => {
    const fake = fakePlayer(false);
    const chrome = render(fake.player);

    expect(chrome.current.showPauseAffordance).toBe(true);

    fake.emitPlaying(true);
    expect(chrome.current.showPauseAffordance).toBe(false);
  });
});

describe('a video that is playing', () => {
  it('keeps the tap for joining the audio, not for play()', () => {
    const fake = fakePlayer(true);
    const chrome = render(fake.player);
    fake.player.play.mockClear();

    chrome.current.handleSurfacePress();

    expect(fake.player.play).not.toHaveBeenCalled();
    expect(chrome.current.showPauseAffordance).toBe(false);
  });
});
