import type { MercariaProduct } from '@mercaria.co/sdk';
import { commerceCards } from '../commerceCards';
import { commerceService } from '@/services/commerceService';
jest.mock('@/services/commerceService', () => ({ commerceService: { hydrate: jest.fn() } }));
const hydrate = jest.mocked(commerceService.hydrate);
const product = (id: string): MercariaProduct => ({
  ref: { kind: 'product', id },
  title: 'Current product',
  primaryImage: null,
  price: { amount: 12900, currency: 'EUR' },
  compareAtPrice: null,
  priceRange: null,
  availability: 'in_stock',
  condition: { key: 'new', group: 'new' },
  seller: {
    kind: 'store',
    store: { kind: 'store', id: 'store-test' },
    handle: 'test',
    name: 'Test',
    logoUrl: null,
  },
  url: `https://mercaria.co/products/${id}`,
  description: '',
  images: [],
  purchaseOptions: [],
  updatedAt: '2026-10-28T00:00:00Z',
  viewer: null,
});
const stops: (() => void)[] = [];
beforeEach(() => {
  jest.useFakeTimers();
  hydrate.mockReset();
});
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  jest.useRealTimers();
});

it('does no work before visibility, batches at24 and deduplicates repeated cards', async () => {
  hydrate.mockImplementation(async (refs) => ({
    items: refs.map((ref) => ({
      state: 'available' as const,
      ref: { kind: 'product' as const, id: ref.id },
      product: product(ref.id),
      url: product(ref.id).url,
    })),
  }));
  expect(hydrate).not.toHaveBeenCalled();
  for (let index = 0; index < 27; index++)
    stops.push(commerceCards.subscribe(`mercaria:product:p${index}`, jest.fn()));
  stops.push(commerceCards.subscribe('mercaria:product:p0', jest.fn()));
  await jest.advanceTimersByTimeAsync(16);
  expect(hydrate.mock.calls.map((call) => call[0].length)).toEqual([24, 3]);
  expect(commerceCards.getSnapshot('mercaria:product:p0').status).toBe('ready');
});
it('drops expired price before refreshing and never restores it after an outage', async () => {
  const item = product('expire');
  hydrate
    .mockResolvedValueOnce({
      items: [{ state: 'available', ref: item.ref, product: item, url: item.url }],
    })
    .mockRejectedValueOnce(new Error('offline'));
  stops.push(commerceCards.subscribe('mercaria:product:expire', jest.fn()));
  await jest.advanceTimersByTimeAsync(16);
  expect(commerceCards.getSnapshot('mercaria:product:expire').status).toBe('ready');
  await jest.advanceTimersByTimeAsync(30_000);
  expect(commerceCards.getSnapshot('mercaria:product:expire')).toEqual({ status: 'loading' });
  await jest.advanceTimersByTimeAsync(16);
  expect(commerceCards.getSnapshot('mercaria:product:expire')).toEqual({ status: 'unavailable' });
});
it('rejects a substituted product identity and stops holding facts after the last reader leaves', async () => {
  const item = product('wrong-product');
  hydrate.mockResolvedValue({
    items: [{ state: 'available', ref: item.ref, product: item, url: item.url }],
  });
  const stop = commerceCards.subscribe('mercaria:product:requested', jest.fn());
  stops.push(stop);
  await jest.advanceTimersByTimeAsync(16);
  expect(commerceCards.getSnapshot('mercaria:product:requested')).toEqual({
    status: 'unavailable',
  });
  stop();
  expect(commerceCards.getSnapshot('mercaria:product:requested')).toEqual({ status: 'loading' });
});
