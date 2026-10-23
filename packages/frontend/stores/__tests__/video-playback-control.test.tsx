import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { VideoPlayer } from 'expo-video';
import {
  useVideoHasRenderedFrame,
  useVideoLoadingDemand,
  useVideoPlaybackControl,
} from '../video-playback-control';

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

function Loading({ player }: { player: VideoPlayer }) {
  const loading = useVideoLoadingDemand(player);
  return <span>{String(loading)}</span>;
}

function mount(element: React.ReactElement) {
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
  const render = (preloading: boolean) => (
    <>
      <Presenter player={player} playing={false} loading={preloading} />
      <Presenter player={player} playing={false} />
      <Loading player={player} />
    </>
  );
  const renderer = mount(render(false));
  expect(renderer.root.findByType('span').children).toEqual(['false']);
  act(() => {
    renderer.update(render(true));
  });
  expect(renderer.root.findByType('span').children).toEqual(['true']);
  act(() => {
    renderer.update(render(false));
  });
  expect(renderer.root.findByType('span').children).toEqual(['false']);
  act(() => {
    renderer.unmount();
  });
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
    return <span>{String(useVideoHasRenderedFrame(player))}</span>;
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
