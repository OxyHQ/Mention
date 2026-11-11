import type React from 'react';
import { useEffect } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { PostEngagementProvider } from '../PostEngagementProvider';
import { openPostInsights, useOpenPostEngagement } from '../postEngagementContext';
import { usePostEngagementPanels } from '../postEngagementPanels';

let mockViewer = 'a';
let mockRoute = '/p/post-1';
let mockHostId: string | undefined = 'deck-2';
const mockPush = jest.fn();
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => ({ user: { id: mockViewer } }) }));
jest.mock('@oxy.so/bloom/app-shell', () => ({ useAppShellPanel: () => ({ id: mockHostId }) }));
jest.mock('@/lib/navigation/router', () => ({
  usePathname: () => mockRoute,
  useRouter: () => ({ push: mockPush }),
  useFocusEffect: (effect: () => undefined | (() => void)) => {
    const { useEffect } = jest.requireActual<typeof React>('react');
    useEffect(effect, [effect]);
  },
}));

let open: ReturnType<typeof useOpenPostEngagement>;
function Trigger() {
  const action = useOpenPostEngagement();
  useEffect(() => {
    open = action;
  }, [action]);
  return null;
}

beforeEach(() => {
  mockViewer = 'a';
  mockRoute = '/p/post-1';
  mockHostId = 'deck-2';
  mockPush.mockClear();
  usePostEngagementPanels.setState({ viewer: null, generation: 0, panels: {} });
  usePostEngagementPanels.getState().activate('user:a');
});

it('opens in the originating column and preserves that columns navigation callback', async () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = TestRenderer.create(
      <PostEngagementProvider>
        <Trigger />
      </PostEngagementProvider>,
    );
  });
  await act(async () => {
    expect(open?.('post-1', 'likes')).toBe(true);
  });
  const entry = usePostEngagementPanels.getState().panels['deck-2'];
  expect(entry).toMatchObject({ isOpen: true, destination: { postId: 'post-1', kind: 'likes' } });
  entry?.destination.navigate('/@reader');
  expect(mockPush).toHaveBeenCalledWith('/@reader');
  await act(async () => renderer?.unmount());
  expect(usePostEngagementPanels.getState().panels['deck-2']).toMatchObject({
    isOpen: false,
    destination: { postId: 'post-1' },
  });
});

it('keeps an open panel across ordinary rerenders and closes it when the post route changes', async () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  const tree = () => (
    <PostEngagementProvider>
      <Trigger />
    </PostEngagementProvider>
  );
  await act(async () => {
    renderer = TestRenderer.create(tree());
  });
  await act(async () => {
    open?.('post-1', 'boosts');
  });
  await act(async () => renderer?.update(tree()));
  expect(usePostEngagementPanels.getState().panels['deck-2']?.isOpen).toBe(true);
  mockRoute = '/p/post-2';
  await act(async () => renderer?.update(tree()));
  expect(usePostEngagementPanels.getState().panels['deck-2']).toMatchObject({
    isOpen: false,
    destination: { postId: 'post-1' },
  });
  await act(async () => renderer?.unmount());
});

it('allows the standalone sheet fallback outside a shell panel', async () => {
  mockHostId = undefined;
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = TestRenderer.create(
      <PostEngagementProvider>
        <Trigger />
      </PostEngagementProvider>,
    );
  });
  expect(open?.('post-1', 'likes')).toBe(false);
  expect(usePostEngagementPanels.getState().panels).toEqual({});
  await act(async () => renderer?.unmount());
});

it.each([
  ['main', '/'],
  ['deck-2', '/explore'],
])('opens Insights from feed rows in host %s', async (hostId, route) => {
  mockHostId = hostId;
  mockRoute = route;
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = TestRenderer.create(
      <PostEngagementProvider>
        <Trigger />
      </PostEngagementProvider>,
    );
  });
  const fallback = jest.fn();
  await act(async () => openPostInsights(open ?? null, 'post-1', fallback));
  expect(usePostEngagementPanels.getState().panels[hostId]).toMatchObject({
    isOpen: true,
    destination: { postId: 'post-1', kind: 'insights', route },
  });
  expect(fallback).not.toHaveBeenCalled();
  await act(async () => renderer?.unmount());
});

it('uses the same standalone Insights fallback when no shell host accepts the action', () => {
  const fallback = jest.fn();
  openPostInsights(null, 'post-1', fallback);
  expect(fallback).toHaveBeenCalledWith('post-1');
});
