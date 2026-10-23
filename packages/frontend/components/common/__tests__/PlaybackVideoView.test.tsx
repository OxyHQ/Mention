/** @jest-environment jsdom */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { VideoPlayer } from 'expo-video';
import type { VideoViewHandle } from '@oxy.so/bloom/video-view';
import { acquireVideoPlayer, videoPlayerKey } from '@/stores/videoPlayerRegistry';
import { PlaybackVideoView } from '../PlaybackVideoView';
import { useVideoPlaybackControl } from '@/stores/video-playback-control';

const mockAttached = jest.fn();
const mockDetached = jest.fn();
const mockViewHandle = { nativeRef: { current: null as HTMLVideoElement | null } };

jest.mock('@oxy.so/bloom/video-view', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    VideoView: React.forwardRef<VideoViewHandle>(function MockVideoView(_props, ref) {
      React.useImperativeHandle(ref, () => ({ ...mockViewHandle }) as unknown as VideoViewHandle);
      return null;
    }),
  };
});
// Decoder network I/O is covered in the browser gate. Here its lifetime is
// represented by a source-bound effect, while Expo's changing handle is real.
jest.mock('@/lib/hlsPlayback', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    needsJsHlsDecoder: (source: string) => source.endsWith('.m3u8'),
    useHlsPlayback: (source: string, viewRef: React.RefObject<VideoViewHandle | null>) => {
      React.useEffect(() => {
        if (!source.endsWith('.m3u8')) return;
        mockAttached(source);
        return () => mockDetached(source);
      }, [source]);
      return {
        active: source.endsWith('.m3u8'),
        ref: React.useCallback(
          (handle: VideoViewHandle | null) => {
            viewRef.current = handle;
          },
          [viewRef],
        ),
      };
    },
  };
});
const mockCreateVideoPlayer = jest.fn();
jest.mock('expo-video', () => ({
  createVideoPlayer: (...args: unknown[]) => mockCreateVideoPlayer(...args),
}));
jest.mock('expo', () => ({ useEventListener: jest.fn() }));
jest.mock('@oxy.so/core/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn() }),
}));

const STREAM = 'https://media.example/video.m3u8';
const FILE = 'https://media.example/video.mp4';

function makePlayer(status: string = 'readyToPlay') {
  return {
    status,
    play: jest.fn(),
    pause: jest.fn(),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    replaceAsync: jest.fn(async () => {}),
  };
}

function Presentation({
  player,
  source,
  viewRef,
  onSourceError,
}: {
  player: VideoPlayer;
  source: string;
  viewRef: React.RefObject<VideoViewHandle | null>;
  onSourceError?: () => void;
}) {
  const hasRendered = useVideoPlaybackControl(player, true);
  return (
    <>
      <PlaybackVideoView
        player={player}
        source={source}
        ref={viewRef}
        onSourceError={onSourceError}
      />
      <span>{hasRendered ? 'frame' : 'poster'}</span>
    </>
  );
}

async function mount(element: React.ReactElement) {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  if (!renderer) throw new Error('Renderer did not mount');
  return renderer;
}

beforeEach(() => {
  mockAttached.mockClear();
  mockDetached.mockClear();
  mockViewHandle.nativeRef.current = document.createElement('video');
});

it('preserves the HLS decoder and ready frame when the presenter hands the same view to the reel', async () => {
  const fake = makePlayer();
  const player = fake as unknown as VideoPlayer;
  const feedRef = React.createRef<VideoViewHandle>();
  const reelRef = React.createRef<VideoViewHandle>();
  const renderer = await mount(<Presentation player={player} source={STREAM} viewRef={feedRef} />);
  expect(mockAttached).toHaveBeenCalledTimes(1);
  expect(renderer.root.findByType('span').children).toEqual(['frame']);
  await act(async () => {
    renderer.update(<Presentation player={player} source={STREAM} viewRef={reelRef} />);
  });
  expect(feedRef.current).toBeNull();
  expect(reelRef.current?.nativeRef).toBe(mockViewHandle.nativeRef);
  expect(mockAttached).toHaveBeenCalledTimes(1);
  expect(mockDetached).not.toHaveBeenCalled();
  expect(fake.replaceAsync).not.toHaveBeenCalled();
  expect(renderer.root.findByType('span').children).toEqual(['frame']);
  await act(async () => {
    renderer.unmount();
  });
  expect(mockDetached).toHaveBeenCalledTimes(1);
});

