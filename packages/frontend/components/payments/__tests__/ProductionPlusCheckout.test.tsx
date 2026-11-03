import TestRenderer, { act } from 'react-test-renderer';
import type { ComponentProps } from 'react';
import { ProductionPlusCheckout } from '../ProductionPlusCheckout';
import type { PeableEmbeddedCheckout } from '../PeableEmbeddedCheckout';
let mockProps: ComponentProps<typeof PeableEmbeddedCheckout>;
const subject = '698100000000000000000001';
let mockUser = { id: subject, email: 'buyer@example.test' };
let mockSession = 'session-a';
let mockCanUse = true;
const mockStart = jest.fn();
const mockAccess = jest.fn();
const mockKey = jest.fn();
const mockClear = jest.fn();
const mockInvalidate = jest.fn();
jest.mock('../PeableEmbeddedCheckout', () => ({
  PeableEmbeddedCheckout: (props: typeof mockProps) => {
    mockProps = props;
    return null;
  },
}));
jest.mock('../CheckoutBillingAddress', () => ({
  CheckoutBillingAddress: () => null,
  emptyBillingAddress: () => ({
    country: '',
    state: '',
    postalCode: '',
    city: '',
    line1: '',
    line2: '',
  }),
  billingAddressComplete: (value: { country: string; line1: string }) =>
    !!value.country && !!value.line1,
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({
    user: mockUser,
    canUsePrivateApi: mockCanUse,
    oxyServices: { billing: { startProductPlanCheckout: mockStart, productAccess: mockAccess } },
  }),
  useOxy: () => ({ activeSessionId: mockSession }),
}));
jest.mock('@oxy.so/core', () => ({
  authenticatedApiCall: (_client: unknown, _session: unknown, run: () => unknown) => run(),
}));
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
}));
jest.mock('@/lib/payments/plusCheckout', () => ({ includesPlus: () => false }));
jest.mock('@/lib/payments/plusCheckoutStorage', () => ({
  getPlusCheckoutKey: (...args: unknown[]) => mockKey(...args),
  clearPlusCheckoutKey: (...args: unknown[]) => mockClear(...args),
}));
const review = {
  productId: 'mention',
  offerId: 'month',
  offerVersion: 1,
  amountMinorUnits: 599,
  currency: 'USD',
  interval: 'month' as const,
};
const offerBinding = {
  productId: 'mention',
  offerId: 'month',
  offerVersion: 1,
  capabilityKey: 'plus',
};
const configuration = {
  configuration: {
    state: 'ready' as const,
    subjectAccountId: subject,
    productId: 'mention',
    merchantId: 'merch_owned',
    mode: 'live' as const,
    environment: 'production' as const,
    publishableKey: 'pk_live_owned',
    paymentMethods: [{ id: 'card' as const, available: true }],
    offers: [
      {
        offerId: 'month',
        offerVersion: 1,
        amountMinorUnits: 599,
        currency: 'USD' as const,
        interval: 'month' as const,
      },
    ],
  },
  fetchedAt: Date.now(),
};
const embedded = {
  transport: 'checkout_session',
  subjectAccountId: subject,
  productId: 'mention',
  offerId: 'month',
  offerVersion: 1,
  merchantId: 'merch_owned',
  mode: 'live',
  environment: 'production',
  publishableKey: 'pk_live_owned',
  sessionId: 'cs_live_owned',
  clientSecret: 'opaque-fixture',
  currency: 'USD',
  amountMinorUnits: 599,
  interval: 'month',
  tax: { subtotalMinorUnits: 557, taxMinorUnits: 42, totalMinorUnits: 599, inclusive: true },
};
let tree: TestRenderer.ReactTestRenderer;
const close = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: subject, email: 'buyer@example.test' };
  mockSession = 'session-a';
  mockCanUse = true;
  mockAccess.mockResolvedValue({});
  mockKey.mockResolvedValue('operation-key');
  mockClear.mockResolvedValue(undefined);
  mockInvalidate.mockResolvedValue(undefined);
  mockStart.mockResolvedValue({
    state: 'pending',
    intentId: 'operation',
    embeddedCheckout: embedded,
  });
});
afterEach(() => act(() => tree?.unmount()));
async function mount() {
  await act(async () => {
    tree = TestRenderer.create(
      <ProductionPlusCheckout
        review={review}
        offerBinding={offerBinding}
        configuration={
          configuration as ComponentProps<typeof ProductionPlusCheckout>['configuration']
        }
        onClose={close}
      />,
    );
  });
}
async function fill() {
  await act(async () => {
    const field = mockProps.billingContent as React.ReactElement<{
      onChange(value: unknown): void;
    }>;
    field.props.onChange({
      country: 'US',
      state: 'DE',
      postalCode: '19802',
      city: 'Wilmington',
      line1: 'Example street',
      line2: '',
    });
  });
}
it('does not create on page view; freezes explicit address, uses embedded stable key and only fulfills from Oxy', async () => {
  await mount();
  expect(mockStart).not.toHaveBeenCalled();
  await fill();
  const staleField = mockProps.billingContent as React.ReactElement<{
    onChange(value: unknown): void;
  }>;
  let prepared: unknown;
  await act(async () => {
    prepared = await mockProps.prepareSession?.();
  });
  expect(prepared).toMatchObject({ action: { session_id: 'cs_live_owned' } });
  expect(mockStart.mock.calls[0][0]).toMatchObject({
    presentation: 'embedded',
    expectedSubjectAccountId: subject,
    idempotencyKey: 'operation-key',
    billingAddress: { country: 'US', line1: 'Example street' },
  });
  act(() => staleField.props.onChange({ country: 'ES', line1: 'Other' }));
  expect(mockProps.billingDetails?.country).toBe('US');
  expect(await mockProps.observeSession?.()).toBe(false);
  expect(mockInvalidate).not.toHaveBeenCalled();
  mockStart.mockResolvedValue({ state: 'fulfilled', intentId: 'operation' });
  expect(await mockProps.observeSession?.()).toBe(true);
  expect(mockClear).toHaveBeenCalledWith(subject, offerBinding, 'operation-key', 'embedded');
  expect(mockInvalidate).toHaveBeenCalledTimes(2);
  expect(mockStart.mock.calls.every(([body]) => body.idempotencyKey === 'operation-key')).toBe(
    true,
  );
});
it('handles complete-without-secret recovery without asking for another card', async () => {
  mockStart.mockResolvedValue({
    state: 'pending',
    intentId: 'operation',
    checkoutStatus: 'complete',
  });
  await mount();
  await fill();
  await act(async () => {
    expect(await mockProps.prepareSession?.()).toEqual({ state: 'awaiting_fulfillment' });
  });
  expect(mockKey).toHaveBeenCalledTimes(1);
});
it('discards a late capability after account/session replacement', async () => {
  let resolve: (value: unknown) => void = () => {};
  mockStart.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await mount();
  await fill();
  let pending: Promise<unknown> | undefined;
  await act(async () => {
    pending = mockProps.prepareSession?.();
  });
  mockCanUse = false;
  await act(async () => {
    tree.update(
      <ProductionPlusCheckout
        review={review}
        offerBinding={offerBinding}
        configuration={
          configuration as ComponentProps<typeof ProductionPlusCheckout>['configuration']
        }
        onClose={close}
      />,
    );
  });
  await act(async () => {
    resolve({ state: 'pending', intentId: 'operation', embeddedCheckout: embedded });
    await expect(pending).rejects.toThrow('Account changed');
  });
  expect(mockInvalidate).not.toHaveBeenCalled();
});

