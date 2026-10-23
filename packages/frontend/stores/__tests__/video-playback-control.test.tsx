import { memo, type ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { VideoPlayer } from 'expo-video';
import { subscribeVideoLoadingDemand, useVideoPlaybackControl } from '../video-playback-control';

function makePlayer() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const player = {
    play: jest.fn(),
    pause: jest.fn(),
    addListener: (event: string, listener: (event: unknown) => void) => {
      let subscriptions = listeners.get(event);
      if (!subscriptions) {
        subscriptions = new Set();
        listeners.set(event, subscriptions);
      }
      subscriptions.add(listener);
      return { remove: () => subscriptions.delete(listener) };
    },
  };
  return {
    player: player as unknown as VideoPlayer,
    play: player.play,
    pause: player.pause,
    emit: (event: string, payload: unknown) => {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
  };
}

function Presenter({
  player,
  playing,
  loading = playing,
}: {
  player: VideoPlayer;
  playing: boolean;
  loading?: boolean;
}) {
  useVideoPlaybackControl(player, playing, loading);
  return null;
}

function mount(element: ReactElement) {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  if (!renderer) throw new Error('Renderer did not mount');
  return renderer;
}

it('a hidden feed cannot pause the shared player claimed by the reel, in either effect order', () => {
  for (const feedFirst of [true, false]) {
    const { player, play, pause, emit } = makePlayer();
    const render = (feedPlaying: boolean) => {
      const feed = <Presenter key="feed" player={player} playing={feedPlaying} />;
      const reel = <Presenter key="reel" player={player} playing />;
      return <>{feedFirst ? [feed, reel] : [reel, feed]}</>;
    };
    const renderer = mount(render(true));
    pause.mockClear();
    act(() => {
      renderer.update(render(false));
    });
    expect(pause).not.toHaveBeenCalled();
    play.mockClear();
    act(() => {
      emit('sourceChange', {});
    });
    expect(play).toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  }
});

it('only loads while a presenter requests playback or bounded preload', () => {
  const { player } = makePlayer();
  const loading: boolean[] = [];
  const unsubscribe = subscribeVideoLoadingDemand(player, (value) => loading.push(value));
  const render = (preloading: boolean) => (
    <>
      <Presenter player={player} playing={false} loading={preloading} />
      <Presenter player={player} playing={false} />
    </>
  );
  const renderer = mount(render(false));
  expect(loading.at(-1)).toBe(false);
  act(() => {
    renderer.update(render(true));
  });
  expect(loading.at(-1)).toBe(true);
  act(() => {
    renderer.update(render(false));
  });
  expect(loading.at(-1)).toBe(false);
  act(() => {
    renderer.unmount();
  });
  unsubscribe();
});

it('pauses when no remaining presenter requests playback and resumes after readiness', () => {
  const { player, play, pause, emit } = makePlayer();
  const renderer = mount(<Presenter player={player} playing />);
  act(() => {
    renderer.update(<Presenter player={player} playing={false} />);
  });
  expect(pause).toHaveBeenCalled();
  play.mockClear();
  act(() => {
    emit('statusChange', { status: 'readyToPlay' });
  });
  expect(play).not.toHaveBeenCalled();
  act(() => {
    renderer.update(<Presenter player={player} playing />);
  });
  play.mockClear();
  act(() => {
    emit('statusChange', { status: 'readyToPlay' });
  });
  expect(play).toHaveBeenCalled();
  act(() => {
    renderer.unmount();
  });
});

it('moves control to a replacement player without leaving stale demand on the old one', () => {
  const first = makePlayer();
  const second = makePlayer();
  const renderer = mount(<Presenter player={first.player} playing />);
  act(() => {
    renderer.update(<Presenter player={second.player} playing />);
  });
  expect(second.play).toHaveBeenCalled();
  first.play.mockClear();
  act(() => {
    first.emit('sourceChange', {});
  });
  expect(first.play).not.toHaveBeenCalled();
  act(() => {
    renderer.unmount();
  });
});

it('a new presenter inherits the first-frame latch even during a rebuffer', () => {
  const { player, emit } = makePlayer();
  function Frame() {
    return <span>{String(useVideoPlaybackControl(player, false))}</span>;
  }
  const renderer = mount(
    <>
      <Presenter player={player} playing />
      <Frame />
    </>,
  );
  expect(renderer.root.findByType('span').children).toEqual(['false']);
  act(() => {
    emit('statusChange', { status: 'readyToPlay' });
  });
  act(() => {
    emit('statusChange', { status: 'loading' });
  });
  act(() => {
    renderer.update(
      <>
        <Presenter key="reel" player={player} playing />
        <Frame key="reel-frame" />
      </>,
    );
  });
  expect(renderer.root.findByType('span').children).toEqual(['true']);
  act(() => {
    renderer.unmount();
  });
});

it('notifies the decoder only when loading demand changes', () => {
  const { player, emit } = makePlayer();
  const changed = jest.fn();
  const renderer = mount(<Presenter player={player} playing loading />);
  const unsubscribe = subscribeVideoLoadingDemand(player, changed);
  expect(changed.mock.calls).toEqual([[true]]);
  act(() => emit('statusChange', { status: 'readyToPlay' }));
  act(() => renderer.update(<Presenter player={player} playing={false} loading />));
  expect(changed.mock.calls).toEqual([[true]]);
  act(() => renderer.unmount());
  expect(changed.mock.calls).toEqual([[true], [false]]);
  unsubscribe();
});

it('does not rerender a frame consumer for loading-only changes', () => {
  const { player, emit } = makePlayer();
  const renderFrame = jest.fn();
  const Frame = memo(function FrameReader() {
    renderFrame();
    const rendered = useVideoPlaybackControl(player, false);
    return <span>{String(rendered)}</span>;
  });
  const render = (loading: boolean) => (
    <>
      <Presenter player={player} playing={false} loading={loading} />
      <Frame />
    </>
  );
  const renderer = mount(render(false));
  const before = renderFrame.mock.calls.length;
  act(() => renderer.update(render(true)));
  expect(renderFrame).toHaveBeenCalledTimes(before);
  act(() => emit('statusChange', { status: 'readyToPlay' }));
  expect(renderer.root.findByType('span').children).toEqual(['true']);
  expect(renderFrame).toHaveBeenCalledTimes(before + 1);
  act(() => renderer.unmount());
});
