import BuiltVideoPlayer from 'expo-video/build/VideoPlayer.web';

// Load the real Metro source with the package's published web declaration.
// Importing its raw TypeScript types pulls upstream DOM/Node timer conflicts
// into Mention's type check; the runtime module still passes through Jest.
const SourceVideoPlayer = jest.requireActual<
  typeof import('expo-video/build/VideoPlayer.web')
>('expo-video/src/VideoPlayer.web').default;

type Player = Pick<BuiltVideoPlayer,
  'play' | 'replay' | 'replace' | 'replaceAsync' | 'mountVideoView' | 'unmountVideoView'
>;
type PlaybackOperation = (player: Player, video: HTMLVideoElement) => void | Promise<void>;

function videoElement(): HTMLVideoElement {
  // Only the DOM boundary is simulated. The installed Expo player, mounting,
  // event handlers and promise rejection handler all run unchanged.
  return {
    paused: true,
    currentTime: 8,
    volume: 1,
    muted: false,
    playbackRate: 1,
    play: jest.fn(() => Promise.resolve()),
    pause: jest.fn(),
    load: jest.fn(),
    setAttribute: jest.fn(),
    removeAttribute: jest.fn(),
  } as unknown as HTMLVideoElement;
}

const operations: [string, PlaybackOperation][] = [
  ['play', (player) => player.play()],
  ['replay', (player) => player.replay()],
  ['replace', (player) => player.replace('/replacement.mp4')],
  ['replaceAsync', (player) => player.replaceAsync('/replacement.mp4')],
  ['mount synchronization', (player, video) => {
    player.unmountVideoView(video);
    const first = videoElement();
    player.mountVideoView(first);
    Object.defineProperty(first, 'paused', { value: false });
    player.mountVideoView(video);
  }],
  ['play event synchronization', (player) => {
    const first = videoElement();
    player.mountVideoView(first);
    const event = { target: first } as unknown as Event;
    first.onplay?.call(first, event);
  }],
];

// Metro consumes src while consumers resolving the compiled entrypoint consume
// build. Both must retain the fix after a frozen dependency installation.
describe.each([
  ['source', SourceVideoPlayer],
  ['build', BuiltVideoPlayer],
] as const)('installed expo-video web player (%s)', (_label, VideoPlayer) => {
  it.each(operations)('%s consumes a browser playback cancellation', async (_name, operate) => {
    const player = new VideoPlayer('/original.mp4');
    const video = videoElement();
    player.mountVideoView(video);
    const cancellation = new DOMException('The play request was interrupted', 'AbortError');
    const pending = Promise.reject(cancellation);
    // Observe the original promise so removing the patch fails at the missing
    // handler assertion, instead of crashing Jest with an unhandled rejection.
    void pending.catch(() => undefined);
    const catchSpy = jest.spyOn(pending, 'catch');
    jest.mocked(video.play).mockReturnValueOnce(pending);

    const operation = operate(player, video);

    expect(video.play).toHaveBeenCalledTimes(1);
    expect(catchSpy).toHaveBeenCalledTimes(1);
    await expect(catchSpy.mock.results[0].value).resolves.toBeUndefined();
    await operation;
  });

  it.each([
    ['autoplay rejection', () => new DOMException('Autoplay is forbidden', 'NotAllowedError')],
    ['ordinary error', () => new Error('Playback implementation failed')],
    ['non-DOM AbortError', () => Object.assign(new Error('Unrelated error'), { name: 'AbortError' })],
  ] as const)('keeps %s observable', async (_name, makeFailure) => {
    const failure = makeFailure();
    const player = new VideoPlayer('/original.mp4');
    const video = videoElement();
    player.mountVideoView(video);
    const pending = Promise.reject(failure);
    void pending.catch(() => undefined);
    const catchSpy = jest.spyOn(pending, 'catch');
    jest.mocked(video.play).mockReturnValueOnce(pending);

    player.play();

    expect(catchSpy).toHaveBeenCalledTimes(1);
    await expect(catchSpy.mock.results[0].value).rejects.toBe(failure);
  });
});
