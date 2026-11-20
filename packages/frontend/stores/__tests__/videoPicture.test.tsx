/**
 * Which view a player paints into (`usePictureView`). On Android the last view
 * handed a player takes it and nothing gives it back, so a presenter that starts
 * asking its player to play while another view holds it must mount a new view.
 * Measured on the Pixel 8a before this: a feed video opened into the reel came
 * back to Home frozen on its last frame while the player played on.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { VideoPlayer } from 'expo-video';

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('expo-video', () => ({ createVideoPlayer: jest.fn() }));
jest.mock('@oxy.so/bloom/video-playback', () => ({ setVideoHasRenderedFrame: jest.fn() }));
jest.mock('@/lib/hlsPlayback', () => ({ needsJsHlsDecoder: () => false }));
jest.mock('@oxy.so/core/logger', () => ({ createLogger: () => ({ error: jest.fn() }) }));

import { useAnyVideoPlaying, usePictureView } from '../videoPlayerRegistry';

// A fresh player per test: the registry remembers pictures per player.
let player = {} as VideoPlayer;
const keys: Record<string, number[]> = { feed: [], reel: [] };
let renderer: TestRenderer.ReactTestRenderer | null = null;

function mount(element: React.ReactElement) {
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer as TestRenderer.ReactTestRenderer;
}

beforeEach(() => {
  player = {} as VideoPlayer;
  keys.feed = [];
  keys.reel = [];
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

function Presenter({ name, watched }: { name: 'feed' | 'reel'; watched: boolean }) {
  const [presenter] = React.useState(() => ({}));
  keys[name].push(usePictureView(player, presenter, watched));
  return null;
}

function Screens({ feed, reel }: { feed?: boolean; reel?: boolean }) {
  return (
    <>
      {feed !== undefined && <Presenter name="feed" watched={feed} />}
      {reel !== undefined && <Presenter name="reel" watched={reel} />}
    </>
  );
}

const last = (name: 'feed' | 'reel') => keys[name][keys[name].length - 1];

it('takes the picture back when the presenter starts playing again, and only then', () => {
  const renderer = mount(<Screens feed />);
  const feedView = last('feed');

  // The feed video opens into the reel: the reel's view takes the player, and
  // the feed row stops asking (its screen is behind the reel). Nothing remounts.
  act(() => renderer.update(<Screens feed={false} reel />));
  expect(last('feed')).toBe(feedView);
  const reelView = last('reel');

  // Back on Home the row asks to play again with the picture in the reel's view:
  // a new view, which takes it.
  act(() => renderer.update(<Screens feed reel={false} />));
  expect(last('feed')).not.toBe(feedView);
  const retaken = last('feed');

  // Asking on, nothing else happening: the row keeps the view it has.
  act(() => renderer.update(<Screens feed reel={false} />));
  expect(last('feed')).toBe(retaken);

  // And the reel, shown again, takes it back the same way.
  act(() => renderer.update(<Screens feed={false} reel />));
  expect(last('reel')).not.toBe(reelView);
});

it('does not remount a view that still holds the picture', () => {
  const renderer = mount(<Screens feed />);
  const view = last('feed');
  act(() => renderer.update(<Screens feed={false} />));
  act(() => renderer.update(<Screens feed />));
  expect(last('feed')).toBe(view);
});

it('two presenters asking at once do not take it from each other in a loop', () => {
  const renderer = mount(<Screens feed reel />);
  const counts = { feed: keys.feed.length, reel: keys.reel.length };
  act(() => renderer.update(<Screens feed reel />));
  // One render each for the update, no remount storm.
  expect(keys.feed.length - counts.feed).toBeLessThanOrEqual(2);
  expect(keys.reel.length - counts.reel).toBeLessThanOrEqual(2);
});

it('reports whether any presenter is asking its player to play', () => {
  let playing: boolean[] = [];
  function Watcher() {
    playing.push(useAnyVideoPlaying());
    return null;
  }
  const renderer = mount(
    <>
      <Watcher />
      <Screens feed={false} />
    </>,
  );
  expect(playing.at(-1)).toBe(false);
  act(() =>
    renderer.update(
      <>
        <Watcher />
        <Screens feed />
      </>,
    ),
  );
  expect(playing.at(-1)).toBe(true);
  act(() => renderer.unmount());
  playing = [];
});
