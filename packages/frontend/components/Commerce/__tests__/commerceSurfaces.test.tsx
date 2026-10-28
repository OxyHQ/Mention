import { Linking, View } from 'react-native';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import type { MercariaCollection, MercariaProductSummary } from '@mercaria.co/sdk';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { waitUntil } from '@/test-support/waitUntil';
import { ProfileShop } from '../ProfileShop';
import { StorefrontSettings } from '../StorefrontSettings';
import { commerceService } from '@/services/commerceService';

jest.mock('@/services/commerceService', () => ({
  commerceService: {
    storefront: jest.fn(),
    storeProducts: jest.fn(),
    storeCollections: jest.fn(),
    featuredCollections: jest.fn(),
    featuredCollectionProducts: jest.fn(),
    connect: jest.fn(),
    disconnect: jest.fn(),
    metrics: jest.fn(),
    recordMetric: jest.fn(),
  },
}));
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => ({ user: { id: 'viewer' } }) }));
jest.mock('@oxy.so/bloom/screen', () => ({ useScreenVisible: () => true }));
jest.mock('@oxy.so/bloom/hooks', () => ({
  useContainerWidth: () => ({ width: 600, onLayout: jest.fn() }),
}));
let mockListMounts = 0;
jest.mock('@oxy.so/bloom/list', () => {
  const { View } = jest.requireActual('react-native');
  const { useEffect } = jest.requireActual('react');
  function MountProbe() {
    useEffect(() => {
      mockListMounts++;
    }, []);
    return null;
  }
  return {
    VirtualList: ({
      data,
      ...props
    }: {
      data: { key: string }[];
      renderItem: (info: { item: { key: string }; index: number }) => ReactNode;
    }) => (
      <View testID="shop-virtual-list" {...props} getData={() => data}>
        <MountProbe />
        {data.map((item, index) => (
          <View key={item.key}>{props.renderItem({ item, index })}</View>
        ))}
      </View>
    ),
  };
});
jest.mock('@oxy.so/bloom/button', () => {
  const { Pressable, Text } = jest.requireActual('react-native');
  return {
    Button: ({ children, ...props }: { children: ReactNode }) => (
      <Pressable {...props}>
        <Text>{children}</Text>
      </Pressable>
    ),
  };
});
jest.mock('@oxy.so/bloom/select', () => {
  const { View, Text } = jest.requireActual('react-native');
  return {
    Select: View,
    SelectContent: View,
    SelectItem: View,
    SelectTrigger: View,
    SelectValue: () => null,
    SelectItemText: Text,
  };
});
jest.mock('@oxy.so/bloom/switch', () => {
  const { View } = jest.requireActual('react-native');
  return { Switch: View };
});
jest.mock('@oxy.so/bloom/search', () => {
  const { TextInput } = jest.requireActual('react-native');
  return {
    Search: ({ label, ...props }: { label: string }) => (
      <TextInput accessibilityLabel={label} {...props} />
    ),
  };
});
jest.mock('@/components/Post/Attachments/CommerceCard', () => {
  const { Text } = jest.requireActual('react-native');
  return { CommerceCard: ({ referenceId }: { referenceId: string }) => <Text>{referenceId}</Text> };
});
jest.mock('@/components/common/EmptyState', () => {
  const { Text } = jest.requireActual('react-native');
  return { EmptyState: ({ title }: { title: string }) => <Text>{title}</Text> };
});
jest.mock('@/components/loading/ContentSkeleton', () => {
  const { Text } = jest.requireActual('react-native');
  return { ListSkeleton: () => <Text>Loading shop</Text> };
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const service = jest.mocked(commerceService);
const store = {
  state: 'available' as const,
  url: 'https://mercaria.co/stores/shop-a',
  ref: { kind: 'store' as const, id: 'store-1' },
  store: {
    ref: { kind: 'store' as const, id: 'store-1' },
    oxyAccountId: 'account-a',
    handle: 'shop-a',
    name: 'Shop A',
    description: null,
    logoUrl: null,
    coverImageUrl: null,
    brandColor: '#123456',
    rating: null,
    reviewCount: 0,
    url: 'https://mercaria.co/stores/shop-a',
  },
};
let renderer: TestRenderer.ReactTestRenderer;
let client: QueryClient;
const screen = () => JSON.stringify(renderer.toJSON());
function render(content: ReactNode) {
  act(() => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>{content}</QueryClientProvider>,
    );
  });
}
function button(label: string) {
  const element = renderer.root.findAll(
    (node) => typeof node.props.onPress === 'function' && node.props.children === label,
  )[0];
  if (!element) throw new Error(`Missing button ${label}`);
  return element;
}
beforeEach(() => {
  jest.resetAllMocks();
  mockListMounts = 0;
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  service.storefront.mockResolvedValue(store);
  service.featuredCollections.mockResolvedValue({ items: [], nextCursor: null });
  service.featuredCollectionProducts.mockResolvedValue({ items: [], nextCursor: null });
  service.storeProducts.mockResolvedValue({ items: [], nextCursor: null });
  service.storeCollections.mockResolvedValue({ items: [], nextCursor: null });
  service.recordMetric.mockResolvedValue(undefined);
  service.metrics.mockResolvedValue({
    periodDays: 30,
    minimumOpens: 10,
    suppressed: true,
    opens: null,
    handoffs: null,
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  client.clear();
});

it('does not load catalogs or record opens for a disconnected or transferred store', async () => {
  service.storefront.mockResolvedValue({ state: 'gone' });
  render(<ProfileShop accountId="account-a" />);
  await waitUntil(() => screen().includes('commerce.shopUnavailable'), 'unavailable shop');
  expect(service.storeProducts).not.toHaveBeenCalled();
  expect(service.storeCollections).not.toHaveBeenCalled();
  expect(service.recordMetric).not.toHaveBeenCalled();
});
it('loads both catalogs for the resolved account and presents empty/provider-failure states', async () => {
  service.storeCollections.mockRejectedValue(new Error('provider outage'));
  render(<ProfileShop accountId="account-a" />);
  await waitUntil(
    () => screen().includes('commerce.empty') && screen().includes('commerce.catalogUnavailable'),
    'empty products and failed collections',
  );
  expect(service.storeProducts).toHaveBeenCalledWith(
    'account-a',
    expect.objectContaining({ sort: 'newest', cursor: undefined }),
    expect.any(AbortSignal),
  );
  expect(service.storeCollections).toHaveBeenCalledWith('account-a', undefined);
  expect(service.recordMetric).toHaveBeenCalledTimes(1);
  expect(service.recordMetric).toHaveBeenCalledWith('stores', 'account-a', 'open');
});
it('does not expose one account’s shop while a different account loads', async () => {
  render(<ProfileShop accountId="account-a" />);
  await waitUntil(() => screen().includes('Shop A'), 'first shop');
  service.storefront.mockImplementation(() => new Promise(() => {}));
  act(() =>
    renderer.update(
      <QueryClientProvider client={client}>
        <ProfileShop accountId="account-b" />
      </QueryClientProvider>,
    ),
  );
  expect(screen()).not.toContain('Shop A');
  expect(screen()).toContain('Loading shop');
});
it('sends a connection only to the selected account and preserves refusal feedback', async () => {
  service.storefront.mockResolvedValue({ state: 'disconnected' });
  service.connect.mockRejectedValue(new Error('owner mismatch'));
  render(<StorefrontSettings accountId="account-a" />);
  expect(button('commerce.connect').props.disabled).toBe(true);
  const input = renderer.root.findAll(
    (node) =>
      node.props.accessibilityLabel === 'commerce.storeHandle' &&
      typeof node.props.onChangeText === 'function',
  )[0];
  act(() => input.props.onChangeText(' shop-a '));
  act(() => button('commerce.connect').props.onPress());
  await waitUntil(() => screen().includes('commerce.connectError'), 'connection refused');
  expect(service.connect).toHaveBeenCalledWith('account-a', 'shop-a');
  expect(service.disconnect).not.toHaveBeenCalled();
});
it('disconnects the selected account and refreshes its visible state', async () => {
  service.disconnect.mockImplementation(async () => {
    service.storefront.mockResolvedValue({ state: 'disconnected' });
  });
  render(<StorefrontSettings accountId="account-a" />);
  await waitUntil(() => screen().includes('Shop A'), 'connected settings');
  act(() => button('commerce.disconnect').props.onPress());
  await waitUntil(() => !screen().includes('Shop A'), 'connection cleared');
  expect(service.disconnect).toHaveBeenCalledWith('account-a');
});

it('uses one responsive virtualized grid and owns the native profile header/tab strip', async () => {
  render(
    <ProfileShop
      accountId="account-a"
      listContentHeaderComponent={<View testID="profile-header" />}
      listStickyHeaderComponent={<View testID="profile-tabs" />}
    />,
  );
  await waitUntil(() => screen().includes('Shop A'), 'virtualized shop');
  const list = renderer.root.findAll((node) => node.props.testID === 'shop-virtual-list')[0];
  expect(list.props.numColumns).toBe(2);
  expect(list.props.screen).toEqual({});
  expect(list.props.stickyHeaderIndices).toEqual([1]);
  const data: { key: string; kind: string }[] = list.props.getData();
  expect(data.slice(0, 2).map((row) => row.key)).toEqual(['profile-summary', 'profile-tabs']);
  expect(new Set(data.map((row) => row.key)).size).toBe(data.length);
  const layout: { span?: number } = { span: 1 };
  list.props.overrideItemLayout(layout, data[0]);
  expect(layout.span).toBe(2);
});

it('deduplicates overlapping catalog pages and uses full-width headings beside stable card cells', async () => {
  const product = (id: string): MercariaProductSummary => ({
    ref: { kind: 'product', id },
    title: id,
    primaryImage: null,
    price: { amount: 100, currency: 'EUR' },
    compareAtPrice: null,
    priceRange: null,
    availability: 'in_stock',
    condition: { key: 'new', group: 'new' },
    seller: {
      kind: 'store',
      store: { kind: 'store', id: 'store-1' },
      handle: 'shop-a',
      name: 'Shop A',
      logoUrl: null,
    },
    url: `https://mercaria.co/products/${id}`,
  });
  service.storeProducts
    .mockResolvedValueOnce({ items: [product('one')], nextCursor: 'page-2' })
    .mockResolvedValueOnce({ items: [product('one'), product('two')], nextCursor: null });
  render(<ProfileShop accountId="account-a" />);
  await waitUntil(() => screen().includes('mercaria:product:one'), 'first card');
  await act(async () => button('commerce.more').props.onPress());
  await waitUntil(() => screen().includes('mercaria:product:two'), 'next page');
  expect(service.storeProducts).toHaveBeenLastCalledWith(
    'account-a',
    expect.objectContaining({ sort: 'newest', cursor: 'page-2' }),
    expect.any(AbortSignal),
  );
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  service.recordMetric.mockRejectedValueOnce(new Error('counter offline'));
  await act(async () => button('commerce.visitStore').props.onPress());
  expect(open).toHaveBeenCalledWith(store.store.url);
  open.mockRestore();
  const list = renderer.root.findByProps({ testID: 'shop-virtual-list' });
  const rows: { key: string; kind: string }[] = list.props.getData();
  expect(rows.filter((row) => row.kind === 'card').map((row) => row.key)).toEqual([
    'mercaria:product:one',
    'mercaria:product:two',
  ]);
  for (const row of rows) {
    const layout: { span?: number } = { span: 1 };
    list.props.overrideItemLayout(layout, row);
    expect(layout.span).toBe(row.kind === 'card' ? 1 : 2);
    expect(list.props.keyExtractor(row)).toBe(row.key);
    expect(list.props.getItemType(row)).toBe(row.kind);
  }
});

it('debounces server search, resets bound cursors for filters and cancels superseded requests', async () => {
  service.storeProducts.mockResolvedValue({ items: [], nextCursor: 'old-page' });
  render(<ProfileShop accountId="account-a" />);
  await waitUntil(() => screen().includes('commerce.more'), 'initial newest page');
  await act(async () => button('commerce.more').props.onPress());
  await waitUntil(() => service.storeProducts.mock.calls.length === 2, 'second newest page');
  expect(service.storeProducts.mock.calls[1][1]?.cursor).toBe('old-page');
  let finishOld:
    | ((value: { items: MercariaProductSummary[]; nextCursor: null }) => void)
    | undefined;
  service.storeProducts.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOld = resolve;
      }),
  );
  const search = () =>
    renderer.root.findAll(
      (node) =>
        node.props.accessibilityLabel === 'commerce.searchProducts' &&
        typeof node.props.onChangeText === 'function',
    )[0];
  act(() => {
    search().props.onChangeText('ca');
    search().props.onChangeText('chair');
  });
  expect(service.storeProducts.mock.calls.length).toBe(2);
  await waitUntil(() => service.storeProducts.mock.calls.length === 3, 'debounced query');
  expect(service.storeProducts.mock.calls[2][1]).toMatchObject({
    query: 'chair',
    cursor: undefined,
    sort: 'newest',
  });
  const oldSignal = service.storeProducts.mock.calls[2][2];
  const toggle = renderer.root.findAll(
    (node) =>
      node.props.accessibilityLabel === 'commerce.inStockOnly' &&
      typeof node.props.onCheckedChange === 'function',
  )[0];
  act(() => toggle.props.onCheckedChange(true));
  await waitUntil(() => service.storeProducts.mock.calls.length === 4, 'available products');
  expect(oldSignal?.aborted).toBe(true);
  expect(service.storeProducts.mock.calls[3][1]).toMatchObject({
    query: 'chair',
    inStock: true,
    cursor: undefined,
  });
  const select = () =>
    renderer.root.findAll(
      (node) => node.props.value === 'newest' && typeof node.props.onValueChange === 'function',
    )[0];
  act(() => select().props.onValueChange('relevance'));
  await waitUntil(() => service.storeProducts.mock.calls.length === 5, 'relevance products');
  expect(service.storeProducts.mock.calls[4][1]).toMatchObject({
    query: 'chair',
    sort: 'relevance',
    cursor: undefined,
  });
  act(() => search().props.onChangeText(''));
  await waitUntil(
    () => service.storeProducts.mock.calls.length === 6,
    'clear search newest fallback',
  );
  expect(service.storeProducts.mock.calls[5][1]).toMatchObject({
    query: undefined,
    sort: 'newest',
    inStock: true,
    cursor: undefined,
  });
  await act(async () => finishOld?.({ items: [], nextCursor: null }));
  expect(
    renderer.root.findAll(
      (node) => node.props.value === 'newest' && typeof node.props.onValueChange === 'function',
    ),
  ).not.toHaveLength(0);
});

