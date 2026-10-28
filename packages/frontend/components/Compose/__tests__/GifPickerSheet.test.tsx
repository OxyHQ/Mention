import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FlatList, Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import GifPickerSheet from '../GifPickerSheet';

const mockGet = jest.fn();
jest.mock('@/utils/api', () => ({
  authenticatedClient: { get: (...args: unknown[]) => mockGet(...args) },
  api: { get: (...args: unknown[]) => mockGet(...args), post: jest.fn() },
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ user: { id: 'viewer' }, canUsePrivateApi: true }),
}));
const mockTranslate = (key: string) => key;
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: mockTranslate }) }));
jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ colors: {} }) }));
jest.mock('@oxy.so/bloom/search', () => ({
  Search: (props: object) => {
    const { TextInput } = require('react-native');
    return <TextInput {...props} />;
  },
}));
jest.mock('@oxy.so/bloom/button', () => ({
  Button: (props: object) => {
    const { Text } = require('react-native');
    return <Text {...props} />;
  },
}));
jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: () => null }));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: jest.fn() }));
jest.mock('@oxy.so/bloom/loading', () => ({ Loading: () => null }));
jest.mock('@/components/loading/ContentSkeleton', () => ({ MediaGridSkeleton: () => null }));
jest.mock('@/components/common/VideoPlayer', () => () => null);

const result = (id: string) => ({ data: { gifs: [{ id, slug: id, previewUrl: '' }] } });
let tree: TestRenderer.ReactTestRenderer;
let client: QueryClient;
async function settle() {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1);
  });
}
async function search(query: string) {
  act(() => tree.root.findByType(TextInput).props.onChangeText(query));
  await act(async () => {
    await jest.advanceTimersByTimeAsync(500);
  });
  await settle();
}
function ids() {
  return tree.root.findByType(FlatList).props.data.map((item: { id: string }) => item.id);
}
beforeEach(async () => {
  jest.useFakeTimers();
  mockGet.mockReset().mockResolvedValue(result('trending'));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    tree = TestRenderer.create(
      <QueryClientProvider client={client}>
        <GifPickerSheet onClose={() => {}} onSelectGif={async () => {}} />
      </QueryClientProvider>,
    );
  });
  await settle();
});
afterEach(() => {
  act(() => tree.unmount());
  client.clear();
  jest.useRealTimers();
});

it('requests trending once on mount and reuses it when clearing a search', async () => {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(600);
  });
  expect(mockGet).toHaveBeenCalledTimes(1);
  mockGet.mockResolvedValue(result('frog'));
  await search('frog');
  expect(ids()).toEqual(['frog']);
  await search('');
  expect(ids()).toEqual(['trending']);
  expect(mockGet).toHaveBeenCalledTimes(2);
});
it('shows loading immediately and never replaces a newer search with a late response', async () => {
  let resolveFrog: (value: ReturnType<typeof result>) => void = () => {
    throw new Error('not requested');
  };
  mockGet.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveFrog = resolve;
      }),
  );
  await search('frog');
  expect(tree.root.findAllByType(FlatList)).toHaveLength(0);
  expect(
    tree.root.findAllByType(Text).some((node) => node.props.children === 'Loading GIFs...'),
  ).toBe(true);
  mockGet.mockResolvedValue(result('rocket'));
  await search('rocket');
  expect(ids()).toEqual(['rocket']);
  await act(async () => {
    resolveFrog(result('frog'));
  });
  await settle();
  expect(ids()).toEqual(['rocket']);
});
it('shows a failed search with a retry action instead of stale trending results', async () => {
  mockGet.mockRejectedValueOnce(new Error('offline'));
  await search('frog');
  expect(tree.root.findAllByType(FlatList)).toHaveLength(0);
  expect(
    tree.root.findAllByType(Text).some((node) => node.props.children === 'Failed to load GIFs'),
  ).toBe(true);
  mockGet.mockResolvedValue(result('frog'));
  const retry = tree.root
    .findAllByType(Text)
    .find((node) => node.props.children === 'common.retry');
  await act(async () => {
    retry?.props.onPress();
  });
  await settle();
  expect(ids()).toEqual(['frog']);
});
