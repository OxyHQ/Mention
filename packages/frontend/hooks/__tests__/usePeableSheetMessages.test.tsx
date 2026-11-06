import TestRenderer, { act } from 'react-test-renderer';
import { usePeableSheetMessages } from '../usePeableSheetMessages';

// The translator echoes the key and the values it was handed, so the mapping
// itself is what is asserted.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values ? `${key}|${JSON.stringify(values)}` : key,
  }),
}));

function messages(): Readonly<Record<string, string>> {
  let value: Readonly<Record<string, string>> = {};
  function Probe() {
    value = usePeableSheetMessages();
    return null;
  }
  act(() => {
    TestRenderer.create(<Probe />);
  });
  return value;
}

it("words Peable's sheet with Mention's own checkout copy", () => {
  const copy = messages();
  expect(copy.dueToday).toBe('plus.checkout.dueToday');
  expect(copy['result.success']).toBe('plus.checkout.result.success');
  expect(copy.paymentHint).toBe('plus.checkout.choosePayment');
  expect(copy['card.hosted.action']).toBe('plus.checkout.card.open');
  expect(copy['error.declined']).toBe('plus.checkout.providerTest.declined');
  expect(copy['faircoin.peableHint']).toBe('plus.checkout.faircoin.hint');
  expect(copy['faircoin.externalHint']).toBe('plus.checkout.faircoin.hint');
});

it("leaves the SDK's own placeholders for the SDK to fill", () => {
  const copy = messages();
  expect(copy.payMerchant).toBe('plus.checkout.payMerchant|{"merchant":"{{merchant}}"}');
  expect(copy['faircoin.quote']).toBe(
    'plus.checkout.faircoin.quote|{"amount":"{{amount}}","rate":"{{rate}}","currency":"{{currency}}"}',
  );
  expect(copy['faircoin.holdsUntil']).toBe('plus.checkout.faircoin.holdsUntil|{"time":"{{time}}"}');
});

it('names every FairCoin reason and transfer state the SDK shows', () => {
  const copy = messages();
  expect(copy['faircoin.unavailable.faircoin_wallet_missing']).toBe(
    'plus.checkout.faircoin.unavailable.walletMissing',
  );
  expect(copy['faircoin.unavailable.price_unavailable']).toBe(
    'plus.checkout.faircoin.unavailable.priceUnavailable',
  );
  for (const state of ['awaiting', 'detected', 'processing', 'succeeded', 'failure', 'expired'])
    expect(copy[`faircoin.transfer.${state}`]).toBe(`plus.checkout.faircoin.transfer.${state}`);
});
