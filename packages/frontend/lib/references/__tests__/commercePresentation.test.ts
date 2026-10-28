import { commerceCards, recordCommerceHandoff } from '../commerceCards';
const mockHydrate = jest.fn();
const mockMetric = jest.fn();
jest.mock('@/services/commerceService', () => ({
  commerceService: {
    hydrate: (...args: unknown[]) => mockHydrate(...args),
    recordMetric: (...args: unknown[]) => mockMetric(...args),
  },
}));
jest.mock('@mercaria.co/sdk', () => ({
  parseMercariaRefString: (id: string) =>
    id.startsWith('mercaria:product:')
      ? { provider: 'mercaria', kind: 'product', id: id.slice(17) }
      : null,
  formatMercariaRef: (ref: { id: string }) => `mercaria:product:${ref.id}`,
  formatMoney: (_price: unknown, locale: string) => `${locale}:12.90`,
}));
const ref = (id: string) => ({ provider: 'mercaria', kind: 'product', id });
beforeEach(() => {
  jest.useFakeTimers();
  mockHydrate.mockReset();
  mockMetric.mockReset();
});
afterEach(() => jest.useRealTimers());
it('deduplicates visible facts, rejects mismatched provider identity and clears facts at expiry', async () => {
  mockHydrate.mockResolvedValue({
    items: [
      { state: 'available', ref: ref('a'), product: { price: { amount: 12900, currency: 'EUR' } } },
    ],
  });
  const stop = commerceCards.subscribe('mercaria:product:a', jest.fn());
  const duplicate = commerceCards.subscribe('mercaria:product:a', jest.fn());
  await jest.advanceTimersByTimeAsync(16);
  expect(mockHydrate).toHaveBeenCalledTimes(1);
  const ready = commerceCards.getSnapshot('mercaria:product:a');
  expect(ready.status).toBe('ready');
  if (ready.status !== 'ready') throw new Error('Expected current facts');
  expect(ready.value.formatPrice?.('es')).toBe('es:12.90');
  mockHydrate.mockResolvedValue({
    items: [{ state: 'available', ref: ref('other'), product: {} }],
  });
  await jest.advanceTimersByTimeAsync(30_016);
  expect(commerceCards.getSnapshot('mercaria:product:a').status).toBe('unavailable');
  stop();
  duplicate();
});
it('bounds a viewport to sequential API batches and ignores invalid references', async () => {
  mockHydrate.mockImplementation(async (refs: { id: string }[]) => ({
    items: refs.map((value) => ({ state: 'unavailable', ref: value })),
  }));
  const stops = Array.from({ length: 49 }, (_, i) =>
    commerceCards.subscribe(`mercaria:product:${i}`, jest.fn()),
  );
  stops.push(commerceCards.subscribe('invalid', jest.fn()));
  await jest.advanceTimersByTimeAsync(16);
  expect(mockHydrate.mock.calls.map(([refs]) => refs.length)).toEqual([24, 24, 1]);
  expect(commerceCards.getSnapshot('invalid').status).toBe('unavailable');
  for (const stop of stops) stop();
});
it('does not expose facts from an incomplete response and records only an explicit handoff', async () => {
  mockHydrate.mockResolvedValue({ items: [] });
  const stop = commerceCards.subscribe('mercaria:product:b', jest.fn());
  await jest.advanceTimersByTimeAsync(16);
  expect(commerceCards.getSnapshot('mercaria:product:b').status).not.toBe('ready');
  expect(mockMetric).not.toHaveBeenCalled();
  await recordCommerceHandoff('post-a');
  expect(mockMetric).toHaveBeenCalledWith('posts', 'post-a', 'handoff');
  stop();
});
