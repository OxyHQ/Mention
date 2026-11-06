import { useEffect as mockUseEffect, type ComponentProps } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Linking, Platform } from 'react-native';
import type { PeableSheetCheckout, SheetCheckoutDetails } from '@peable.to/sdk/checkout/ui';
import { PlusPaymentSheet } from '../PlusPaymentSheet';
import type { PlusOffer } from '@/lib/payments/plusCheckout';

let mockProps: ComponentProps<typeof PeableSheetCheckout> | undefined;
let mockMounts = 0;
let mockUnmounts = 0;
const mockToast = jest.fn();
const mockCheckout = jest.fn();
const mockAccess = jest.fn();
const mockKey = jest.fn();
const mockClearKey = jest.fn();
const mockInvalidate = jest.fn().mockResolvedValue(undefined);
const mockSignIn = jest.fn();
const mockBrowser = jest.fn().mockResolvedValue({ type: 'cancel' });
const mockDismiss = jest.fn();
const mockClose = jest.fn();
let mockUser = {
  id: 'account-a',
  username: 'alex',
  email: 'alex@example.test',
  name: { displayName: 'Alex' },
};
let mockSession = 'session-a';
let mockPrivate = true;
let mockIncluded = false;
let mockAvailable = true;
const offer = {
  productId: 'mention',
  offerId: 'mention_plus_monthly',
  offerVersion: 1,
  displayName: 'Mention Plus',
  price: {
    currency: 'USD',
    amountMinorUnits: 599,
    interval: 'month' as const,
    trial: 'none',
    taxTreatment: 'inclusive',
    merchantTotal: 'final',
  },
};
let mockOffer: PlusOffer | null = offer;
const binding = {
  productId: 'mention',
  capabilityKey: 'plus',
  offerId: 'mention_plus_monthly',
  offerVersion: 1,
};
let mockBinding = binding;
const mockSessionId = 'cs_0123456789abcdef01234567';
const mockSecret = `${mockSessionId}_secret_0123456789abcdef`;
const mockUrl = `https://checkout.peable.to/c/${mockSessionId}#cs=${mockSecret}`;
const mockServices = {
  billing: { startProductPlanCheckout: mockCheckout, productAccess: mockAccess },
};

