import TestRenderer, { act } from 'react-test-renderer';
import { ShellRouteSync, shellRouteOf, useShellRoute } from '../shellRoute';

let mockPathname = '/';
jest.mock('@/lib/navigation/router', () => ({ usePathname: () => mockPathname }));

it('names the facts the shell reads, not the path', () => {
  expect(shellRouteOf('/p/abc')).toMatchObject({ post: true, videos: false });
  expect(shellRouteOf('/p/abc/quotes').post).toBe(false);
  expect(shellRouteOf('/videos').videos).toBe(true);
  expect(shellRouteOf('/c/xyz/insights').insights).toBe(true);
  expect(shellRouteOf('/compose').fullScreen).toBe(true);
});

it('changes the shell route only when one of its facts changes', async () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = TestRenderer.create(<ShellRouteSync />);
  });
  const home = useShellRoute.getState();
  // A tab switch: the shell has nothing to redraw.
  mockPathname = '/notifications';
  await act(async () => renderer?.update(<ShellRouteSync />));
  expect(useShellRoute.getState()).toBe(home);
  // A post: its reply prompt replaces the bar.
  mockPathname = '/p/abc';
  await act(async () => renderer?.update(<ShellRouteSync />));
  expect(useShellRoute.getState()).not.toBe(home);
  expect(useShellRoute.getState().post).toBe(true);
  await act(async () => renderer?.unmount());
});
