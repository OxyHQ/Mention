import TestRenderer, { act } from 'react-test-renderer';
import { OXY_ONE_PERSONAL_PLANS } from '@oxy.so/contracts/client';
import type { SubscriptionPlansProps } from '@oxy.so/bloom/subscription-plans';
import PlusScreen from '@/app/(app)/plus';

const mockShowBottomSheet = jest.fn();
let mockPlansProps: SubscriptionPlansProps | undefined;

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ showBottomSheet: mockShowBottomSheet }),
}));
jest.mock('@oxy.so/bloom/subscription-plans', () => ({
  SubscriptionPlans: (props: SubscriptionPlansProps) => {
    mockPlansProps = props;
    return null;
  },
}));
jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: () => null }));
jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ colors: { primary: '#000' } }) }));

/** /plus sells Mention Plus through the cheapest Oxy One plan that bundles it. */
it('offers Mention Plus at the entry Oxy One price and opens Oxy One to get it', () => {
  act(() => {
    TestRenderer.create(<PlusScreen />);
  });
  const props = mockPlansProps as SubscriptionPlansProps;
  expect(props.plans.map((plan) => plan.id)).toEqual(['free', 'plus']);
  expect(props.value).toBe('plus');
  expect(props.plans[1].price).toMatchObject({
    amount: OXY_ONE_PERSONAL_PLANS.Go.monthlyPrice / 100,
    currency: 'USD',
  });

  act(() => props.primaryAction?.onPress());
  expect(mockShowBottomSheet).toHaveBeenCalledWith('OxyOne');
});
