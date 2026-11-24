import { Platform } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { ShellRouteProvider, shellRouteOf, useShellRoute, type ShellRoute } from '../shellRoute';

let mockPathname = '/';
jest.mock('@/lib/navigation/router', () => ({ usePathname: () => mockPathname }));

it('names the facts the shell reads, not the path', () => {
  expect(shellRouteOf('/p/abc')).toMatchObject({ post: false, videos: false });
  expect(shellRouteOf('/p/abc/quotes').post).toBe(false);
  expect(shellRouteOf('/videos').videos).toBe(true);
  expect(shellRouteOf('/c/xyz/insights').insights).toBe(true);
  expect(shellRouteOf('/compose').fullScreen).toBe(true);
});

it('changes the shell route only when one of its facts changes', async () => {
  const seen: ShellRoute[] = [];
  function Shell() {
    seen.push(useShellRoute());
    return null;
  }
  // The shell is the provider's child: it renders only when the facts change.
  const shell = <Shell />;
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  mockPathname = '/';
  await act(async () => {
    renderer = TestRenderer.create(<ShellRouteProvider>{shell}</ShellRouteProvider>);
  });
  expect(seen).toHaveLength(1);
  // A tab switch: the shell has nothing to redraw.
  mockPathname = '/notifications';
  await act(async () => renderer?.update(<ShellRouteProvider>{shell}</ShellRouteProvider>));
  expect(seen).toHaveLength(1);
  // A post on a device: its screen hides the bar itself (Bloom's
  // `replacesBottomBar`), so the shell has nothing to redraw either.
  mockPathname = '/p/abc';
  await act(async () => renderer?.update(<ShellRouteProvider>{shell}</ShellRouteProvider>));
  expect(seen).toHaveLength(1);
  await act(async () => renderer?.unmount());
});

it('names a post on the web, where the shell drops the bar for it', () => {
  const os = Platform.OS;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  try {
    expect(shellRouteOf('/p/abc').post).toBe(true);
    expect(shellRouteOf('/p/abc/quotes').post).toBe(false);
  } finally {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
  }
});
