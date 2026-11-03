jest.mock('../PeableEmbeddedCheckout', () => ({ PeableEmbeddedCheckout: () => null }));
import TestRenderer, { act } from 'react-test-renderer';
import { Platform } from 'react-native';
import { PlusPaymentSheet } from '../PlusPaymentSheet';

let mockOffer: typeof offer | null;
const mockPlans = jest.fn();
const mockAccess = jest.fn();
let mockHasAccess = false;
let mockPreview = false;
let mockPurchaseAvailable = true;
let mockSignedIn = true;
let mockDisplayCurrency = 'USD';
const mockFormatUsd = jest.fn(() => 'EUR conversion unavailable');
const mockSheet = jest.fn();
const mockPreviewContent = jest.fn();
jest.mock('../LocalCheckoutPreview', () => ({
  LocalCheckoutPreview: (props: unknown) => {
    mockPreviewContent(props);
    return <>Local checkout preview</>;
  },
}));
const mockCheckout = jest.fn();
const mockKey = jest.fn();
const mockClearKey = jest.fn();
const mockInvalidate = jest.fn().mockResolvedValue(undefined);
const mockNativeBrowser = jest.fn().mockResolvedValue({ type: 'cancel' });
const mockDismiss = jest.fn();
let mockUser = { id: 'account-a' };
let mockSession = 'session-a';
const mockServices = {
  billing: {
    productPlans: mockPlans,
    startProductPlanCheckout: mockCheckout,
    productAccess: mockAccess,
  },
};
const mockLocation = { replace: jest.fn() };
const mockClose = jest.fn();
let mockPopup: {
  closed: boolean;
  close: typeof mockClose;
  location: typeof mockLocation;
  opener: unknown;
};
jest.mock('@/config', () => ({
  get MENTION_PLUS_UI_PREVIEW() {
    return mockPreview;
  },
  MENTION_PLUS_PRODUCT_ID: 'mention-product',
  MENTION_PLUS_CAPABILITY_KEY: 'plus',
  MENTION_PLUS_OFFER_ID: 'approved',
  MENTION_PLUS_OFFER_VERSION: '2',
  MENTION_PLUS_ANNUAL_OFFER_ID: 'approved-year',
  MENTION_PLUS_ANNUAL_OFFER_VERSION: '3',
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  useDisplayPrice: () => ({ currency: mockDisplayCurrency, formatUsd: mockFormatUsd }),
  useAuth: () => ({
    user: mockUser,
    oxyServices: mockServices,
    canUsePrivateApi: mockSignedIn,
    signIn: jest.fn(),
  }),
  useOxy: () => ({ activeSessionId: mockSession }),
}));
jest.mock('@oxy.so/core', () => ({
  authenticatedApiCall: (_services: unknown, _session: unknown, run: () => unknown) => run(),
}));
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
  useQuery: (options: { queryKey: string[] }) => ({
    data: options.queryKey.includes('mention-plus-access')
      ? mockHasAccess
      : { offer: mockOffer, purchaseAvailable: mockPurchaseAvailable },
    isError: false,
    isPending: false,
  }),
}));
jest.mock('@/lib/payments/plusCheckoutStorage', () => ({
  getPlusCheckoutKey: (...args: unknown[]) => mockKey(...args),
  clearPlusCheckoutKey: (...args: unknown[]) => mockClearKey(...args),
}));
jest.mock('expo-web-browser', () => ({
  openBrowserAsync: (...args: unknown[]) => mockNativeBrowser(...args),
  dismissBrowser: () => mockDismiss(),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { estimate?: string }) =>
      options?.estimate ? `${key}:${options.estimate}` : key,
    i18n: { language: 'en' },
  }),
}));
jest.mock('@oxy.so/bloom/bottom-sheet', () => ({
  BottomSheet: (props: { children: React.ReactNode }) => {
    mockSheet(props);
    return <>{props.children}</>;
  },
}));
jest.mock('@oxy.so/bloom/button', () => ({ Button: (props: object) => <button {...props} /> }));
jest.mock('@oxy.so/bloom/typography', () => ({
  Text: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const offer = {
  offerId: 'approved',
  offerVersion: 2,
  displayName: 'Approved bundle',
  productId: 'mention-product',
  price: {
    currency: 'USD',
    amountMinorUnits: 500,
    interval: 'month',
    trial: 'none',
    taxTreatment: 'inclusive',
    merchantTotal: 'final',
  },
};
const catalogue = { schemaVersion: 1, state: 'configured', purchase: 'available', plans: [offer] };
const originalWindowOpen = window.open;
const originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
const originalPlatformOS = Platform.OS;
let renderer: TestRenderer.ReactTestRenderer;
function button(label: string) {
  return renderer.root.findAllByType('button').find((node) => node.props.children === label);
}
async function mount() {
  await act(async () => {
    renderer = TestRenderer.create(<PlusPaymentSheet onClose={jest.fn()} />);
  });
}
async function press(label: string) {
  await act(async () => {
    button(label)?.props.onPress();
  });
}
beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: 'account-a' };
  mockSession = 'session-a';
  mockHasAccess = false;
  mockPreview = false;
  mockPurchaseAvailable = true;
  mockSignedIn = true;
  mockDisplayCurrency = 'USD';
  mockAccess.mockImplementation(async () => ({
    schemaVersion: 1,
    subjectAccountId: mockUser.id,
    productId: 'mention-product',
    evaluatedAt: new Date().toISOString(),
    capabilities: [],
    quotas: [],
    conflicts: [],
  }));
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  mockPopup = { closed: false, close: mockClose, location: mockLocation, opener: 'parent' };
  window.open = jest.fn().mockImplementation(() => mockPopup);
  mockPlans.mockResolvedValue(catalogue);
  mockOffer = offer;
  mockKey.mockResolvedValue('durable-key');
  mockClearKey.mockResolvedValue(undefined);
  mockCheckout.mockResolvedValue({
    state: 'pending',
    intentId: 'intent',
    checkoutUrl: 'https://checkout.peable.to/c/session#cs=secret',
  });
});
afterEach(() => {
  if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
  else Reflect.deleteProperty(window, 'location');
  act(() => renderer?.unmount());
  window.open = originalWindowOpen;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
});

