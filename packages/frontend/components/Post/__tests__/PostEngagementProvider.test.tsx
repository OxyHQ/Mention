import type React from 'react';
import { useEffect } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { PostEngagementProvider } from '../PostEngagementProvider';
import {
  openPostInsights,
  useOpenPostEngagement,
  useVideoRepliesPanel,
} from '../postEngagementContext';
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

it('releases only the published video owner when a feed becomes empty', () => {
  let actions!: ReturnType<typeof useVideoRepliesPanel>;
  function VideoPublisher() {
    actions = useVideoRepliesPanel();
    return null;
  }
  mockRoute = '/videos';
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <PostEngagementProvider>
        <VideoPublisher />
      </PostEngagementProvider>,
    );
  });
  const first = actions?.publishReplies('video-1', jest.fn());
  expect(first?.isCurrent?.()).toBe(true);
  if (!first) throw new Error('No video owner');
  actions?.closeReplies(first);
  expect(first.isCurrent?.()).toBe(false);
  const second = actions?.publishReplies('video-2', jest.fn());
  actions?.closeReplies(first);
  expect(second?.isCurrent?.()).toBe(true);
  actions?.open('post-1', 'likes');
  if (second) actions?.closeReplies(second);
  expect(usePostEngagementPanels.getState().panels['deck-2']).toMatchObject({
    isOpen: true,
    destination: { kind: 'likes' },
  });
  act(() => renderer.unmount());
});

it('entering the reserved Videos route drops only the departed route payload', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  const tree = () => (
    <PostEngagementProvider>
      <Trigger />
    </PostEngagementProvider>
  );
  act(() => {
    renderer = TestRenderer.create(tree());
  });
  act(() => {
    open?.('post-1', 'likes');
  });
  mockRoute = '/videos';
  act(() => renderer.update(tree()));
  expect(usePostEngagementPanels.getState().panels['deck-2']).toBeUndefined();
  act(() => {
    open?.('video-1', 'replies');
  });
  mockRoute = '/';
  act(() => renderer.update(tree()));
  expect(usePostEngagementPanels.getState().panels['deck-2']).toMatchObject({
    isOpen: false,
    destination: { kind: 'replies', postId: 'video-1' },
  });
  act(() => renderer.unmount());
});
