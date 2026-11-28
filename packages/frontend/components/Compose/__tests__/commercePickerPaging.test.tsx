import type { ReactNode } from 'react';
import { FlatList } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { waitUntil } from '@/test-support/waitUntil';
import { commerceService } from '@/services/commerceService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import CommercePickerSheet from '../CommercePickerSheet';

jest.mock('@/services/commerceService', () => ({
  commerceService: { products: jest.fn(), storeCollections: jest.fn() },
}));
let mockViewerId = 'viewer';
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ user: { id: mockViewerId } }),
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@oxy.so/bloom/button', () => {
  const { Pressable, Text } = jest.requireActual('react-native');
  return {
    Button: ({ children, onPress }: { children: ReactNode; onPress: () => void }) => (
      <Pressable testID={`picker-${children}`} onPress={onPress}>
        <Text>{children}</Text>
      </Pressable>
    ),
  };
});
jest.mock('@oxy.so/bloom/search', () => {
  const { TextInput } = jest.requireActual('react-native');
  return {
    Search: ({ onChangeText }: { onChangeText: (value: string) => void }) => (
      <TextInput testID="picker-search" onChangeText={onChangeText} />
    ),
  };
});
jest.mock('@oxy.so/bloom/item', () => ({ Item: () => null }));
jest.mock('@/components/loading/ContentSkeleton', () => ({ ListSkeleton: () => null }));

const service = jest.mocked(commerceService);
let client: QueryClient;
let renderer: TestRenderer.ReactTestRenderer;
beforeEach(() => {
  jest.clearAllMocks();
  mockViewerId = 'viewer';
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(() => {
  if (renderer) act(() => renderer.unmount());
  client.clear();
});

it.each(['products', 'collections'] as const)(
  'stops %s pagination when an opaque cursor cycles',
  async (mode) => {
    const page = (index: number) => ({
      items: [
        {
          ref: { kind: mode === 'products' ? 'product' : 'collection', id: `item-${index}` },
          title: `Item ${index}`,
        },
      ],
      nextCursor: index === 0 ? 'first' : index === 1 ? 'second' : 'first',
    });
    service.products.mockImplementation(
      async ({ cursor } = {}) =>
        page(cursor === undefined ? 0 : cursor === 'first' ? 1 : 2) as never,
    );
    service.storeCollections.mockImplementation(
      async (_accountId, cursor) =>
        page(cursor === undefined ? 0 : cursor === 'first' ? 1 : 2) as never,
    );
    act(() => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <CommercePickerSheet
            accountId="account"
            selected={[]}
            onSelect={jest.fn()}
            onClose={jest.fn()}
          />
        </QueryClientProvider>,
      );
    });
    if (mode === 'collections') {
      act(() =>
        renderer.root.findByProps({ testID: 'picker-commerce.collections' }).props.onPress(),
      );
    }
    const request = mode === 'products' ? service.products : service.storeCollections;
    const rows = () => (renderer.root.findAllByType(FlatList)[0]?.props.data ?? []) as unknown[];
    const more = () =>
      renderer.root.findByType(FlatList).props.onEndReached({ distanceFromEnd: 0 });
    await waitUntil(() => rows().length === 1, 'first picker page');
    await act(async () => more());
    await waitUntil(() => rows().length === 2, 'second picker page');
    await act(async () => more());
    await waitUntil(() => rows().length === 3, 'third picker page');
    await act(async () => more());
    expect(request).toHaveBeenCalledTimes(3);
  },
);

it.each([
  ['products', ''],
  ['products', null],
  ['collections', ''],
  ['collections', null],
] as const)('does not request an absent %s cursor (%s)', async (mode, nextCursor) => {
  const result = {
    items: [
      { ref: { kind: mode === 'products' ? 'product' : 'collection', id: 'item' }, title: 'Item' },
    ],
    nextCursor,
  };
  service.products.mockResolvedValue(result as never);
  service.storeCollections.mockResolvedValue(result as never);
  act(() => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <CommercePickerSheet
          accountId="account"
          selected={[]}
          onSelect={jest.fn()}
          onClose={jest.fn()}
        />
      </QueryClientProvider>,
    );
  });
  if (mode === 'collections')
    act(() => renderer.root.findByProps({ testID: 'picker-commerce.collections' }).props.onPress());
  await waitUntil(
    () => (renderer.root.findAllByType(FlatList)[0]?.props.data?.length ?? 0) === 1,
    'empty-cursor page',
  );
  await act(async () =>
    renderer.root.findByType(FlatList).props.onEndReached({ distanceFromEnd: 0 }),
  );
  expect(mode === 'products' ? service.products : service.storeCollections).toHaveBeenCalledTimes(
    1,
  );
});

