import TestRenderer, { act } from 'react-test-renderer';
import type { SubscriptionPlansProps } from '@oxy.so/bloom/subscription-plans';
import PlusScreen from '@/app/(app)/plus';

let mockOffer: {
  displayName: string;
  price: { amountMinorUnits: number; currency: string };
} | null = null;
jest.mock('@/hooks/usePlusOffer', () => ({ usePlusOffer: () => ({ offer: mockOffer }) }));
const mockPaymentDialog = jest.fn();
let mockPlansProps: SubscriptionPlansProps | undefined;

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
jest.mock('@/components/payments/PlusPaymentDialog', () => ({
  PlusPaymentDialog: (props: unknown) => {
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
it('offers Mention Plus without advertising an unapproved price and opens the Peable payment dialog', () => {
  act(() => {
    TestRenderer.create(<PlusScreen />);
  });
  const props = mockPlansProps as SubscriptionPlansProps;
  expect(props.plans.map((plan) => plan.id)).toEqual(['free', 'plus']);
  expect(props.value).toBe('plus');
  expect(props.plans[1].price).toBe('plus.payment.pricingUnavailable');

  act(() => props.primaryAction?.onPress());
  expect(props.primaryAction?.label).toBe('plus.subscribe');
  expect(mockPaymentDialog).toHaveBeenCalled();
});

it('displays the exact published offer price instead of a static bundle price', () => {
  mockOffer = {
    displayName: 'Approved Oxy One',
    price: { amountMinorUnits: 2999, currency: 'USD' },
  };
  act(() => {
    TestRenderer.create(<PlusScreen />);
  });
  expect(mockPlansProps?.plans[1].price).toMatchObject({
    amount: 29.99,
    description: 'Approved Oxy One',
  });
});
