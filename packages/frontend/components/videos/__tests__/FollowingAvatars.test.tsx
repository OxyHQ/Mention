import TestRenderer, { act } from 'react-test-renderer';
import { FollowingAvatars } from '../FollowingAvatars';
import { AccountAvatarGroup } from '@/components/ui/AccountAvatarGroup';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';

/** Under Bloom's theme provider: the language paints its text and glyphs from the theme, as the app's provider supplies it. */
function themed(element: React.ReactElement): React.ReactElement {
  return <BloomThemeProvider fonts={false}>{element}</BloomThemeProvider>;
}

/** What the facepile drew inside Bloom's theme: `null` while it draws nothing. */
function drawn(renderer: TestRenderer.ReactTestRenderer) {
  const provider = renderer.toJSON();
  if (provider === null || Array.isArray(provider)) return provider;
  return provider.children;
}

let mockViewer: string | null = 'viewer-a';
let mockPrivate = true;
let mockGraph: { followingIds: string[] } | undefined;
let mockProfiles: { id: string; avatar?: string; kind?: string; character?: object }[] | undefined;
const mockQueries: { queryKey: unknown[]; enabled: boolean; queryFn: () => unknown }[] = [];
const mockViewerGraph = jest.fn();
const mockGetMany = jest.fn();

jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({
    user: mockViewer ? { id: mockViewer } : null,
    canUsePrivateApi: mockPrivate,
    oxyServices: { follows: { viewerGraph: mockViewerGraph }, users: { getMany: mockGetMany } },
  }),
  queryKeys: { users: { list: (ids: string[]) => ['users', 'list', ids] } },
}));
jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: (typeof mockQueries)[number]) => {
    mockQueries.push(options);
    return { data: options.queryKey[0] === 'users' ? mockProfiles : mockGraph };
  },
}));
jest.mock('@/components/ui/AccountAvatarGroup', () => ({ AccountAvatarGroup: () => null }));

beforeEach(() => {
  mockViewer = 'viewer-a';
  mockPrivate = true;
  mockGraph = { followingIds: ['b', 'a', 'missing', 'fourth'] };
  mockProfiles = [
    { id: 'a', avatar: 'a.jpg' },
    { id: 'b', avatar: 'b.jpg' },
  ];
  mockQueries.length = 0;
  mockViewerGraph.mockReset();
  mockGetMany.mockReset();
});

it('hydrates only three real followed identities and preserves their graph order', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(themed(<FollowingAvatars />));
  });
  const group = renderer.root.findByType(AccountAvatarGroup);
  expect(group.props.items.map((item: { id: string }) => item.id)).toEqual(['b', 'a']);
  expect(group.props).toMatchObject({ size: 18, overlap: 6, max: 3 });
  mockQueries[1].queryFn();
  expect(mockGetMany).toHaveBeenCalledWith(['b', 'a', 'missing']);
  act(() => renderer.unmount());
});

it.each(['anonymous', 'private-unavailable'])(
  'hides cached identities and disables both queries when %s',
  (state) => {
    if (state === 'anonymous') mockViewer = null;
    else mockPrivate = false;
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(themed(<FollowingAvatars />));
    });
    expect(drawn(renderer)).toBeNull();
    expect(mockQueries.every((query) => !query.enabled)).toBe(true);
    act(() => renderer.unmount());
  },
);

it('drops the previous viewer facepile while the next viewer graph loads', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(themed(<FollowingAvatars />));
  });
  const firstKey = mockQueries[0].queryKey;
  mockViewer = 'viewer-b';
  mockGraph = undefined;
  act(() => renderer.update(themed(<FollowingAvatars />)));
  expect(drawn(renderer)).toBeNull();
  expect(mockQueries[2].queryKey).not.toEqual(firstKey);
  expect(mockQueries[3].enabled).toBe(false);
  act(() => renderer.unmount());
});

it('does not invent placeholders when followed profiles cannot be resolved', () => {
  mockProfiles = [];
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(themed(<FollowingAvatars />));
  });
  expect(drawn(renderer)).toBeNull();
  act(() => renderer.unmount());
});
