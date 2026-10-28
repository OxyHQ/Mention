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
jest.mock('@oxy.so/bloom/list', () => {
  const { View } = jest.requireActual('react-native');
  return {
    VirtualList: ({
      data,
      ...props
    }: {
      data: { key: string }[];
      renderItem: (info: { item: { key: string }; index: number }) => ReactNode;
    }) => (
      <View testID="shop-virtual-list" {...props} getData={() => data}>
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
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  service.storefront.mockResolvedValue(store);
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
  expect(service.storeProducts).toHaveBeenCalledWith('account-a', undefined);
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
      listContentHeaderComponent={<></>}
      listStickyHeaderComponent={<></>}
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
  const layout: { span?: number } = {};
  list.props.overrideItemLayout(layout, data[0]);
  expect(layout.span).toBe(2);
});