it('never creates a checkout for an unavailable or mismatched central catalogue', async () => {
  mockOffer = null;
  await mount();
  expect(button('plus.payment.continue')).toBeUndefined();
  expect(mockCheckout).not.toHaveBeenCalled();
});
it('opens a gesture-owned window with a durable key, and checks status without a new operation', async () => {
  await mount();
  await press('plus.payment.continue');
  expect(mockCheckout).toHaveBeenCalledWith({
    expectedSubjectAccountId: 'account-a',
    productId: 'mention-product',
    offerId: 'approved',
    offerVersion: 2,
    idempotencyKey: 'durable-key',
  });
  expect(mockPopup.opener).toBeNull();
  expect(mockLocation.replace).toHaveBeenCalledWith(
    'https://checkout.peable.to/c/session#cs=secret',
  );
  await press('plus.payment.checkStatus');
  expect(mockCheckout).toHaveBeenCalledTimes(2);
  expect(window.open).toHaveBeenCalledTimes(1);
  expect(mockClearKey).not.toHaveBeenCalled();
  expect(mockInvalidate).not.toHaveBeenCalled();
});
it('handles popup blocking without clearing the pending operation', async () => {
  window.open = jest.fn().mockReturnValue(null);
  await mount();
  await press('plus.payment.continue');
  expect(JSON.stringify(renderer.toJSON())).toContain('plus.payment.blocked');
  expect(mockClearKey).not.toHaveBeenCalled();
});
it('ignores repeated clicks while the first request is unresolved', async () => {
  let resolve: ((value: unknown) => void) | undefined;
  mockCheckout.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await mount();
  const action = button('plus.payment.continue')?.props.onPress;
  await act(async () => {
    action();
    action();
  });
  expect(mockCheckout).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolve?.({ state: 'pending', intentId: 'intent' });
  });
});
it('retains the durable key on failed transport and review-required responses', async () => {
  mockCheckout
    .mockRejectedValueOnce(new Error('connection lost'))
    .mockRejectedValueOnce(new Error('PAYMENT_REVIEW_REQUIRED'));
  await mount();
  await press('plus.payment.continue');
  expect(JSON.stringify(renderer.toJSON())).toContain('plus.payment.failed');
  await press('plus.payment.continue');
  expect(JSON.stringify(renderer.toJSON())).toContain('plus.payment.review');
  expect(button('plus.payment.continue')).toBeUndefined();
  expect(mockClearKey).not.toHaveBeenCalled();
});
it('closes the old popup and discards a response after switching accounts', async () => {
  let resolve: ((value: unknown) => void) | undefined;
  mockCheckout.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await mount();
  await press('plus.payment.continue');
  await act(async () => {
    mockUser = { id: 'account-b' };
    mockSession = 'session-b';
    renderer.update(<PlusPaymentSheet onClose={jest.fn()} />);
  });
  await act(async () => {
    resolve?.({
      state: 'pending',
      intentId: 'old',
      checkoutUrl: 'https://checkout.peable.to/c/old',
    });
  });
  expect(mockClose).toHaveBeenCalled();
  expect(mockLocation.replace).not.toHaveBeenCalled();
  expect(mockInvalidate).not.toHaveBeenCalled();
});
it('refreshes authoritative access only after fulfilled, never after native browser dismissal', async () => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
  await mount();
  await press('plus.payment.continue');
  expect(mockNativeBrowser).toHaveBeenCalled();
  expect(mockInvalidate).not.toHaveBeenCalled();
  mockCheckout.mockResolvedValue({ state: 'fulfilled', intentId: 'intent' });
  await press('plus.payment.checkStatus');
  expect(mockClearKey).toHaveBeenCalledWith(
    'account-a',
    { productId: 'mention-product', capabilityKey: 'plus', offerId: 'approved', offerVersion: 2 },
    'durable-key',
  );
  expect(mockInvalidate).toHaveBeenCalled();
  expect(JSON.stringify(renderer.toJSON())).toContain('plus.payment.fulfilled');
});

