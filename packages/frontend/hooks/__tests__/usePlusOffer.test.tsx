import TestRenderer, { act } from 'react-test-renderer';
import { usePlusOffer } from '../usePlusOffer';

const mockPlans = jest.fn();
const mockAccess = jest.fn();
let mockAccount = 'account-a';
let mockSession = 'session-a';
let mockSignedIn = true;
let mockQueryOptions: Array<{
  queryKey: unknown[];
  enabled: boolean;
  queryFn(): Promise<unknown>;
}> = [];
let mockResult: ReturnType<typeof usePlusOffer>;
const mockBinding = {
  productId: 'product',
  capabilityKey: 'plus',
  offerId: 'offer',
  offerVersion: 1,
};
const mockOffer = {
  productId: 'product',
  offerId: 'offer',
  offerVersion: 1,
  displayName: 'Plus',
  price: { currency: 'USD', amountMinorUnits: 500, interval: 'month' },
};
let mockHasAccess = false;
let mockQueryError = false;
jest.mock('@/config', () => ({
  MENTION_PLUS_OFFER_ID: 'offer',
  MENTION_PLUS_OFFER_VERSION: '1',
  MENTION_PLUS_ANNUAL_OFFER_ID: 'annual',
  MENTION_PLUS_ANNUAL_OFFER_VERSION: '2',
  MENTION_PLUS_PRODUCT_ID: 'product',
  MENTION_PLUS_CAPABILITY_KEY: 'plus',
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({
    user: { id: mockAccount },
    canUsePrivateApi: mockSignedIn,
    oxyServices: { billing: { productPlans: mockPlans, productAccess: mockAccess } },
  }),
  useOxy: () => ({ activeSessionId: mockSession }),
}));
jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: unknown[]; enabled: boolean; queryFn(): Promise<unknown> }) => {
    mockQueryOptions.push(options);
    return {
      data: options.queryKey.includes('mention-plus-access') ? mockHasAccess : mockOffer,
      isPending: false,
      isError: mockQueryError,
    };
  },
}));
function Probe() {
  mockResult = usePlusOffer();
  return null;
}
let renderer: TestRenderer.ReactTestRenderer;
beforeEach(() => {
  mockAccount = 'account-a';
  mockSession = 'session-a';
  mockSignedIn = true;
  mockHasAccess = false;
  mockQueryError = false;
  mockQueryOptions = [];
  mockPlans.mockResolvedValue({ productId: 'product', purchase: 'available', plans: [mockOffer] });
  mockAccess.mockResolvedValue({
    subjectAccountId: 'account-a',
    productId: 'product',
    capabilities: [{ key: 'plus', grantIds: ['grant'] }],
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
});
it('fetches public product pricing while signed out and keeps access disabled', async () => {
  mockSignedIn = false;
  act(() => {
    renderer = TestRenderer.create(<Probe />);
  });
  expect(mockQueryOptions[0].enabled).toBe(true);
  expect(mockQueryOptions[1].enabled).toBe(false);
  expect(await mockQueryOptions[0].queryFn()).toEqual(mockOffer);
  expect(mockPlans).toHaveBeenCalledWith('product');
  expect(mockResult.hasAccess).toBe(false);
});
it('checks the exact product capability for the original account and rejects stale identity', async () => {
  act(() => {
    renderer = TestRenderer.create(<Probe />);
  });
  expect(await mockQueryOptions[1].queryFn()).toBe(true);
  expect(mockAccess).toHaveBeenCalledWith({
    schemaVersion: 1,
    productId: mockBinding.productId,
    subjectAccountId: 'account-a',
  });
  mockAccess.mockResolvedValue({
    subjectAccountId: 'account-b',
    productId: 'product',
    capabilities: [],
  });
  await expect(mockQueryOptions[1].queryFn()).rejects.toThrow('Account changed');
});
it('drops access and price on authority failure and isolates account/session query keys', () => {
  mockHasAccess = true;
  act(() => {
    renderer = TestRenderer.create(<Probe />);
  });
  expect(mockResult.hasAccess).toBe(true);
  const priorKey = mockQueryOptions[1].queryKey;
  mockAccount = 'account-b';
  mockSession = 'session-b';
  mockQueryError = true;
  act(() => {
    renderer.update(<Probe />);
  });
  expect(mockQueryOptions[3].queryKey).not.toEqual(priorKey);
  expect(mockResult.hasAccess).toBe(false);
  expect(mockResult.accessFailed).toBe(true);
  expect(mockResult.offer).toBeNull();
});
it('recognizes existing included access without a standalone offer being configured', () => {
  jest.isolateModules(() => {
    const config = jest.requireMock('@/config') as Record<string, string | undefined>;
    const original = config.MENTION_PLUS_OFFER_ID;
    config.MENTION_PLUS_OFFER_ID = undefined;
    try {
      const isolated = require('../usePlusOffer') as typeof import('../usePlusOffer');
      mockHasAccess = true;
      mockQueryOptions = [];
      function IsolatedProbe() {
        mockResult = isolated.usePlusOffer();
        return null;
      }
      act(() => {
        renderer = TestRenderer.create(<IsolatedProbe />);
      });
      const result = mockResult;
      expect(mockQueryOptions[0].enabled).toBe(false);
      expect(mockQueryOptions[1].enabled).toBe(true);
      expect(result.hasAccess).toBe(true);
      expect(result.offer).toBeNull();
    } finally {
      config.MENTION_PLUS_OFFER_ID = original;
    }
  });
});
it('does not guess entitlement identity when product registration is missing', async () => {
  let read: (() => Promise<unknown>) | undefined;
  jest.isolateModules(() => {
    const config = jest.requireMock('@/config') as Record<string, string | undefined>;
    const original = config.MENTION_PLUS_PRODUCT_ID;
    config.MENTION_PLUS_PRODUCT_ID = undefined;
    try {
      const isolated = require('../usePlusOffer') as typeof import('../usePlusOffer');
      mockQueryOptions = [];
      function IsolatedProbe() {
        mockResult = isolated.usePlusOffer();
        return null;
      }
      act(() => {
        renderer = TestRenderer.create(<IsolatedProbe />);
      });
      expect(mockResult.hasAccess).toBe(false);
      expect(mockQueryOptions[1].enabled).toBe(false);
      read = mockQueryOptions[1].queryFn;
    } finally {
      config.MENTION_PLUS_PRODUCT_ID = original;
    }
  });
  await expect(read?.()).rejects.toThrow('Sign in required');
});

it('checks the exact annual binding against the approved monthly amount and keeps price query keys distinct', async () => {
  function AnnualProbe() {
    mockResult = usePlusOffer('year');
    return null;
  }
  const annual = {
    ...mockOffer,
    offerId: 'annual',
    offerVersion: 2,
    price: { ...mockOffer.price, amountMinorUnits: 4800, interval: 'year' },
  };
  mockPlans.mockResolvedValue({
    productId: 'product',
    purchase: 'available',
    plans: [mockOffer, annual],
  });
  act(() => {
    renderer = TestRenderer.create(<AnnualProbe />);
  });
  expect(await mockQueryOptions[0].queryFn()).toEqual(annual);
  expect(mockResult.binding).toMatchObject({ offerId: 'annual', offerVersion: 2 });
  expect(mockQueryOptions[0].queryKey).toContain('offer');
  expect(mockQueryOptions[0].queryKey).toContain('annual');
  mockPlans.mockResolvedValue({
    productId: 'product',
    purchase: 'available',
    plans: [mockOffer, { ...annual, price: { ...annual.price, amountMinorUnits: 4900 } }],
  });
  expect(await mockQueryOptions[0].queryFn()).toBeNull();
});
