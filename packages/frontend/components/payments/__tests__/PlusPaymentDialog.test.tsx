import TestRenderer, { act } from 'react-test-renderer';
import { Platform } from 'react-native';
import { PlusPaymentDialog } from '../PlusPaymentDialog';

let mockOffer: typeof offer | null;
const mockPlans = jest.fn();
const mockCheckout = jest.fn();
const mockKey = jest.fn();
const mockClearKey = jest.fn();
const mockInvalidate = jest.fn().mockResolvedValue(undefined);
const mockNativeBrowser = jest.fn().mockResolvedValue({ type: 'cancel' });
const mockDismiss = jest.fn();
let mockUser = { id: 'account-a' };
let mockSession = 'session-a';
const mockServices = {
  billing: { personalPlans: mockPlans, startPersonalPlanCheckout: mockCheckout },
};
const mockLocation = { replace: jest.fn() };
const mockClose = jest.fn();
let mockPopup: {
  closed: boolean;
  close: typeof mockClose;
  location: typeof mockLocation;
  opener: unknown;
};
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({
    user: mockUser,
    oxyServices: mockServices,
    canUsePrivateApi: true,
    signIn: jest.fn(),
  }),
  useOxy: () => ({ activeSessionId: mockSession }),
}));
jest.mock('@oxy.so/core', () => ({
  authenticatedApiCall: (_services: unknown, _session: unknown, run: () => unknown) => run(),
}));
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
  useQuery: () => ({ data: mockOffer, isError: false, isPending: false }),
}));
jest.mock('@/lib/payments/plusCheckoutStorage', () => ({
  getPlusCheckoutKey: (...args: unknown[]) => mockKey(...args),
  clearPlusCheckoutKey: (...args: unknown[]) => mockClearKey(...args),
}));
jest.mock('@/lib/payments/plusCheckout', () => ({
  ...jest.requireActual('@/lib/payments/plusCheckout'),
  plusOfferBinding: () => ({ offerId: 'approved', offerVersion: 2 }),
}));
jest.mock('expo-web-browser', () => ({
  openBrowserAsync: (...args: unknown[]) => mockNativeBrowser(...args),
  dismissBrowser: () => mockDismiss(),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
jest.mock('@oxy.so/bloom/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@oxy.so/bloom/button', () => ({ Button: (props: object) => <button {...props} /> }));
jest.mock('@oxy.so/bloom/typography', () => ({
  Text: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const offer = {
  offerId: 'approved',
  offerVersion: 2,
  displayName: 'Approved bundle',
  audience: 'personal',
  kind: 'oxy_one',
  price: {
    currency: 'USD',
    amountMinorUnits: 500,
    interval: 'month',
    trial: 'none',
    taxTreatment: 'inclusive',
    merchantTotal: 'final',
  },
  benefits: [],
};
const catalogue = { schemaVersion: 1, state: 'configured', purchase: 'available', plans: [offer] };
let renderer: TestRenderer.ReactTestRenderer;
function button(label: string) {
  return renderer.root.findAllByType('button').find((node) => node.props.children === label);
}
async function mount() {
  await act(async () => {
    renderer = TestRenderer.create(<PlusPaymentDialog onClose={jest.fn()} />);
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
  act(() => renderer?.unmount());
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
    renderer.update(<PlusPaymentDialog onClose={jest.fn()} />);
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
  expect(mockClearKey).toHaveBeenCalledWith('account-a', offer, 'durable-key');
  expect(mockInvalidate).toHaveBeenCalled();
  expect(JSON.stringify(renderer.toJSON())).toContain('plus.payment.fulfilled');
});