it('uses the detached Bloom sheet, not an adaptive centered dialog', async () => {
  await mount();
  expect(mockSheet).toHaveBeenCalledWith(expect.objectContaining({ open: true, detached: true }));
});
it('shows sign-in independently of offer availability', async () => {
  mockSignedIn = false;
  await mount();
  expect(JSON.stringify(renderer.toJSON())).toContain('plus.payment.signInRequired');
  expect(button('plus.payment.continue')).toBeUndefined();
});
it('does not sell Plus again when authoritative access already includes it', async () => {
  mockHasAccess = true;
  await mount();
  expect(JSON.stringify(renderer.toJSON())).toContain('plus.payment.included');
  expect(button('plus.payment.continue')).toBeUndefined();
  expect(mockCheckout).not.toHaveBeenCalled();
});
it('rechecks individual or bundle access immediately before creating checkout', async () => {
  mockAccess.mockResolvedValue({
    subjectAccountId: 'account-a',
    productId: 'mention-product',
    capabilities: [{ key: 'plus', grantIds: ['bundle-grant'] }],
  });
  await mount();
  await press('plus.payment.continue');
  expect(mockCheckout).not.toHaveBeenCalled();
  expect(mockKey).not.toHaveBeenCalled();
  expect(JSON.stringify(renderer.toJSON())).toContain('plus.payment.included');
});

it('recovers a pending operation after access becomes included without creating another payment', async () => {
  await mount();
  await press('plus.payment.continue');
  mockHasAccess = true;
  await act(async () => {
    renderer.update(<PlusPaymentSheet onClose={jest.fn()} />);
  });
  mockCheckout.mockResolvedValue({ state: 'fulfilled', intentId: 'intent' });
  await press('plus.payment.checkStatus');
  expect(mockCheckout).toHaveBeenCalledTimes(2);
  expect(mockAccess).toHaveBeenCalledTimes(1);
  expect(mockClearKey).toHaveBeenCalled();
});