jest.mock('@peable.to/sdk/checkout/ui', () => ({
  PeableSheetCheckout: (props: ComponentProps<typeof PeableSheetCheckout>) => {
    mockProps = props;
    mockUseEffect(() => {
      mockMounts++;
      return () => {
        mockUnmounts++;
      };
    }, []);
    return <>Canonical Peable sheet</>;
  },
  SheetPreparationError: class extends Error {
    outcome: string;
    constructor(message: string, outcome: string) {
      super(message);
      this.outcome = outcome;
    }
  },
  sheetSourceFromUrl: (url: string) =>
    url === mockUrl
      ? { type: 'checkout_session', id: mockSessionId, clientSecret: mockSecret }
      : null,
}));
jest.mock('@/hooks/usePlusOffer', () => ({
  usePlusOffer: () => ({
    offer: mockOffer,
    binding: mockBinding,
    loading: false,
    failed: false,
    hasAccess: mockIncluded,
    purchaseAvailable: mockAvailable,
  }),
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({
    user: mockUser,
    oxyServices: mockServices,
    canUsePrivateApi: mockPrivate,
    signIn: mockSignIn,
  }),
  useOxy: () => ({ activeSessionId: mockSession }),
}));
jest.mock('@oxy.so/core', () => ({
  authenticatedApiCall: (_services: unknown, _session: unknown, run: () => unknown) => run(),
}));
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
}));
jest.mock('@/lib/payments/plusCheckoutStorage', () => ({
  getPlusCheckoutKey: (...args: unknown[]) => mockKey(...args),
  clearPlusCheckoutKey: (...args: unknown[]) => mockClearKey(...args),
}));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));
jest.mock('@oxy.so/bloom/button', () => ({ Button: (props: object) => <button {...props} /> }));
jest.mock('expo-web-browser', () => ({
  openBrowserAsync: (...args: unknown[]) => mockBrowser(...args),
  dismissBrowser: () => mockDismiss(),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const details: SheetCheckoutDetails = {
  email: 'alex@example.test',
  selectedAddressId: null,
  shipping: {
    name: '',
    line1: '',
    line2: '',
    city: '',
    state: '',
    postalCode: '',
    country: '',
    phone: '',
  },
};
let renderer: TestRenderer.ReactTestRenderer;
const originalOpen = window.open;
const originalOS = Platform.OS;
function preparation() {
  if (!mockProps?.preparation) throw new Error('canonical preparation missing');
  return mockProps.preparation;
}
async function mount() {
  await act(async () => {
    renderer = TestRenderer.create(<PlusPaymentSheet onClose={mockClose} />);
  });
}
async function prepare() {
  let result: Awaited<ReturnType<ReturnType<typeof preparation>['createSession']>> | undefined;
  await act(async () => {
    result = await preparation().createSession(details, { signal: new AbortController().signal });
  });
  return result;
}
beforeEach(() => {
  jest.clearAllMocks();
  mockProps = undefined;
  mockMounts = 0;
  mockUnmounts = 0;
  mockUser = {
    id: 'account-a',
    username: 'alex',
    email: 'alex@example.test',
    name: { displayName: 'Alex' },
  };
  mockSession = 'session-a';
  mockPrivate = true;
  mockIncluded = false;
  mockAvailable = true;
  mockOffer = offer;
  mockBinding = binding;
  mockAccess.mockResolvedValue({
    schemaVersion: 1,
    subjectAccountId: 'account-a',
    productId: 'mention',
    evaluatedAt: new Date().toISOString(),
    capabilities: [],
    quotas: [],
    conflicts: [],
  });
  mockKey.mockResolvedValue('durable-key');
  mockClearKey.mockResolvedValue(undefined);
  mockCheckout.mockResolvedValue({ state: 'pending', intentId: 'intent', checkoutUrl: mockUrl });
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  window.open = jest.fn();
});
afterEach(() => {
  act(() => renderer?.unmount());
  window.open = originalOpen;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
  jest.useRealTimers();
});

it('opens the canonical item and subscription review immediately without creating an operation', async () => {
  await mount();
  expect(mockMounts).toBe(1);
  expect(preparation().request).toMatchObject({
    dueTodayMinorUnits: 599,
    requiresShipping: false,
    requiresContact: false,
    paymentMethods: ['card', 'faircoin'],
    recurring: { amountMinorUnits: 599, interval: 'month' },
    items: [
      { id: 'mention_plus_monthly', name: 'Mention Plus', quantity: 1, amountMinorUnits: 599 },
    ],
  });
  expect(preparation().renderAdditionalDetails).toBeUndefined();
  expect(renderer.root.findAllByType('button')).toHaveLength(0);
  expect(mockAccess).not.toHaveBeenCalled();
  expect(mockCheckout).not.toHaveBeenCalled();
  expect(mockKey).not.toHaveBeenCalled();
});
it('hands the authoritative session to the same mounted SDK only after Continue', async () => {
  await mount();
  const result = await prepare();
  expect(result).toEqual({
    source: { type: 'checkout_session', id: mockSessionId, clientSecret: mockSecret },
    expected: { amount: '599', currency: 'USD' },
  });
  expect(mockCheckout).toHaveBeenCalledWith({
    expectedSubjectAccountId: 'account-a',
    productId: 'mention',
    offerId: 'mention_plus_monthly',
    offerVersion: 1,
    idempotencyKey: 'durable-key',
  });
  expect(mockMounts).toBe(1);
  expect(mockUnmounts).toBe(0);
  expect(mockInvalidate).not.toHaveBeenCalled();
  expect(window.open).not.toHaveBeenCalled();
});
it('retains the original offer and durable key through ambiguous retries', async () => {
  mockCheckout.mockRejectedValueOnce(new Error('network lost'));
  await mount();
  await expect(prepare()).rejects.toThrow('plus.payment.failed');
  mockOffer = { ...offer, price: { ...offer.price, amountMinorUnits: 999 } };
  await act(async () => renderer.update(<PlusPaymentSheet onClose={mockClose} />));
  expect(preparation().request.dueTodayMinorUnits).toBe(599);
  expect(await prepare()).toMatchObject({ expected: { amount: '599' } });
  expect(mockKey).toHaveBeenCalledTimes(1);
  expect(mockClearKey).not.toHaveBeenCalled();
  expect(mockCheckout.mock.calls[1]).toEqual(mockCheckout.mock.calls[0]);
});
it('never grants access merely because Peable closes; it polls Oxy until fulfilled', async () => {
  jest.useFakeTimers();
  await mount();
  await prepare();
  await act(async () => {
    mockProps?.onSettled('complete');
  });
  expect(mockProps?.outcome).toBeNull();
  expect(mockInvalidate).not.toHaveBeenCalled();
  mockCheckout.mockResolvedValue({ state: 'fulfilled', intentId: 'intent' });
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  expect(mockProps?.outcome).toBe('succeeded');
  expect(mockInvalidate).toHaveBeenCalledTimes(2);
  expect(mockClearKey).toHaveBeenCalledWith('account-a', binding, 'durable-key');
});
it('stops a late account A response from becoming account B checkout', async () => {
  let resolve: (value: unknown) => void = () => {};
  mockCheckout.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await mount();
  let attempt: Promise<unknown> = Promise.resolve();
  await act(async () => {
    attempt = preparation()
      .createSession(details, { signal: new AbortController().signal })
      .catch(() => undefined);
  });
  mockUser = { ...mockUser, id: 'account-b' };
  mockSession = 'session-b';
  await act(async () => renderer.update(<PlusPaymentSheet onClose={mockClose} />));
  await act(async () => {
    resolve({ state: 'fulfilled' });
    await attempt;
  });
  expect(mockProps?.outcome).toBeNull();
  expect(mockClearKey).not.toHaveBeenCalled();
  expect(mockInvalidate).not.toHaveBeenCalled();
  expect(preparation().key).toContain('account-b');
});
it('does not offer another purchase when Oxy One or standalone access already includes Plus', async () => {
  mockIncluded = true;
  await mount();
  expect(mockClose).toHaveBeenCalled();
  expect(mockCheckout).not.toHaveBeenCalled();
  expect(preparation().canContinue).toBe(false);
});
it('keeps signed-out review in the same SDK and makes sign-in an explicit prerequisite', async () => {
  mockPrivate = false;
  await mount();
  expect(preparation().canContinue).toBe(false);
  expect(preparation().renderAdditionalDetails).toBeDefined();
  await expect(prepare()).rejects.toThrow('plus.payment.signInRequired');
  expect(mockCheckout).not.toHaveBeenCalled();
});
it('refuses unknown URLs without opening an alternative checkout or losing the key', async () => {
  mockCheckout.mockResolvedValue({
    state: 'pending',
    checkoutUrl: 'https://checkout.peable.to/legacy',
  });
  await mount();
  await expect(prepare()).rejects.toThrow();
  expect(window.open).not.toHaveBeenCalled();
  expect(mockClearKey).not.toHaveBeenCalled();
});
it('preserves the durable key when the session cannot be read and on dismissal', async () => {
  await mount();
  await prepare();
  await act(async () => mockProps?.onUnavailable('unreadable'));
  expect(mockClose).toHaveBeenCalled();
  expect(mockClearKey).not.toHaveBeenCalled();
});
it('opens a requested secure page with no opener, and a native wallet through its link', async () => {
  const page = { opener: 'parent', location: { replace: jest.fn() }, close: jest.fn() };
  window.open = jest.fn().mockReturnValue(page);
  await mount();
  await act(async () => {
    await mockProps?.openUrl?.(mockUrl, 'hosted');
  });
  expect(page.opener).toBeNull();
  expect(page.location.replace).toHaveBeenCalledWith(mockUrl);
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  await act(async () => {
    await mockProps?.openUrl?.('peable://pay?intent=pi_fixture', 'wallet');
  });
  expect(open).toHaveBeenCalled();
  open.mockRestore();
});

it('exits an authoritative review hold after settlement without granting or inventing failure', async () => {
  await mount();
  await prepare();
  mockCheckout.mockRejectedValue(new Error('PAYMENT_REVIEW_REQUIRED'));
  await act(async () => mockProps?.onSettled('complete'));
  expect(mockToast).toHaveBeenCalledWith('plus.payment.review', { type: 'error' });
  expect(mockClose).toHaveBeenCalledTimes(1);
  expect(mockProps?.outcome).toBeNull();
  expect(mockInvalidate).not.toHaveBeenCalled();
  expect(mockClearKey).not.toHaveBeenCalled();
});
it('recovers a submitted operation when the catalog later disables new purchases', async () => {
  mockCheckout.mockRejectedValueOnce(new Error('connection lost'));
  await mount();
  await expect(prepare()).rejects.toThrow();
  mockAvailable = false;
  await act(async () => renderer.update(<PlusPaymentSheet onClose={mockClose} />));
  expect(preparation().canContinue).toBe(true);
  expect(await prepare()).toMatchObject({ expected: { amount: '599' } });
  expect(mockClose).not.toHaveBeenCalled();
  expect(mockKey).toHaveBeenCalledTimes(1);
});
it('refuses a duplicate Continue while the original operation is still pending', async () => {
  let resolve: (value: unknown) => void = () => {};
  mockCheckout.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await mount();
  let first: Promise<unknown> = Promise.resolve();
  await act(async () => {
    first = preparation().createSession(details, { signal: new AbortController().signal });
  });
  await expect(prepare()).rejects.toThrow('plus.payment.pending');
  expect(mockCheckout).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolve({ state: 'pending', checkoutUrl: mockUrl });
    await first;
  });
});

it('rechecks bundle inclusion before obtaining a key or starting an order', async () => {
  mockAccess.mockResolvedValue({
    subjectAccountId: 'account-a',
    productId: 'mention',
    capabilities: [{ key: 'plus', grantIds: ['bundle-grant'] }],
  });
  await mount();
  await expect(prepare()).rejects.toThrow();
  expect(mockClose).toHaveBeenCalledTimes(1);
  expect(mockKey).not.toHaveBeenCalled();
  expect(mockCheckout).not.toHaveBeenCalled();
});
it('uses the approved annual offer and amount without deriving a price in the browser', async () => {
  mockOffer = {
    ...offer,
    offerId: 'mention_plus_annual',
    price: { ...offer.price, amountMinorUnits: 5750, interval: 'year' },
  };
  mockBinding = { ...binding, offerId: 'mention_plus_annual' };
  await act(async () => {
    renderer = TestRenderer.create(<PlusPaymentSheet onClose={mockClose} cadence="year" />);
  });
  expect(preparation().request.recurring).toMatchObject({
    amountMinorUnits: 5750,
    interval: 'year',
  });
  expect(await prepare()).toMatchObject({ expected: { amount: '5750', currency: 'USD' } });
  expect(mockCheckout).toHaveBeenCalledWith(
    expect.objectContaining({ offerId: 'mention_plus_annual' }),
  );
});
it('does not grant Plus when a native browser is dismissed', async () => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
  await mount();
  await prepare();
  await act(async () => {
    await mockProps?.openUrl?.(mockUrl, 'hosted');
  });
  expect(mockBrowser).toHaveBeenCalledWith(mockUrl);
  expect(mockProps?.outcome).toBeNull();
  expect(mockInvalidate).not.toHaveBeenCalled();
  expect(mockClearKey).not.toHaveBeenCalled();
});