it('clears a progressive source before attaching HLS, and detaches HLS before restoring progressive playback', async () => {
  const fake = makePlayer();
  const player = fake as unknown as VideoPlayer;
  const viewRef = React.createRef<VideoViewHandle>();
  const renderer = await mount(<Presentation player={player} source={FILE} viewRef={viewRef} />);
  await act(async () => {
    renderer.update(<Presentation player={player} source={STREAM} viewRef={viewRef} />);
  });
  expect(fake.replaceAsync).toHaveBeenCalledWith(null);
  expect(mockAttached).toHaveBeenCalledTimes(1);
  expect(fake.replaceAsync.mock.invocationCallOrder[0]).toBeLessThan(
    mockAttached.mock.invocationCallOrder[0],
  );
  await act(async () => {
    renderer.update(<Presentation player={player} source={FILE} viewRef={viewRef} />);
  });
  expect(fake.replaceAsync).toHaveBeenLastCalledWith(FILE);
  expect(mockDetached).toHaveBeenCalledTimes(1);
  expect(mockDetached.mock.invocationCallOrder[0]).toBeLessThan(
    fake.replaceAsync.mock.invocationCallOrder[1],
  );
  await act(async () => {
    renderer.unmount();
  });
});

for (const finalSource of [FILE, 'https://media.example/other.mp4']) {
  it(`serializes an in-flight replacement before restoring the latest source ${finalSource}`, async () => {
    let finishReplacement: (() => void) | undefined;
    const firstReplacement = new Promise<void>((resolve) => {
      finishReplacement = resolve;
    });
    const fake = makePlayer();
    fake.replaceAsync.mockImplementationOnce(() => firstReplacement);
    const player = fake as unknown as VideoPlayer;
    const viewRef = React.createRef<VideoViewHandle>();
    const renderer = await mount(<Presentation player={player} source={FILE} viewRef={viewRef} />);
    await act(async () => {
      renderer.update(<Presentation player={player} source={STREAM} viewRef={viewRef} />);
    });
    expect(fake.replaceAsync).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer.update(<Presentation player={player} source={finalSource} viewRef={viewRef} />);
    });
    // No second replacement races the in-flight one, and no HLS decoder is
    // attached while a progressive source is the latest requested source.
    expect(fake.replaceAsync).toHaveBeenCalledTimes(1);
    expect(mockAttached).not.toHaveBeenCalled();
    await act(async () => {
      finishReplacement?.();
      await firstReplacement;
    });
    expect(fake.replaceAsync).toHaveBeenLastCalledWith(finalSource);
    expect(mockAttached).not.toHaveBeenCalled();
    await act(async () => {
      renderer.unmount();
    });
  });
}

it('reports a rejected source replacement and can load the next requested source', async () => {
  const fake = makePlayer();
  const player = fake as unknown as VideoPlayer;
  const viewRef = React.createRef<VideoViewHandle>();
  const onSourceError = jest.fn();
  const renderer = await mount(
    <Presentation player={player} source={FILE} viewRef={viewRef} onSourceError={onSourceError} />,
  );
  fake.replaceAsync.mockRejectedValueOnce(new Error('Decoder replacement rejected'));
  await act(async () => {
    renderer.update(
      <Presentation
        player={player}
        source={STREAM}
        viewRef={viewRef}
        onSourceError={onSourceError}
      />,
    );
  });
  expect(onSourceError).toHaveBeenCalledTimes(1);
  expect(mockAttached).not.toHaveBeenCalled();
  await act(async () => {
    renderer.update(
      <Presentation
        player={player}
        source={FILE}
        viewRef={viewRef}
        onSourceError={onSourceError}
      />,
    );
  });
  expect(fake.replaceAsync).toHaveBeenLastCalledWith(FILE);
  expect(onSourceError).toHaveBeenCalledTimes(1);
  await act(async () => {
    renderer.unmount();
  });
});

it('keeps a registry player alive while the persistent view outlives its presenter', async () => {
  const fake = { ...makePlayer(), release: jest.fn() };
  mockCreateVideoPlayer.mockReturnValue(fake);
  const key = videoPlayerKey('view-lifetime', 'video');
  const presenter = acquireVideoPlayer(key, STREAM);
  const renderer = await mount(
    <PlaybackVideoView player={presenter.player} registryKey={key} source={STREAM} />,
  );
  presenter.release();
  expect(fake.release).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
  expect(fake.release).toHaveBeenCalledTimes(1);
});