it.each(['products', 'collections'] as const)(
  'passes a new %s cursor through without normalizing it',
  async (mode) => {
    const page = (cursor?: string) => ({
      items: [
        {
          ref: { kind: mode === 'products' ? 'product' : 'collection', id: cursor ?? 'first' },
          title: 'Item',
        },
      ],
      nextCursor: cursor === undefined ? ' opaque cursor ' : null,
    });
    service.products.mockImplementation(async ({ cursor } = {}) => page(cursor) as never);
    service.storeCollections.mockImplementation(
      async (_accountId, cursor) => page(cursor) as never,
    );
    act(() => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <CommercePickerSheet
            accountId="account"
            selected={[]}
            onSelect={jest.fn()}
            onClose={jest.fn()}
          />
        </QueryClientProvider>,
      );
    });
    if (mode === 'collections')
      act(() =>
        renderer.root.findByProps({ testID: 'picker-commerce.collections' }).props.onPress(),
      );
    const rows = () => renderer.root.findAllByType(FlatList)[0]?.props.data ?? [];
    await waitUntil(() => rows().length === 1, 'first opaque-cursor page');
    await act(async () =>
      renderer.root.findByType(FlatList).props.onEndReached({ distanceFromEnd: 0 }),
    );
    await waitUntil(() => rows().length === 2, 'second opaque-cursor page');
    if (mode === 'products')
      expect(service.products).toHaveBeenLastCalledWith({
        query: undefined,
        cursor: ' opaque cursor ',
      });
    else expect(service.storeCollections).toHaveBeenLastCalledWith('account', ' opaque cursor ');
  },
);

it('starts a separate cursor history when the product search changes', async () => {
  service.products.mockImplementation(
    async ({ query, cursor } = {}) =>
      ({
        items: [
          {
            ref: { kind: 'product', id: `${query ?? 'all'}-${cursor ?? 'initial'}` },
            title: query ?? 'all',
          },
        ],
        nextCursor: cursor ? null : 'shared-cursor',
      }) as never,
  );
  act(() => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <CommercePickerSheet selected={[]} onSelect={jest.fn()} onClose={jest.fn()} />
      </QueryClientProvider>,
    );
  });
  const rows = () => renderer.root.findAllByType(FlatList)[0]?.props.data ?? [];
  await waitUntil(() => rows().length === 1, 'initial products');
  await act(async () =>
    renderer.root.findByType(FlatList).props.onEndReached({ distanceFromEnd: 0 }),
  );
  await waitUntil(() => rows().length === 2, 'second initial product page');
  act(() => renderer.root.findByProps({ testID: 'picker-search' }).props.onChangeText('chairs'));
  await waitUntil(
    () => rows().length === 1 && rows()[0].title === 'chairs',
    'new search first page',
  );
  await act(async () =>
    renderer.root.findByType(FlatList).props.onEndReached({ distanceFromEnd: 0 }),
  );
  await waitUntil(() => rows().length === 2, 'new search accepts its own cursor');
  expect(service.products).toHaveBeenLastCalledWith({ query: 'chairs', cursor: 'shared-cursor' });
});

it('starts a separate collection cursor history for each account and viewer', async () => {
  service.products.mockResolvedValue({ items: [], nextCursor: null } as never);
  service.storeCollections.mockImplementation(
    async (accountId, cursor) =>
      ({
        items: [
          {
            ref: { kind: 'collection', id: `${accountId}-${cursor ?? 'initial'}` },
            title: accountId,
          },
        ],
        nextCursor: cursor ? null : 'shared-cursor',
      }) as never,
  );
  const render = (accountId: string) => (
    <QueryClientProvider client={client}>
      <CommercePickerSheet
        accountId={accountId}
        selected={[]}
        onSelect={jest.fn()}
        onClose={jest.fn()}
      />
    </QueryClientProvider>
  );
  act(() => {
    renderer = TestRenderer.create(render('account-a'));
  });
  act(() => renderer.root.findByProps({ testID: 'picker-commerce.collections' }).props.onPress());
  const rows = () => renderer.root.findAllByType(FlatList)[0]?.props.data ?? [];
  await waitUntil(
    () => rows().length === 1 && rows()[0].title === 'account-a',
    'account A first page',
  );
  await act(async () =>
    renderer.root.findByType(FlatList).props.onEndReached({ distanceFromEnd: 0 }),
  );
  await waitUntil(() => rows().length === 2, 'account A second page');
  act(() => renderer.update(render('account-b')));
  await waitUntil(
    () => rows().length === 1 && rows()[0].title === 'account-b',
    'account B first page',
  );
  await act(async () =>
    renderer.root.findByType(FlatList).props.onEndReached({ distanceFromEnd: 0 }),
  );
  await waitUntil(() => rows().length === 2, 'account B accepts its own cursor');
  expect(service.storeCollections).toHaveBeenLastCalledWith('account-b', 'shared-cursor');
  mockViewerId = 'other-viewer';
  act(() => renderer.update(render('account-b')));
  await waitUntil(
    () =>
      Boolean(
        client.getQueryData(
          viewerQueryKeys.commerceCatalog('other-viewer', 'account-b', null, 'collections'),
        ),
      ),
    'other viewer first page',
  );
  await waitUntil(() => rows().length === 1, 'other viewer uses fresh history');
  await act(async () =>
    renderer.root.findByType(FlatList).props.onEndReached({ distanceFromEnd: 0 }),
  );
  await waitUntil(() => rows().length === 2, 'other viewer accepts its own cursor');
});
