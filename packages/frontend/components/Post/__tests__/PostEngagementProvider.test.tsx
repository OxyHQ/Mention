import type React from 'react';
import { useEffect } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { PostEngagementProvider } from '../PostEngagementProvider';
import { useOpenPostEngagement } from '../postEngagementContext';
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
  expect(usePostEngagementPanels.getState().panels['deck-2']).toBeUndefined();
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
  expect(usePostEngagementPanels.getState().panels['deck-2']).toBeUndefined();
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
