import { useEffect as mockUseEffect } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type {
  PeableCheckoutSheetProps,
  PeableProviderFieldsProps,
} from '@peable.to/sdk/checkout/ui';
import { LocalProviderTestSheet } from '../LocalProviderTestSheet';
let mockSheet: PeableCheckoutSheetProps;
let mockUpdate: (value: typeof intent) => void;
const mockUnsubscribe = jest.fn();
const mockConfirm = jest.fn();
const mockPlay = jest.fn();
const mockClose = jest.fn();
const intent = {
  id: 'pi_localtest',
  rail: 'card',
  currency: 'USD',
  amount: '599',
  status: 'created',
};
const mockRead = jest.fn();
const mockAction = jest.fn();
jest.mock('@peable.to/sdk/checkout', () => ({
  createPeableCheckout: () => ({
    getPaymentIntent: mockRead,
    getClientAction: mockAction,
    subscribe: jest.fn(async (_id: string, _secret: string, update: typeof mockUpdate) => {
      mockUpdate = update;
      return { unsubscribe: mockUnsubscribe };
    }),
  }),
}));
jest.mock('@peable.to/sdk/checkout/ui', () => ({
  PeableCheckoutSheet: (props: PeableCheckoutSheetProps) => {
    mockSheet = props;
    return <>{props.step === 'card' ? props.cardEntry : null}</>;
  },
  PeableProviderFields: (props: PeableProviderFieldsProps) => {
    mockUseEffect(() => {
      props.onReady(mockConfirm);
      return () => props.onReady(null);
    }, []);
    return null;
  },
}));
jest.mock('@oxy.so/bloom/button', () => ({
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children: React.ReactNode;
    onPress(): void;
    disabled: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
jest.mock('@oxy.so/bloom/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockTranslate, i18n: { language: 'en' } }),
}));
const mockTranslate = (key: string) => key;
jest.mock('@/hooks/useCheckoutFeedback', () => ({
  useCheckoutFeedback: () => ({ play: mockPlay, stop: jest.fn() }),
}));
const binding = {
  apiUrl: 'http://127.0.0.1:4310',
  intentId: 'pi_localtest',
  clientSecret: 'opaque-payer-capability',
};
let renderer: TestRenderer.ReactTestRenderer;
beforeEach(() => {
  jest.useFakeTimers();
  mockConfirm.mockReset();
  mockPlay.mockClear();
  mockClose.mockClear();
  mockUnsubscribe.mockClear();
  mockRead.mockResolvedValue(intent);
  mockAction.mockResolvedValue({
    kind: 'client_secret',
    publishableKey: 'pk_test_fixture',
    value: 'provider-confirmation-capability',
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  jest.useRealTimers();
});
async function mount() {
  await act(async () => {
    renderer = TestRenderer.create(
      <LocalProviderTestSheet binding={binding} onClose={mockClose} />,
    );
  });
}
it('keeps hosted fields mounted during confirmation and only completes from settled gateway status', async () => {
  let resolve: ((value: { accepted: true }) => void) | undefined;
  mockConfirm.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await mount();
  act(() => mockSheet.onStep('card'));
  const pay = renderer.root.findAllByType('button').find((button) => !button.props.disabled);
  if (!pay) throw new Error('Expected enabled provider pay action');
  act(() => pay.props.onClick());
  expect(mockSheet.step).toBe('card');
  expect(mockSheet.interactionBlocked).toBe(true);
  expect(mockConfirm).toHaveBeenCalledTimes(1);
  act(() => pay.props.onClick());
  expect(mockConfirm).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolve?.({ accepted: true });
  });
  expect(mockSheet.step).toBe('processing');
  expect(mockPlay).not.toHaveBeenCalled();
  act(() => mockUpdate({ ...intent, status: 'settled' }));
  expect(mockSheet.step).toBe('success');
  expect(mockPlay).toHaveBeenCalledTimes(1);
  act(() => mockUpdate({ ...intent, status: 'settled' }));
  expect(mockPlay).toHaveBeenCalledTimes(1);
  act(() => jest.advanceTimersByTime(1500));
  expect(mockSheet.brandState).toBe('idle');
  act(() => jest.advanceTimersByTime(300));
  expect(mockClose).toHaveBeenCalledTimes(1);
  act(() => mockSheet.onClose());
  expect(mockClose).toHaveBeenCalledTimes(1);
});
it('refuses a live publishable key and never mounts confirmable fields', async () => {
  mockAction.mockResolvedValue({
    kind: 'client_secret',
    publishableKey: 'pk_live_forbidden',
    value: 'not-used',
  });
  await mount();
  expect(renderer.root.findAllByType('button')).toHaveLength(1);
  expect(mockConfirm).not.toHaveBeenCalled();
});
it('leaves declined provider confirmation recoverable without declaring success', async () => {
  mockConfirm.mockResolvedValue({ accepted: false, error: 'Test decline' });
  await mount();
  act(() => mockSheet.onStep('card'));
  const pay = renderer.root.findAllByType('button').find((button) => !button.props.disabled);
  if (!pay) throw new Error('Expected pay action');
  await act(async () => {
    pay.props.onClick();
  });
  expect(mockSheet.step).toBe('card');
  expect(mockSheet.interactionBlocked).toBe(false);
  expect(mockPlay).not.toHaveBeenCalled();
});
it('does not remove authentication fields on a pending observation or regress a settled result from a late client error', async () => {
  let finish: ((value: { accepted: false; error: string }) => void) | undefined;
  mockConfirm.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  act(() => mockSheet.onStep('card'));
  const pay = renderer.root.findAllByType('button').find((button) => !button.props.disabled);
  if (!pay) throw new Error('Expected pay action');
  act(() => pay.props.onClick());
  act(() => mockUpdate({ ...intent, status: 'confirming' }));
  expect(mockSheet.step).toBe('card');
  expect(mockSheet.interactionBlocked).toBe(true);
  act(() => mockUpdate({ ...intent, status: 'settled' }));
  await act(async () => {
    finish?.({ accepted: false, error: 'Late client cancellation' });
  });
  expect(mockSheet.step).toBe('success');
  expect(mockSheet.notice).toBeUndefined();
  act(() => mockUpdate({ ...intent, status: 'created' }));
  expect(mockSheet.step).toBe('success');
});