it('freezes the reviewed amount and offer while an operation is pending', async () => {
  await mount();
  await press('plus.payment.continue');
  mockOffer = {
    ...offer,
    offerId: 'replacement',
    offerVersion: 7,
    price: { ...offer.price, amountMinorUnits: 900 },
  };
  await act(async () => {
    renderer.update(<PlusPaymentSheet onClose={jest.fn()} />);
  });
  await press('plus.payment.checkStatus');
  expect(mockCheckout.mock.calls[1][0]).toMatchObject({
    offerId: 'approved',
    offerVersion: 2,
    idempotencyKey: 'durable-key',
  });
  expect(mockKey.mock.calls[1][1]).toMatchObject({ offerId: 'approved', offerVersion: 2 });
});
it('uses the selected annual offer for checkout and recovery', async () => {
  mockOffer = {
    ...offer,
    offerId: 'approved-year',
    offerVersion: 3,
    price: { ...offer.price, amountMinorUnits: 4800, interval: 'year' },
  };
  await act(async () => {
    renderer = TestRenderer.create(<PlusPaymentSheet cadence="year" onClose={jest.fn()} />);
  });
  await press('plus.payment.continue');
  expect(mockCheckout.mock.calls[0][0]).toMatchObject({
    offerId: 'approved-year',
    offerVersion: 3,
  });
  expect(mockKey.mock.calls[0][1]).toMatchObject({ offerId: 'approved-year', offerVersion: 3 });
  await press('plus.payment.checkStatus');
  expect(mockCheckout.mock.calls[1][0]).toEqual(mockCheckout.mock.calls[0][0]);
});

it('unavailable EUR display conversion does not block or alter the USD checkout', async () => {
  mockDisplayCurrency = 'EUR';
  await mount();
  expect(JSON.stringify(renderer.toJSON())).toContain('EUR conversion unavailable');
  expect(mockFormatUsd).toHaveBeenCalledWith(500);
  await press('plus.payment.continue');
  expect(mockCheckout.mock.calls[0][0]).toEqual({
    expectedSubjectAccountId: 'account-a',
    productId: 'mention-product',
    offerId: 'approved',
    offerVersion: 2,
    idempotencyKey: 'durable-key',
  });
});
it('USD display preference adds no estimate or rate dependency to checkout', async () => {
  await mount();
  expect(mockFormatUsd).not.toHaveBeenCalled();
  await press('plus.payment.continue');
  expect(mockCheckout).toHaveBeenCalledTimes(1);
});

it('displays published terms without starting payment when the catalogue is not ready', async () => {
  mockPurchaseAvailable = false;
  await mount();
  expect(JSON.stringify(renderer.toJSON())).toContain(offer.displayName);
  expect(JSON.stringify(renderer.toJSON())).toContain('plus.payment.notReady');
  expect(button('plus.payment.continue')).toBeUndefined();
  expect(mockCheckout).not.toHaveBeenCalled();
  expect(mockKey).not.toHaveBeenCalled();
  expect(window.open).not.toHaveBeenCalled();
});

it('never falls back to simulation in product checkout, even on an opted-in developer host', async () => {
  mockPreview = true;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { hostname: 'localhost' },
  });
  mockPurchaseAvailable = false;
  mockSignedIn = false;
  await mount();
  expect(mockPreviewContent).not.toHaveBeenCalled();
  expect(mockCheckout).not.toHaveBeenCalled();
  expect(mockKey).not.toHaveBeenCalled();
  expect(mockClearKey).not.toHaveBeenCalled();
  expect(mockInvalidate).not.toHaveBeenCalled();
  expect(window.open).not.toHaveBeenCalled();
});
it('refuses UI simulation on a non-loopback host even when the preview flag is set', async () => {
  mockPreview = true;
  mockPurchaseAvailable = false;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { hostname: 'mention.earth' },
  });
  await mount();
  expect(JSON.stringify(renderer.toJSON())).not.toContain('plus.payment.previewLabel');
  expect(mockPreviewContent).not.toHaveBeenCalled();
  expect(mockCheckout).not.toHaveBeenCalled();
});

it('allows signed-out users to inspect a prelaunch plan without an authentication step', async () => {
  mockSignedIn = false;
  mockPurchaseAvailable = false;
  await mount();
  expect(JSON.stringify(renderer.toJSON())).toContain('plus.payment.notReady');
  expect(button('plus.payment.signIn')).toBeUndefined();
  expect(mockCheckout).not.toHaveBeenCalled();
});