it('recovers the same frozen operation after the public configuration expires', async () => {
  await mount();
  await fill();
  await act(async () => {
    await mockProps.prepareSession?.();
  });
  const clock = jest.spyOn(Date, 'now').mockReturnValue(configuration.fetchedAt + 61_000);
  try {
    await act(async () => {
      await mockProps.prepareSession?.();
    });
    expect(mockKey).toHaveBeenCalledTimes(1);
    expect(mockStart.mock.calls[1][0]).toEqual(mockStart.mock.calls[0][0]);
  } finally {
    clock.mockRestore();
  }
});

it('unlocks address only after authoritative pre-creation closure, with no automatic new purchase', async () => {
  mockStart.mockResolvedValue({
    state: 'closed',
    intentId: 'operation',
    reason: 'billing_location_required',
  });
  await mount();
  await fill();
  await act(async () => {
    expect(await mockProps.prepareSession?.()).toEqual({ state: 'billing_details_required' });
  });
  expect(mockClear).toHaveBeenCalledWith(subject, offerBinding, 'operation-key', 'embedded');
  expect(mockStart).toHaveBeenCalledTimes(1);
  const field = mockProps.billingContent as React.ReactElement<{
    locked: boolean;
    onChange(value: unknown): void;
  }>;
  expect(field.props.locked).toBe(false);
  act(() =>
    field.props.onChange({
      country: 'ES',
      state: '',
      postalCode: '28001',
      city: 'Madrid',
      line1: 'Corrected street',
      line2: '',
    }),
  );
  expect(mockProps.billingDetails?.country).toBe('ES');
  expect(mockStart).toHaveBeenCalledTimes(1);
});
it('retains frozen billing details and operation on ambiguous preparation failure', async () => {
  mockStart.mockRejectedValue(new Error('connection lost'));
  await mount();
  await fill();
  await act(async () => {
    await expect(mockProps.prepareSession?.()).rejects.toThrow('connection lost');
  });
  expect(mockClear).not.toHaveBeenCalled();
  expect((mockProps.billingContent as React.ReactElement<{ locked: boolean }>).props.locked).toBe(
    true,
  );
});
