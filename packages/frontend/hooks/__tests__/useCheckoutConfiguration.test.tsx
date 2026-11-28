import TestRenderer, { act } from 'react-test-renderer';
import { useCheckoutConfiguration } from '../useCheckoutConfiguration';
import type { CheckoutConfiguration } from '@/lib/payments/checkoutConfiguration';
const mockRead = jest.fn();
const mockWarm = jest.fn();
let mockData: CheckoutConfiguration | undefined;
let mockResult: CheckoutConfiguration | undefined;
let mockOptions: {
  queryKey: readonly unknown[];
  enabled: boolean;
  queryFn(input: { signal: AbortSignal }): Promise<CheckoutConfiguration>;
  refetchInterval(input: { state: { data?: CheckoutConfiguration } }): number;
};
jest.mock('@/lib/payments/checkoutConfiguration', () => ({
  readLocalCheckoutConfiguration: (...args: unknown[]) => mockRead(...args),
}));
jest.mock('@peable.to/sdk/checkout', () => ({
  loadProviderSdk: (...args: unknown[]) => mockWarm(...args),
}));
jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: typeof mockOptions) => {
    mockOptions = options;
    return { data: mockData };
  },
}));
function Probe({ enabled = true, user = 'a', session = 'session-a', scope = 'offer-a' }) {
  mockResult = useCheckoutConfiguration(enabled, user, session, scope);
  return null;
}
it('scopes public warmup, honors expiry, and warms only the script after a valid read', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'location');
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { href: 'http://localhost:8110/plus' },
  });
  mockData = { expiresAt: Date.now() + 60_000 } as CheckoutConfiguration;
  mockRead.mockResolvedValue(mockData);
  mockWarm.mockRejectedValue(new Error('offline script'));
  let tree: TestRenderer.ReactTestRenderer | undefined;
  try {
    act(() => {
      tree = TestRenderer.create(<Probe />);
    });
    const key = mockOptions.queryKey;
    expect(mockResult).toBe(mockData);
    expect(mockOptions.enabled).toBe(true);
    const signal = new AbortController().signal;
    await expect(mockOptions.queryFn({ signal })).resolves.toBe(mockData);
    expect(mockRead).toHaveBeenCalledWith('http://localhost:8110/plus', signal);
    expect(mockWarm).toHaveBeenCalledTimes(1);
    expect(mockOptions.refetchInterval({ state: { data: mockData } })).toBeGreaterThan(40_000);
    expect(mockOptions.refetchInterval({ state: {} })).toBe(5000);
    act(() => tree?.update(<Probe user="b" session="session-b" scope="annual" />));
    expect(mockOptions.queryKey).not.toEqual(key);
    mockData = { ...mockData, expiresAt: Date.now() - 1 };
    act(() => tree?.update(<Probe />));
    expect(mockResult).toBeUndefined();
    expect(mockOptions.refetchInterval({ state: { data: mockData } })).toBe(1000);
    act(() => tree?.update(<Probe enabled={false} />));
    expect(mockOptions.enabled).toBe(false);
    expect(mockResult).toBeUndefined();
  } finally {
    act(() => tree?.unmount());
    if (descriptor) Object.defineProperty(window, 'location', descriptor);
    else Reflect.deleteProperty(window, 'location');
  }
});
