/** @jest-environment jsdom */

import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  WatchBrowseRail,
  WatchPlaybackProvider,
  WatchPlayerSurface,
  WatchVideoRailFrame,
} from '../WatchPlayerSurface.web';
import type { VideoPreview } from '../watchVideo';

jest.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
jest.mock('@oxy.so/bloom/screen', () => ({
  Screen: ({ children, bottomBar }: { children: ReactNode; bottomBar: ReactNode }) => (
    <div>
      {children}
      {bottomBar}
    </div>
  ),
}));
jest.mock('@oxy.so/bloom/app-shell', () => ({ useAppShellPanel: () => ({ active: true }) }));
const mockPush = jest.fn();
jest.mock('@/lib/navigation/router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('../WatchPlaybackVideo', () => ({
  WatchPlaybackVideo: ({ onPlaybackStart }: { onPlaybackStart?: () => void }) => (
    <>
      <video onPlaying={onPlaybackStart}>
        <track kind="captions" />
      </video>
      <button type="button">Pause</button>
    </>
  ),
}));

const video = {
  post: { id: 'one' },
  mediaIndex: 0,
  source: '/one.mp4',
} as VideoPreview;

const originalObserver = globalThis.IntersectionObserver;
const observe = jest.fn();
const disconnect = jest.fn();
let report: IntersectionObserverCallback;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  mockPush.mockClear();
  observe.mockClear();
  disconnect.mockClear();
  globalThis.IntersectionObserver = jest.fn((callback: IntersectionObserverCallback) => {
    report = callback;
    return { observe, disconnect } as unknown as IntersectionObserver;
  }) as unknown as typeof IntersectionObserver;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.IntersectionObserver = originalObserver;
});

function render(pathname = '/watch/one', canContinue = true) {
  act(() => {
    root.render(
      <WatchPlaybackProvider pathname={pathname}>
        {pathname === '/watch/one' ? (
          <>
            <WatchPlayerSurface
              video={video}
              dockable
              focused
              concealed={false}
              canContinue={canContinue}
            >
              null
            </WatchPlayerSurface>
            <WatchVideoRailFrame postId="one">Details</WatchVideoRailFrame>
          </>
        ) : (
          <>
            <main>Another page</main>
            <div data-testid="right-column">
              <WatchBrowseRail>Widgets</WatchBrowseRail>
            </div>
          </>
        )}
      </WatchPlaybackProvider>,
    );
  });
}

function at(target: string, media = false) {
  return container.querySelector(`[data-testid="watch-player-${target}"]${media ? ' video' : ''}`);
}

it('moves the original playing surface into the matching rail and back as the page scrolls', () => {
  render();
  const inline = at('inline');
  const player = at('inline', true);
  expect(player).toBeInstanceOf(HTMLVideoElement);
  expect(observe).toHaveBeenCalledWith(inline);
  const scroll = (bottom: number) =>
    report(
      [{ boundingClientRect: { bottom }, rootBounds: { top: 64 } } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  act(() => scroll(40));
  expect(at('dock', true)).toBe(player);
  expect(at('inline', true)).toBeNull();
  const scrollBack = jest.fn();
  if (!inline || !(player instanceof HTMLVideoElement)) throw new Error('Missing Watch player');
  Object.defineProperty(inline, 'scrollIntoView', { value: scrollBack });
  act(() => player.click());
  expect(scrollBack).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' });
  expect(mockPush).not.toHaveBeenCalled();

  act(() => scroll(210));
  expect(at('inline', true)).toBe(player);
  expect(at('dock', true)).toBeNull();
  render('/');
  expect(disconnect).toHaveBeenCalled();
});

it('keeps the same player across navigation and restores it to Watch', () => {
  render();
  const player = at('inline', true) as HTMLVideoElement;
  act(() => player.dispatchEvent(new Event('playing')));

  render('/');
  expect(
    container.querySelector(
      '[data-testid="right-column"] [data-testid="watch-browse-player-dock"] video',
    ),
  ).toBe(player);
  render('/explore');
  expect(
    container.querySelector(
      '[data-testid="right-column"] [data-testid="watch-browse-player-dock"] video',
    ),
  ).toBe(player);
  const pause = container.querySelector<HTMLButtonElement>(
    '[data-testid="watch-browse-player-dock"] button',
  );
  expect(pause).toBeInstanceOf(HTMLButtonElement);
  act(() => pause?.click());
  expect(mockPush).not.toHaveBeenCalled();
  act(() => player.click());
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/watch/[id]',
    params: { id: 'one', mediaIndex: '0' },
  });

  render();
  expect(at('inline', true)).toBe(player);
  expect(container.querySelector('[data-testid="watch-browse-player-dock"]')).toBeNull();

  render('/watch/another');
  expect(container.querySelector('video')).toBeNull();
});

it('releases videos that never played or are restricted to Watch', () => {
  render();
  render('/');
  expect(container.querySelector('video')).toBeNull();

  render('/watch/one', false);
  const player = at('inline', true) as HTMLVideoElement;
  act(() => player.dispatchEvent(new Event('playing')));
  render('/');
  expect(container.querySelector('video')).toBeNull();
});

it('ends the Watch session when Clips opens', () => {
  render();
  const player = at('inline', true) as HTMLVideoElement;
  act(() => player.dispatchEvent(new Event('playing')));
  render('/');
  expect(container.querySelector('[data-testid="watch-browse-player-dock"] video')).toBe(player);

  render('/videos');
  expect(player.isConnected).toBe(false);
  render('/');
  expect(container.querySelector('video')).toBeNull();
});

it('dismisses the dock for another playing video but keeps it through silent animation', () => {
  render();
  const player = at('inline', true) as HTMLVideoElement;
  act(() => player.dispatchEvent(new Event('playing')));
  render('/');

  const other = document.createElement('video');
  other.muted = true;
  other.loop = true;
  container.querySelector('main')?.appendChild(other);
  act(() => other.dispatchEvent(new Event('playing')));
  expect(player.isConnected).toBe(true);
  act(() => player.dispatchEvent(new Event('playing')));
  expect(player.isConnected).toBe(true);

  other.loop = false;
  act(() => other.dispatchEvent(new Event('playing')));
  expect(player.isConnected).toBe(false);
});
