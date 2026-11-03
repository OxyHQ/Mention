import TestRenderer, { act } from 'react-test-renderer';
import { useProductionCheckoutConfiguration } from '../useProductionCheckoutConfiguration';
const mockRead = jest.fn();
const mockWarm = jest.fn();
const mockUser = '698100000000000000000001';
let mockSession = 'session-a';
let mockPrivate = true;
let mockData: ReturnType<typeof useProductionCheckoutConfiguration>;
let mockResult: typeof mockData;
let mockOptions: { queryKey: readonly unknown[]; enabled: boolean; queryFn(): Promise<unknown> };
jest.mock('@peable.to/sdk/checkout', () => ({ loadProviderSdk: () => mockWarm() }));
jest.mock('@oxy.so/core', () => ({
  authenticatedApiCall: (_: unknown, __: unknown, run: () => unknown) => run(),
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({
    user: { id: mockUser },
    canUsePrivateApi: mockPrivate,
    oxyServices: { billing: { productCheckoutConfiguration: mockRead } },
  }),
  useOxy: () => ({ activeSessionId: mockSession }),
}));
jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: typeof mockOptions) => {
    mockOptions = options;
    return { data: mockData };
  },
}));
const review = {
  productId: 'mention',
  offerId: 'month',
  offerVersion: 1,
  amountMinorUnits: 599,
  currency: 'USD',
  interval: 'month' as const,
};
function Probe({ enabled = true }: { enabled?: boolean }) {
  mockResult = useProductionCheckoutConfiguration(enabled, review, 'offer-scope');
  return null;
}
it('warms only validated public configuration and isolates account/session and unavailable states', async () => {
  mockWarm.mockResolvedValue(undefined);
  const config = {
    state: 'ready',
    subjectAccountId: mockUser,
    productId: 'mention',
    merchantId: 'merch_owned',
    mode: 'live',
    environment: 'production',
    publishableKey: 'pk_live_owned',
    paymentMethods: [{ id: 'card', available: true }],
    offers: [
      {
        offerId: 'month',
        offerVersion: 1,
        amountMinorUnits: 599,
        currency: 'USD',
        interval: 'month',
      },
    ],
  };
  mockRead.mockResolvedValue(config);
  let tree: TestRenderer.ReactTestRenderer | undefined;
  try {
    act(() => {
      tree = TestRenderer.create(<Probe />);
    });
    expect(mockRead).not.toHaveBeenCalled();
    const key = mockOptions.queryKey;
    const result = await mockOptions.queryFn();
    expect(result).toMatchObject({ configuration: config });
    expect(mockRead).toHaveBeenCalledWith('mention', mockUser);
    expect(mockWarm).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('clientSecret');
    mockRead.mockResolvedValue({ ...config, merchantId: 'invalid' });
    expect(await mockOptions.queryFn()).toBeNull();
    expect(mockWarm).toHaveBeenCalledTimes(1);
    mockSession = 'session-b';
    act(() => tree?.update(<Probe />));
    expect(mockOptions.queryKey).not.toEqual(key);
    mockPrivate = false;
    act(() => tree?.update(<Probe enabled={false} />));
    expect(mockOptions.enabled).toBe(false);
    expect(mockResult).toBeUndefined();
  } finally {
    act(() => tree?.unmount());
    mockPrivate = true;
    mockSession = 'session-a';
  }
});
