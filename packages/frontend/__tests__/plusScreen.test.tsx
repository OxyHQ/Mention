let mockPreparedProps: { review: unknown; operationKey: string; onClose(): void } | null = null;
let mockDevelopment = false;
let mockUserId: string | undefined;
let mockSessionId: string | undefined;
jest.mock('@/lib/payments/checkoutPreview', () => ({
  isLocalCheckoutPreview: () => mockDevelopment,
}));
jest.mock('@/components/payments/PreparedPlusCheckout', () => ({
  PreparedPlusCheckout: (props: typeof mockPreparedProps) => {
    mockPreparedProps = props;
    return null;
  },
}));
// These tests exercise page/binding policy, not the SDK transport. Fail on any
// unexpected transport construction rather than loading its browser-only ESM.
jest.mock('@peable.to/sdk/checkout', () => ({
  createPeableCheckout: () => {
    throw new Error('Unexpected payer transport in policy test');
  },
}));

jest.mock('@oxy.so/bloom/toast', () => ({ toast: jest.fn() }));
jest.mock('@/lib/navigation/router', () => ({
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ setParams: jest.fn() }),
}));
jest.mock('@/components/payments/MerchantInstallmentSettings', () => ({
  MerchantInstallmentSettings: () => null,
}));
jest.mock('@/components/payments/CheckoutPreviewBadge', () => ({
  CheckoutPreviewBadge: () => null,
}));
import TestRenderer, { act } from 'react-test-renderer';
import type { SubscriptionPlansProps } from '@oxy.so/bloom/subscription-plans';
import PlusScreen from '@/app/(app)/plus';

let mockOffer: {
  productId?: string;
  offerId?: string;
  offerVersion?: number;
  displayName: string;
  price: { amountMinorUnits: number; currency: string; interval: string };
} | null = null;
let mockCadence: string | undefined;
let mockDisplayCurrency = 'USD';
let mockPurchaseAvailable = true;
let mockFailed = false;
const mockFormatUsd = jest.fn(() => 'Approx. 12 FAIR');
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ user: mockUserId ? { id: mockUserId } : undefined }),
  useOxy: () => ({ activeSessionId: mockSessionId }),
  useDisplayPrice: () => ({ currency: mockDisplayCurrency, formatUsd: mockFormatUsd }),
}));
jest.mock('@/hooks/usePlusOffer', () => ({
  usePlusOffer: (cadence: string) => {
    mockCadence = cadence;
    return { offer: mockOffer, purchaseAvailable: mockPurchaseAvailable, failed: mockFailed };
  },
}));
let mockCadenceProps: { value: string; onValueChange(value: string): void };
jest.mock('@oxy.so/bloom/segmented-control', () => ({
  SegmentedControl: (props: typeof mockCadenceProps & { children: React.ReactNode }) => {
    mockCadenceProps = props;
    return <>{props.children}</>;
  },
  SegmentedControlItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SegmentedControlItemText: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
const mockPaymentDialog = jest.fn();
let mockPlansProps: SubscriptionPlansProps | undefined;

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { estimate?: string }) =>
      options?.estimate ? `${key}:${options.estimate}` : key,
    i18n: { language: 'en' },
  }),
}));
jest.mock('@/components/payments/PlusPaymentSheet', () => ({
  PlusPaymentSheet: (props: unknown) => {
    mockPaymentDialog(props);
    return null;
  },
}));
jest.mock('@oxy.so/bloom/subscription-plans', () => ({
  SubscriptionPlans: (props: SubscriptionPlansProps) => {
    mockPlansProps = props;
    return null;
  },
}));
jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: () => null }));
jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ colors: { primary: '#000' } }) }));