const featuredCollection = (id: string): MercariaCollection => ({
  ref: { kind: 'collection', id },
  store: store.ref,
  title: `Shelf ${id}`,
  description: null,
  image: null,
  url: `https://mercaria.co/collections/${id}`,
});
const featuredProduct = (id: string): MercariaProductSummary => ({
  ref: { kind: 'product', id },
  title: id,
  primaryImage: null,
  price: { amount: 100, currency: 'EUR' },
  compareAtPrice: null,
  priceRange: null,
  availability: 'in_stock',
  condition: { key: 'new', group: 'new' },
  seller: { kind: 'store', store: store.ref, handle: 'shop-a', name: 'Shop A', logoUrl: null },
  url: `https://mercaria.co/products/${id}`,
});
const cardKeys = () =>
  (
    renderer.root.findByProps({ testID: 'shop-virtual-list' }).props.getData() as {
      kind: string;
      key: string;
    }[]
  )
    .filter((item) => item.kind === 'card')
    .map((item) => item.key);

it('keeps seller shelf order and independent pages in one retained list, aborting removed shelves', async () => {
  service.featuredCollections.mockResolvedValue({
    items: [featuredCollection('b'), featuredCollection('a')],
    nextCursor: null,
  });
  let finish: ((page: { items: MercariaProductSummary[]; nextCursor: null }) => void) | undefined;
  service.featuredCollectionProducts.mockImplementation(async (_account, collectionId, cursor) => {
    if (cursor)
      return new Promise((resolve) => {
        finish = resolve;
      });
    return {
      items: [featuredProduct(collectionId)],
      nextCursor: collectionId === 'b' ? 'b-next' : null,
    };
  });
  render(<ProfileShop accountId="account-a" />);
  await waitUntil(() => cardKeys().length === 2, 'ordered shelf products');
  expect(cardKeys()).toEqual(['featured-b-mercaria:product:b', 'featured-a-mercaria:product:a']);
  const mounts = mockListMounts;
  const more = renderer.root.findAll(
    (node) =>
      node.props.accessibilityLabel === 'commerce.moreCollectionProducts' &&
      typeof node.props.onPress === 'function',
  )[0];
  act(() => {
    more.props.onPress();
  });
  await waitUntil(() => Boolean(finish), 'second shelf page pending');
  const last = service.featuredCollectionProducts.mock.calls.at(-1);
  if (!last) throw new Error('Missing shelf request');
  expect(last.slice(0, 3)).toEqual(['account-a', 'b', 'b-next']);
  service.featuredCollections.mockResolvedValue({
    items: [featuredCollection('a')],
    nextCursor: null,
  });
  await act(async () => {
    await client.invalidateQueries({
      queryKey: viewerQueryKeys.commerceCatalog(
        'viewer',
        'account-a',
        'store-1',
        'featured-collections',
      ),
    });
  });
  await waitUntil(() => cardKeys().length === 1, 'removed shelf hidden');
  expect(last[3]?.aborted).toBe(true);
  expect(cardKeys()).toEqual(['featured-a-mercaria:product:a']);
  await act(async () => finish?.({ items: [featuredProduct('late')], nextCursor: null }));
  expect(cardKeys()).toEqual(['featured-a-mercaria:product:a']);
  expect(mockListMounts).toBe(mounts);
  // Even a cached incoming account with the same store/collection IDs must
  // not borrow the outgoing account's query snapshot for a single render.
  client.setQueryData(viewerQueryKeys.commerceStorefront('viewer', 'account-b'), store);
  client.setQueryData(
    viewerQueryKeys.commerceCatalog('viewer', 'account-b', 'store-1', 'featured-collections'),
    { items: [featuredCollection('a')], nextCursor: null },
  );
  service.featuredCollectionProducts.mockImplementation(() => new Promise(() => {}));
  act(() =>
    renderer.update(
      <QueryClientProvider client={client}>
        <ProfileShop accountId="account-b" />
      </QueryClientProvider>,
    ),
  );
  expect(cardKeys()).toEqual([]);
});

