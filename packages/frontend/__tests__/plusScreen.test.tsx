import TestRenderer, { act } from 'react-test-renderer';
import type { SubscriptionPlansProps } from '@oxy.so/bloom/subscription-plans';
import PlusScreen from '@/app/(app)/plus';

let mockOffer: {
  displayName: string;
  price: { amountMinorUnits: number; currency: string; interval: string };
} | null = null;
let mockCadence: string | undefined;
let mockDisplayCurrency = 'USD';
let mockPurchaseAvailable = true;
let mockFailed = false;
const mockFormatUsd = jest.fn(() => 'Approx. 12 FAIR');
jest.mock('@oxy.so/services/ui/client', () => ({
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
it('opens the explanatory sheet before payment activation', () => {
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
  expect(props.primaryAction?.label).toBe('plus.subscribe');
  expect(props.primaryAction?.disabled).toBeFalsy();
  expect(mockPaymentDialog).toHaveBeenCalled();
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
  expect(mockPlansProps?.primaryAction?.label).toBe('plus.subscribe');
  expect(mockPlansProps?.plans[1].price).toBe('plus.payment.pricingUnavailable');
  mockFailed = false;
  mockPurchaseAvailable = true;
});