/** /plus opens checkout without inventing or substituting a commercial price. */
it('preserves production coming-soon gating before payment activation', () => {
  mockPurchaseAvailable = false;
  mockPaymentDialog.mockClear();
  act(() => {
    TestRenderer.create(<PlusScreen />);
  });
  const props = mockPlansProps as SubscriptionPlansProps;
  expect(props.plans.map((plan) => plan.id)).toEqual(['free', 'plus']);
  expect(props.value).toBe('plus');
  expect(props.plans[1].price).toBe('plus.payment.comingSoon');

  act(() => props.primaryAction?.onPress());
  expect(props.primaryAction?.label).toBe('plus.payment.comingSoon');
  expect(props.primaryAction?.disabled).toBe(true);
  expect(mockPaymentDialog).not.toHaveBeenCalled();
  mockPurchaseAvailable = true;
});

it('displays the exact published offer price instead of a static bundle price', () => {
  mockOffer = {
    displayName: 'Mention Plus',
    price: { amountMinorUnits: 2999, currency: 'USD', interval: 'month' },
  };
  act(() => {
    TestRenderer.create(<PlusScreen />);
  });
  expect(mockPlansProps?.plans[1].price).toMatchObject({
    amount: 29.99,
    description: 'Mention Plus',
  });
});

it('defaults monthly, passes the selected annual offer to the sheet and locks cadence while open', () => {
  act(() => {
    TestRenderer.create(<PlusScreen />);
  });
  expect(mockCadence).toBe('month');
  act(() => mockCadenceProps.onValueChange('year'));
  expect(mockCadence).toBe('year');
  act(() => mockPlansProps?.primaryAction?.onPress());
  expect(mockPaymentDialog.mock.calls.at(-1)?.[0].cadence).toBe('year');
  act(() => mockCadenceProps.onValueChange('month'));
  expect(mockCadence).toBe('year');
});

it('shows the shared currency estimate without replacing the approved USD price', () => {
  mockDisplayCurrency = 'FAIR';
  mockOffer = {
    displayName: 'Mention Plus',
    price: { amountMinorUnits: 599, currency: 'USD', interval: 'month' },
  };
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(<PlusScreen />);
  });
  expect(mockFormatUsd).toHaveBeenCalledWith(599);
  expect(mockPlansProps?.plans[1].price).toMatchObject({ amount: 5.99, currency: 'USD' });
  expect(JSON.stringify(renderer?.toJSON())).toContain('Approx. 12 FAIR');
});

it('keeps an actual catalogue request failure distinct from a planned launch', () => {
  mockFailed = true;
  mockPurchaseAvailable = false;
  mockOffer = null;
  act(() => {
    TestRenderer.create(<PlusScreen />);
  });
  expect(mockPlansProps?.primaryAction?.label).toBe('plus.payment.pricingUnavailable');
  expect(mockPlansProps?.plans[1].price).toBe('plus.payment.pricingUnavailable');
  mockFailed = false;
  mockPurchaseAvailable = true;
});

it('opens captured review synchronously and removes it when account/session changes', () => {
  mockDevelopment = true;
  mockUserId = 'account-a';
  mockSessionId = 'session-a';
  mockOffer = {
    productId: 'mention',
    offerId: 'monthly',
    offerVersion: 1,
    displayName: 'Mention Plus',
    price: { amountMinorUnits: 599, currency: 'USD', interval: 'month' },
  };
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(<PlusScreen />);
  });
  act(() => mockPlansProps?.primaryAction?.onPress());
  expect(mockPreparedProps?.review).toMatchObject({ amountMinorUnits: 599, interval: 'month' });
  const earlierKey = mockPreparedProps?.operationKey;
  mockUserId = 'account-b';
  mockSessionId = 'session-b';
  mockPreparedProps = null;
  act(() => tree?.update(<PlusScreen />));
  expect(mockPreparedProps).toBeNull();
  act(() => mockPlansProps?.primaryAction?.onPress());
  expect((mockPreparedProps as { operationKey: string } | null)?.operationKey).not.toBe(earlierKey);
  act(() => tree?.unmount());
  mockDevelopment = false;
  mockUserId = undefined;
  mockSessionId = undefined;
});
