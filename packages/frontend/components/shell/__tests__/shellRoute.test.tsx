import TestRenderer, { act } from 'react-test-renderer';
import { ShellRouteProvider, shellRouteOf, useShellRoute, type ShellRoute } from '../shellRoute';

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
  // A post: its reply prompt replaces the bar, in the navigation's own render.
  mockPathname = '/p/abc';
  await act(async () => renderer?.update(<ShellRouteProvider>{shell}</ShellRouteProvider>));
  expect(seen).toHaveLength(2);
  expect(seen[1]?.post).toBe(true);
  await act(async () => renderer?.unmount());
});
