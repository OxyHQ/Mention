import TestRenderer, { act } from 'react-test-renderer';
import { LocalCheckoutPreview } from '../LocalCheckoutPreview';
import type { PeableCheckoutSheetProps } from '@peable.to/sdk/checkout/ui';
let mockContent: PeableCheckoutSheetProps;
const mockClose = jest.fn();
const mockFeedbackPlay = jest.fn();
const mockFeedbackStop = jest.fn();
jest.mock('@/hooks/useCheckoutFeedback', () => ({
  useCheckoutFeedback: () => ({ play: mockFeedbackPlay, stop: mockFeedbackStop }),
}));
jest.mock('@/components/ui/AccountAvatar', () => ({ AccountAvatar: () => null }));
jest.mock('@oxy.so/stickers/react', () => ({ useSticker: jest.fn() }));
jest.mock('@/components/common/EmptyStateSticker', () => ({ EmptyStateSticker: () => null }));
jest.mock('../LocalCheckoutCardEntry', () => ({ LocalCheckoutCardEntry: () => null }));
jest.mock('@peable.to/sdk/checkout/ui', () => ({
  PeableCheckoutSheet: (props: PeableCheckoutSheetProps) => {
    mockContent = props;
    return null;
  },
}));
jest.mock('@oxy.so/bloom/dialog', () => ({
  Dialog: (props: {
    children: React.ReactNode;
    header?: { largeTitle: boolean; showClose: boolean; onBack?: () => void };
    footer?: React.ReactNode;
  }) => {
    return <>{props.children}</>;
  },
}));
jest.mock('@/hooks/usePlusOffer', () => ({
  usePlusOffer: (cadence: 'month' | 'year') => ({
    offer: {
      displayName: 'Mention Plus',
      price: { currency: 'USD', amountMinorUnits: cadence === 'year' ? 5750 : 599 },
    },
  }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
let renderer: TestRenderer.ReactTestRenderer;
beforeEach(() => {
  jest.useFakeTimers();
  mockClose.mockClear();
  mockFeedbackPlay.mockClear();
  mockFeedbackStop.mockClear();
});
afterEach(() => {
  act(() => renderer?.unmount());
  jest.useRealTimers();
});
function mount(
  scenario: 'subscription' | 'physical' | 'trial' = 'subscription',
  authorize?: () => Promise<'authorized' | 'cancelled'>,
  outcome: 'success' | 'failure' | 'loading' = 'success',
) {
  act(() => {
    renderer = TestRenderer.create(
      <LocalCheckoutPreview
        cadence="month"
        customer={{ kind: 'account', email: 'fixture@example.test' }}
        scenario={scenario}
        outcome={outcome}
        onClose={mockClose}
        authorize={authorize}
      />,
    );
  });
}
it('separates a zero-due trial preview from its future recurring payment without inventing a Mention trial', () => {
  mount('trial');
  expect(mockContent.request.dueTodayMinorUnits).toBe(0);
  expect(mockContent.request.recurring).toMatchObject({ amountMinorUnits: 599, interval: 'month' });
  expect(mockContent.request.recurring?.startsOn).toBeTruthy();
  expect(mockContent.request.merchant).not.toBe('Mention');
  expect(mockContent.request.requiresShipping).toBe(false);
});
it('keeps subscription and physical requirements separate', () => {
  mount();
  expect(mockContent.request.requiresShipping).toBe(false);
  expect(mockContent.request.dueTodayMinorUnits).toBe(599);
  act(() =>
    renderer.update(
      <LocalCheckoutPreview
        cadence="month"
        scenario="physical"
        outcome="success"
        onClose={mockClose}
      />,
    ),
  );
  expect(mockContent.request.requiresShipping).toBe(true);
  expect(mockContent.request.recurring).toBeUndefined();
});
it('keeps only opted-in masked card metadata for this mounted session and preserves draft on Back', () => {
  mount();
  const card = { id: 'demo', brand: 'Visa' as const, last4: '4242', saveForLater: true };
  act(() => mockContent.onCard(card));
  expect(mockContent.savedCards).toEqual([card]);
  expect(Object.keys(mockContent.savedCards[0]).sort()).toEqual([
    'brand',
    'id',
    'last4',
    'saveForLater',
  ]);
  act(() => mockContent.onStep('contact'));
  act(() => mockContent.onDraft({ ...mockContent.draft, email: 'edited@example.test' }));
  act(() => mockContent.onBack());
  expect(mockContent.step).toBe('review');
  expect(mockContent.draft.email).toBe('edited@example.test');
  act(() => renderer.unmount());
  mount();
  expect(mockContent.savedCards).toEqual([]);
  expect(mockContent.draft.card).toBeNull();
});
it('simulates completion only after required details and honors optional authorization cancellation', async () => {
  const authorize = jest.fn().mockResolvedValue('cancelled');
  mount('subscription', authorize);
  await act(async () => mockContent.onAuthorize());
  expect(authorize).not.toHaveBeenCalled();
  act(() => mockContent.onCard({ id: 'test', brand: 'Visa', last4: '4242', saveForLater: false }));
  await act(async () => mockContent.onAuthorize());
  expect(authorize).toHaveBeenCalledTimes(1);
  expect(mockContent.step).toBe('review');
  authorize.mockResolvedValue('authorized');
  await act(async () => {
    mockContent.onAuthorize();
    mockContent.onAuthorize();
  });
  expect(authorize).toHaveBeenCalledTimes(2);
  expect(mockContent.step).toBe('processing');
  expect(mockContent.resultIllustration).toBeUndefined();
  act(() => jest.advanceTimersByTime(1000));
  expect(mockContent.step).toBe('success');
  expect(mockContent.resultIllustration).toMatchObject({ props: { name: 'checkoutSuccess' } });
});
it('does not update after a pending authorization resolves following dismissal', async () => {
  let finish: ((value: 'authorized') => void) | undefined;
  mount(
    'subscription',
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => mockContent.onCard({ id: 'test', brand: 'Visa', last4: '4242', saveForLater: false }));
  act(() => mockContent.onAuthorize());
  act(() => renderer.unmount());
  const schedule = jest.spyOn(global, 'setTimeout');
  await act(async () => finish?.('authorized'));
  expect(schedule.mock.calls.some(([, delay]) => delay === 1000)).toBe(false);
  schedule.mockRestore();
  expect(mockContent.step).toBe('processing');
});

it('restores the logo then closes once after accessible success, cancelling on dismissal', async () => {
  mount();
  act(() => mockContent.onCard({ id: 'test', brand: 'Visa', last4: '4242', saveForLater: false }));
  await act(async () => mockContent.onAuthorize());
  act(() => jest.advanceTimersByTime(1000));
  expect(mockContent.step).toBe('success');
  act(() => jest.advanceTimersByTime(1499));
  expect(mockClose).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(1));
  expect(mockContent.brandState).toBe('idle');
  act(() => mockContent.onClose());
  act(() => jest.advanceTimersByTime(300));
  expect(mockClose).toHaveBeenCalledTimes(1);
});

it('closes automatically only after the complete success presentation', async () => {
  mount();
  act(() => mockContent.onCard({ id: 'test', brand: 'Visa', last4: '4242', saveForLater: false }));
  await act(async () => mockContent.onAuthorize());
  act(() => jest.advanceTimersByTime(1000));
  act(() => jest.advanceTimersByTime(1800));
  expect(mockClose).toHaveBeenCalledTimes(1);
  act(() => jest.advanceTimersByTime(10000));
  expect(mockClose).toHaveBeenCalledTimes(1);
});
it('keeps failures open for retry and cancels completion when navigating away', async () => {
  mount('subscription', undefined, 'failure');
  act(() => mockContent.onCard({ id: 'test', brand: 'Visa', last4: '4242', saveForLater: false }));
  await act(async () => mockContent.onAuthorize());
  act(() => jest.advanceTimersByTime(1000));
  expect(mockContent.step).toBe('failure');
  expect(mockContent.resultIllustration).toMatchObject({ props: { name: 'checkoutFailure' } });
  act(() => jest.advanceTimersByTime(10000));
  expect(mockClose).not.toHaveBeenCalled();
  act(() => renderer.unmount());
  mount();
  act(() => mockContent.onCard({ id: 'test', brand: 'Visa', last4: '4242', saveForLater: false }));
  await act(async () => mockContent.onAuthorize());
  act(() => jest.advanceTimersByTime(1000));
  act(() => mockContent.onStep('review'));
  act(() => jest.advanceTimersByTime(1800));
  expect(mockClose).not.toHaveBeenCalled();
});
it('ignores dismissal while processing and allows it after a terminal result', async () => {
  let finish: ((value: 'authorized') => void) | undefined;
  mount(
    'subscription',
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => mockContent.onCard({ id: 'test', brand: 'Visa', last4: '4242', saveForLater: false }));
  act(() => mockContent.onAuthorize());
  act(() => mockContent.onClose());
  act(() => mockContent.onBack());
  expect(mockClose).not.toHaveBeenCalled();
  expect(mockContent.step).toBe('processing');
  await act(async () => finish?.('authorized'));
  act(() => jest.advanceTimersByTime(1000));
  expect(mockContent.step).toBe('success');
  act(() => mockContent.onClose());
  expect(mockClose).toHaveBeenCalledTimes(1);
});

it('requires guest contact and never fabricates account methods, while explicit account preview has only masked fixtures', () => {
  mount();
  act(() =>
    renderer.update(
      <LocalCheckoutPreview
        cadence="month"
        scenario="subscription"
        outcome="success"
        onClose={mockClose}
        key="guest"
        customer={{ kind: 'guest' }}
      />,
    ),
  );
  expect(mockContent.draft.email).toBe('');
  expect(mockContent.savedCards).toEqual([]);
  act(() => mockContent.onAuthorize());
  expect(mockContent.step).toBe('review');
  act(() =>
    renderer.update(
      <LocalCheckoutPreview
        cadence="month"
        scenario="subscription"
        outcome="success"
        onClose={mockClose}
        key="account"
        customer={{ kind: 'account', email: 'real@example.test' }}
      />,
    ),
  );
  expect(mockContent.draft.email).toBe('real@example.test');
  expect(mockContent.savedCards).toEqual([]);
  act(() =>
    renderer.update(
      <LocalCheckoutPreview
        cadence="month"
        scenario="subscription"
        outcome="success"
        onClose={mockClose}
        key="preview"
        customer={{ kind: 'account', simulated: true }}
      />,
    ),
  );
  expect(mockContent.draft.email).toBe('');
  expect(mockContent.savedCards.map((card) => card.last4)).toEqual(['4242', '4444']);
});

it('requires contact only for guests and passes a controlled account summary without asserting email ownership', () => {
  mount();
  expect(mockContent.request.requiresContact).toBe(false);
  expect(mockContent.accountSummary).toBeDefined();
  act(() =>
    renderer.update(
      <LocalCheckoutPreview
        key="guest"
        cadence="month"
        scenario="subscription"
        outcome="success"
        onClose={mockClose}
        customer={{ kind: 'guest' }}
      />,
    ),
  );
  expect(mockContent.request.requiresContact).toBe(true);
  expect(mockContent.accountSummary).toBeUndefined();
  expect(mockContent.draft.email).toBe('');
});
it('keeps bank/provider and nonpayable external wallet choices controlled, with balance available only in explicit account preview', () => {
  mount();
  act(() => mockContent.onMethod?.('bank'));
  expect(mockContent.step).toBe('method');
  const bank = mockContent.methodDetails;
  if (bank?.kind !== 'provider') throw new Error('Expected provider detail');
  act(() => bank.onContinue());
  expect(mockContent.draft.paymentSelection).toMatchObject({ method: 'bank', detail: '···· 6789' });
  act(() => mockContent.onMethod?.('faircoin'));
  const external = mockContent.methodDetails;
  if (external?.kind !== 'faircoin') throw new Error('Expected FairCoin detail');
  expect(external.wallet).toBeUndefined();
  expect(external.external?.payload).toBe('PEABLE_LOCAL_PREVIEW_NOT_A_PAYMENT');
  act(() => external.external?.onOpen());
  expect(mockContent.methodDetails).toMatchObject({ view: 'external' });
  act(() => external.external?.onSelect());
  expect(mockContent.draft.paymentSelection).toMatchObject({
    method: 'faircoin',
    id: 'faircoin-external',
  });
  act(() =>
    renderer.update(
      <LocalCheckoutPreview
        key="demo"
        cadence="month"
        scenario="subscription"
        outcome="success"
        onClose={mockClose}
        customer={{ kind: 'account', simulated: true }}
      />,
    ),
  );
  act(() => mockContent.onMethod?.('faircoin'));
  const wallet = mockContent.methodDetails;
  if (wallet?.kind !== 'faircoin') throw new Error('Expected FairCoin detail');
  expect(wallet.wallet).toBeDefined();
  act(() => wallet.wallet?.onSelect());
  expect(mockContent.draft.paymentSelection).toMatchObject({
    method: 'faircoin',
    id: 'faircoin-wallet',
  });
});

it('emits result feedback once per actual completion and stops it when closed', async () => {
  mount();
  act(() =>
    mockContent.onCard({ id: 'audio-card', brand: 'Visa', last4: '4242', saveForLater: false }),
  );
  await act(async () => {
    mockContent.onAuthorize();
    mockContent.onAuthorize();
  });
  expect(mockFeedbackPlay).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(1000));
  expect(mockFeedbackPlay.mock.calls).toEqual([['success', 1]]);
  act(() => mockContent.onStep('review'));
  expect(mockFeedbackPlay).toHaveBeenCalledTimes(1);
  act(() => mockContent.onClose());
  expect(mockFeedbackStop).toHaveBeenCalledTimes(1);
});
it('keeps external and wallet top-up navigation local, with a distinct nonpayable receive payload and explicit fixture-only balance updates', () => {
  mount();
  act(() =>
    renderer.update(
      <LocalCheckoutPreview
        key="topup"
        incomingFunds
        cadence="month"
        scenario="subscription"
        outcome="success"
        onClose={mockClose}
        customer={{ kind: 'account', simulated: true }}
      />,
    ),
  );
  act(() => mockContent.onMethod?.('faircoin'));
  const choice = mockContent.methodDetails;
  if (choice?.kind !== 'faircoin') throw new Error('Expected FairCoin detail');
  act(() => choice.external?.onOpen());
  expect(mockContent.methodDetails).toMatchObject({ view: 'external' });
  act(() => mockContent.onBack());
  expect(mockContent.methodDetails).toMatchObject({ view: 'choices' });
  act(() => choice.wallet?.onOpen());
  expect(mockContent.methodDetails).toMatchObject({ view: 'wallet' });
  act(() => choice.wallet?.topUp?.onOpen());
  const topup = mockContent.methodDetails;
  if (topup?.kind !== 'faircoin') throw new Error('Expected FairCoin detail');
  expect(topup.view).toBe('topup');
  expect(topup.wallet?.topUp?.payload).toBe('PEABLE_LOCAL_WALLET_TOPUP_PREVIEW_NOT_PAYABLE');
  expect(topup.wallet?.topUp?.payload).not.toBe(topup.external?.payload);
  expect(topup.wallet?.balanceLabel).toBe('25 FAIR');
  expect(topup.wallet?.topUp?.notice).toBeUndefined();
  act(() => jest.advanceTimersByTime(1999));
  expect(mockContent.methodDetails).toMatchObject({ wallet: { balanceLabel: '25 FAIR' } });
  act(() => jest.advanceTimersByTime(1));
  expect(mockContent.methodDetails).toMatchObject({
    wallet: { balanceLabel: '150 FAIR', remainingLabel: '138 FAIR' },
  });
  act(() => jest.advanceTimersByTime(4000));
  expect(mockContent.methodDetails).toMatchObject({ wallet: { balanceLabel: '150 FAIR' } });
  act(() => mockContent.onBack());
  expect(mockContent.methodDetails).toMatchObject({ view: 'wallet' });
  act(() => mockContent.onBack());
  expect(mockContent.methodDetails).toMatchObject({ view: 'choices' });
  expect(mockContent.draft.paymentSelection).toBeNull();
});

it('keeps installments eligible only for the physical fixture and separates due today from the full order total', () => {
  mount();
  expect(mockContent.request.paymentMethods).not.toContain('installments');
  act(() =>
    renderer.update(
      <LocalCheckoutPreview
        key="physical-plan"
        cadence="month"
        scenario="physical"
        outcome="success"
        onClose={mockClose}
        customer={{ kind: 'account', simulated: true }}
      />,
    ),
  );
  expect(mockContent.request.paymentMethods).toContain('installments');
  act(() => mockContent.onMethod?.('installments'));
  const plan = mockContent.methodDetails;
  if (plan?.kind !== 'installments') throw new Error('Expected installment detail');
  expect(plan.schedule.map((payment) => payment.amountLabel)).toEqual([
    '$7.00',
    '$7.00',
    '$7.00',
    '$7.00',
  ]);
  act(() => plan.onSelect());
  expect(mockContent.request.dueTodayMinorUnits).toBe(700);
  expect(mockContent.request.totalMinorUnits).toBe(2800);
  expect(mockContent.request.items[0].amountMinorUnits).toBe(2800);
  expect(mockContent.request.recurring).toBeUndefined();
  act(() => mockContent.onCard({ id: 'test', brand: 'Visa', last4: '4242', saveForLater: false }));
  expect(mockContent.request.dueTodayMinorUnits).toBe(2800);
});
it('makes slow confirmation finite without allowing UI dismissal or navigation during processing', async () => {
  mount('subscription', undefined, 'loading');
  act(() => mockContent.onCard({ id: 'test', brand: 'Visa', last4: '4242', saveForLater: false }));
  await act(async () => mockContent.onAuthorize());
  act(() => mockContent.onClose());
  act(() => mockContent.onBack());
  act(() => mockContent.onStep('review'));
  act(() => jest.advanceTimersByTime(7999));
  expect(mockContent.step).toBe('processing');
  expect(mockClose).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(1));
  expect(mockContent.step).toBe('success');
});

it('uses coherent tender fixtures, keeps a free trial free, and blocks insufficient wallet balance until one configured incoming-funds event', () => {
  mount('trial');
  act(() =>
    renderer.update(
      <LocalCheckoutPreview
        key="free"
        cadence="month"
        scenario="trial"
        outcome="success"
        onClose={mockClose}
        customer={{ kind: 'account', simulated: true }}
      />,
    ),
  );
  act(() => mockContent.onMethod?.('faircoin'));
  expect(mockContent.methodDetails).toMatchObject({
    amountLabel: '0 FAIR',
    wallet: { balanceLabel: '25 FAIR', remainingLabel: '25 FAIR', canPay: true },
  });
  act(() =>
    renderer.update(
      <LocalCheckoutPreview
        key="yearly"
        cadence="year"
        scenario="subscription"
        outcome="success"
        onClose={mockClose}
        incomingFunds
        customer={{ kind: 'account', simulated: true }}
      />,
    ),
  );
  act(() => mockContent.onMethod?.('faircoin'));
  const details = mockContent.methodDetails;
  if (details?.kind !== 'faircoin') throw new Error('Expected FairCoin detail');
  expect(details).toMatchObject({
    amountLabel: '115 FAIR',
    wallet: { canPay: false, amountNeededLabel: '90 FAIR' },
  });
  act(() => details.wallet?.onSelect());
  expect(mockContent.draft.paymentSelection).toBeNull();
  act(() => details.wallet?.topUp?.onOpen());
  act(() => jest.advanceTimersByTime(2000));
  expect(mockContent.methodDetails).toMatchObject({
    wallet: { balanceLabel: '150 FAIR', remainingLabel: '35 FAIR', canPay: true },
  });
  act(() => mockContent.onBack());
  const updated = mockContent.methodDetails;
  if (updated?.kind !== 'faircoin') throw new Error('Expected FairCoin detail');
  act(() => updated.wallet?.topUp?.onOpen());
  act(() => jest.advanceTimersByTime(2000));
  expect(mockContent.methodDetails).toMatchObject({ wallet: { balanceLabel: '150 FAIR' } });
});
it('cancels configured incoming funds when the receive view is no longer shown', () => {
  mount();
  act(() =>
    renderer.update(
      <LocalCheckoutPreview
        key="cancel-arrival"
        cadence="month"
        scenario="subscription"
        outcome="success"
        incomingFunds
        onClose={mockClose}
        customer={{ kind: 'account', simulated: true }}
      />,
    ),
  );
  act(() => mockContent.onMethod?.('faircoin'));
  const details = mockContent.methodDetails;
  if (details?.kind !== 'faircoin') throw new Error('Expected FairCoin detail');
  act(() => details.wallet?.topUp?.onOpen());
  act(() => jest.advanceTimersByTime(1000));
  act(() => mockContent.onStep('review'));
  act(() => jest.advanceTimersByTime(3000));
  expect(mockContent.methodDetails).toMatchObject({ wallet: { balanceLabel: '25 FAIR' } });
});
