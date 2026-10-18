import TestRenderer, { act } from 'react-test-renderer';
import MentionRoute from '../mention';

let mockUri: string | undefined;
const mockResolve = jest.fn();
const mockRefetch = jest.fn();
let mockQuery: {
  data: { handle: string; oxyUserId?: string } | null;
  isPending: boolean;
  isError: boolean;
};
const mockUseQuery = jest.fn();
jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: unknown) => {
    mockUseQuery(options);
    return { ...mockQuery, refetch: mockRefetch };
  },
}));
jest.mock('@/lib/navigation/router', () => ({
  useLocalSearchParams: () => ({ uri: mockUri }),
  Redirect: 'Redirect',
}));
jest.mock('@oxy.so/core', () => ({
  getNormalizedUserHandle: ({ username }: { username: string }) => username || null,
}));
jest.mock('@oxy.so/bloom/loading', () => ({ Loading: 'Loading' }));
jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: 'PageHeader' }));
jest.mock('@/components/Profile/ProfileUnavailable', () => ({ ProfileUnavailable: 'Unavailable' }));
jest.mock('@/components/SEO', () => ({ SEO: () => null }));
jest.mock('@/hooks/useSafeBack', () => ({ useSafeBack: () => jest.fn() }));
jest.mock('@/utils/resolveMention', () => ({ resolveMention: (uri: string) => mockResolve(uri) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

let renderer: TestRenderer.ReactTestRenderer;
function render() {
  act(() => {
    renderer = TestRenderer.create(<MentionRoute />);
  });
  return renderer.root;
}
beforeEach(() => {
  jest.clearAllMocks();
  mockUri = 'https://mastodon.social/@zackwhittaker';
  mockQuery = { data: null, isPending: false, isError: false };
});
afterEach(() => {
  act(() => renderer?.unmount());
});

it('resolves the exact source URL with the existing identity resolver', async () => {
  mockQuery.isPending = true;
  const root = render();
  expect(
    root.findAll((node) => typeof node.type === 'string' && node.props.testID === 'feed-skeleton'),
  ).toHaveLength(1);
  expect(root.findAll((node) => String(node.type) === 'Loading')).toHaveLength(0);
  await mockUseQuery.mock.calls[0][0].queryFn();
  expect(mockResolve).toHaveBeenCalledWith(mockUri);
});

it('redirects to the canonical account, including when its handle differs from the URL', () => {
  mockQuery.data = { handle: 'canonical@origin.example', oxyUserId: 'oxy-id' };
  expect(render().find((node) => String(node.type) === 'Redirect').props.href).toBe(
    '/@canonical@origin.example',
  );
});

it('does not manufacture an identity from a handle without an Oxy ID', () => {
  mockQuery.data = { handle: 'guessed@origin.example' };
  expect(render().find((node) => String(node.type) === 'Unavailable').props.notFound).toBe(true);
});

it('keeps a missing account inside the app', () => {
  expect(render().find((node) => String(node.type) === 'Unavailable').props.notFound).toBe(true);
});

it('offers retry for failed resolution rather than reporting a missing account', async () => {
  mockQuery.isError = true;
  const unavailable = render().find((node) => String(node.type) === 'Unavailable');
  expect(unavailable.props.notFound).toBe(false);
  await unavailable.props.onRetry();
  expect(mockRefetch).toHaveBeenCalled();
});

it('does not resolve an invalid source', () => {
  mockUri = 'javascript:alert(1)';
  expect(render().find((node) => String(node.type) === 'Unavailable').props.notFound).toBe(true);
  expect(mockUseQuery.mock.calls[0][0].enabled).toBe(false);
});
