import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Mention's own words for Peable's payment sheet (`PeableSheetCheckout`), in
 * every locale Mention ships. The SDK carries English and Spanish; this maps
 * its keys onto the `plus.checkout.*` copy Mention already translates, so the
 * sheet reads the same as the rest of Mention. A key left out keeps the SDK's.
 */
const SAME_KEYS = [
  'dueToday',
  'recurring',
  'starts',
  'month',
  'year',
  'continue',
  'addContact',
  'addPayment',
  'section.contact',
  'section.payment',
  'step.contact',
  'step.payment',
  'step.card',
  'contactHint',
  'email',
  'subtotal',
  'tax',
  'confirmSubscription',
  'result.processing',
  'result.processingHint',
  'result.success',
  'result.successHint',
  'result.failure',
  'result.failureHint',
  'done',
  'tryAgain',
] as const;

const TRANSFER_STATES = [
  'awaiting',
  'detected',
  'processing',
  'succeeded',
  'failure',
  'expired',
] as const;

/** The SDK's FairCoin reasons, by the key Mention words each one under. */
const FAIRCOIN_REASONS = {
  faircoin_wallet_missing: 'walletMissing',
  faircoin_network_closed: 'networkClosed',
  price_unavailable: 'priceUnavailable',
  temporarily_unavailable: 'temporarilyUnavailable',
} as const;

export function usePeableSheetMessages(): Readonly<Record<string, string>> {
  const { t } = useTranslation();
  return useMemo(() => {
    const faircoin = (key: string, values?: Record<string, string>) =>
      t(`plus.checkout.faircoin.${key}`, values);
    return {
      ...Object.fromEntries(SAME_KEYS.map((key) => [key, t(`plus.checkout.${key}`)])),
      // The SDK fills `{{…}}` itself, so the placeholders pass through.
      payMerchant: t('plus.checkout.payMerchant', { merchant: '{{merchant}}' }),
      payAmount: t('plus.checkout.payAmount', { amount: '{{amount}}' }),
      paymentHint: t('plus.checkout.choosePayment'),
      'method.card': t('plus.checkout.card.generic'),
      'card.hosted.title': t('plus.checkout.card.generic'),
      'card.hosted.description': t('plus.checkout.card.hint'),
      'card.hosted.action': t('plus.checkout.card.open'),
      'provider.loading': t('plus.checkout.providerTest.loading'),
      'error.connection': t('plus.checkout.providerTest.connection'),
      'error.declined': t('plus.checkout.providerTest.declined'),
      'faircoin.title': faircoin('title'),
      'faircoin.available': faircoin('available'),
      'faircoin.quote': faircoin('quote', {
        amount: '{{amount}}',
        rate: '{{rate}}',
        currency: '{{currency}}',
      }),
      'faircoin.holdsUntil': faircoin('holdsUntil', { time: '{{time}}' }),
      'faircoin.peableHint': faircoin('hint'),
      'faircoin.externalHint': faircoin('hint'),
      'faircoin.peableOnly': faircoin('peableOnly'),
      'faircoin.qr': faircoin('qr'),
      'faircoin.confirming': faircoin('confirming'),
      'faircoin.noPeable': faircoin('noPeable'),
      'faircoin.otherMethod': faircoin('otherMethod'),
      ...Object.fromEntries(
        Object.entries(FAIRCOIN_REASONS).map(([reason, key]) => [
          `faircoin.unavailable.${reason}`,
          faircoin(`unavailable.${key}`),
        ]),
      ),
      ...Object.fromEntries(
        TRANSFER_STATES.map((state) => [
          `faircoin.transfer.${state}`,
          faircoin(`transfer.${state}`),
        ]),
      ),
    };
    // `t` is re-bound when the language changes, so it is the one dependency.
  }, [t]);
}