it.each([404, 503])(
  'clears featured product presentation after a %s refresh failure',
  async (status) => {
    service.featuredCollections.mockResolvedValue({
      items: [featuredCollection('a')],
      nextCursor: null,
    });
    service.featuredCollectionProducts.mockResolvedValue({
      items: [featuredProduct('original')],
      nextCursor: null,
    });
    render(<ProfileShop accountId="account-a" />);
    await waitUntil(() => cardKeys().length === 1, 'featured product');
    service.featuredCollectionProducts.mockRejectedValue({ status });
    await act(async () => {
      await client.invalidateQueries({
        queryKey: viewerQueryKeys.commerceFeaturedProducts('viewer', 'account-a', 'store-1', 'a'),
      });
    });
    await waitUntil(() => cardKeys().length === 0, 'stale purchasable card removed');
    if (status === 404) expect(screen()).not.toContain('Shelf a');
    else expect(screen()).toContain('commerce.catalogUnavailable');
  },
);

it('keeps controls before curation and restores independent cached pages after filtering without duplicate observers', async () => {
  client.setDefaultOptions({ queries: { retry: false, gcTime: 5_000 } });
  service.featuredCollections.mockResolvedValue({
    items: [featuredCollection('b')],
    nextCursor: null,
  });
  service.featuredCollectionProducts.mockImplementation(async (_account, _collection, cursor) => ({
    items: [featuredProduct(cursor ? 'b2' : 'b1')],
    nextCursor: cursor ? null : 'b-next',
  }));
  service.storeProducts.mockImplementation(async (_account, params) =>
    params?.sort === 'price_asc'
      ? { items: [featuredProduct('filtered')], nextCursor: null }
      : {
          items: [featuredProduct(params?.cursor ? 'c2' : 'c1')],
          nextCursor: params?.cursor ? null : 'c-next',
        },
  );
  render(<ProfileShop accountId="account-a" />);
  await waitUntil(() => cardKeys().length === 2, 'first shelf and catalog pages');
  const data: { key: string }[] = renderer.root
    .findByProps({ testID: 'shop-virtual-list' })
    .props.getData();
  expect(data.findIndex((row) => row.key === 'product-controls')).toBeLessThan(
    data.findIndex((row) => row.key === 'featured-heading'),
  );
  const shelfMore = renderer.root.findAll(
    (node) =>
      node.props.accessibilityLabel === 'commerce.moreCollectionProducts' &&
      typeof node.props.onPress === 'function',
  )[0];
  await act(async () => shelfMore.props.onPress());
  const catalogMore = renderer.root.findAll(
    (node) =>
      node.props.children === 'commerce.more' &&
      !node.props.accessibilityLabel &&
      typeof node.props.onPress === 'function',
  )[0];
  await act(async () => catalogMore.props.onPress());
  await waitUntil(() => cardKeys().length === 4, 'independent second pages');
  const original = cardKeys();
  const select = (value: string) =>
    renderer.root.findAll(
      (node) => node.props.value === value && typeof node.props.onValueChange === 'function',
    )[0];
  act(() => select('newest').props.onValueChange('price_asc'));
  await waitUntil(
    () => cardKeys().join() === 'mercaria:product:filtered',
    'only server-filtered products',
  );
  const key = viewerQueryKeys.commerceFeaturedProducts('viewer', 'account-a', 'store-1', 'b');
  expect(client.getQueryCache().find({ queryKey: key, exact: true })?.getObserversCount()).toBe(0);
  expect(service.featuredCollectionProducts).toHaveBeenCalledTimes(2);
  act(() => select('price_asc').props.onValueChange('newest'));
  await waitUntil(() => cardKeys().length === 4, 'restored cached pages');
  expect(cardKeys()).toEqual(original);
  expect(service.featuredCollectionProducts).toHaveBeenCalledTimes(2);
  expect(client.getQueryCache().find({ queryKey: key, exact: true })?.getObserversCount()).toBe(1);
  expect(mockListMounts).toBe(1);
});
