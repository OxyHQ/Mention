const mockValues = new Map<string, string>();
const mockGet = jest.fn(async (key: string) => mockValues.get(key) ?? null);
const mockSet = jest.fn(async (key: string, value: string) => {
  mockValues.set(key, value);
});
const mockRemove = jest.fn(async (key: string) => {
  mockValues.delete(key);
});
const mockId = jest.fn();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (...args: [string]) => mockGet(...args),
  setItem: (...args: [string, string]) => mockSet(...args),
  removeItem: (...args: [string]) => mockRemove(...args),
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => mockId() }));
jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));
const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
afterEach(() => {
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
  else Reflect.deleteProperty(navigator, 'locks');
});
const offer = {
  productId: 'mention-product',
  capabilityKey: 'plus',
  offerId: 'approved',
  offerVersion: 2,
};
function tab() {
  let storage: typeof import('../plusCheckoutStorage') | undefined;
  jest.isolateModules(() => {
    storage = require('../plusCheckoutStorage');
  });
  if (!storage) throw new Error('Module failed to load');
  return storage;
}
beforeEach(() => {
  mockValues.clear();
  jest.clearAllMocks();
  mockId.mockReset().mockReturnValueOnce('key-a').mockReturnValue('key-b');
  let queue: Promise<unknown> = Promise.resolve();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (_key: string, run: () => Promise<unknown>) => {
        const result = queue.then(run);
        queue = result.catch(() => undefined);
        return result;
      },
    },
  });
});
it('two independent tabs retain one durable key rather than overwriting recovery', async () => {
  const a = tab();
  const b = tab();
  expect(
    await Promise.all([
      a.getPlusCheckoutKey('account', offer),
      b.getPlusCheckoutKey('account', offer),
    ]),
  ).toEqual(['key-a', 'key-a']);
  expect(mockSet).toHaveBeenCalledTimes(1);
});
it('fails before creating a key when browser coordination is unavailable', async () => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  await expect(tab().getPlusCheckoutKey('account', offer)).rejects.toThrow(
    'coordination unavailable',
  );
  expect(mockSet).not.toHaveBeenCalled();
});
it('a stale terminal reply cannot clear the key for a new operation', async () => {
  const storage = tab();
  const first = await storage.getPlusCheckoutKey('account', offer);
  await storage.clearPlusCheckoutKey('account', offer, first);
  const second = await storage.getPlusCheckoutKey('account', offer);
  await storage.clearPlusCheckoutKey('account', offer, first);
  expect(await storage.getPlusCheckoutKey('account', offer)).toBe(second);
  expect(second).not.toBe(first);
});
it('does not invent a checkout when durable storage cannot be written', async () => {
  mockSet.mockRejectedValueOnce(new Error('Storage unavailable'));
  await expect(tab().getPlusCheckoutKey('account', offer)).rejects.toThrow('Storage unavailable');
});
