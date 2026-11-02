import { Text } from '@oxy.so/bloom/typography';
import { useDisplayPrice } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import type { PlusOffer } from '@/lib/payments/plusCheckout';

/** Preference-only estimate. The approved offer and checkout remain in USD. */
export function PlusDisplayEstimate({ price }: { price: NonNullable<PlusOffer['price']> }) {
  const { currency, formatUsd } = useDisplayPrice();
  const { t } = useTranslation();
  if (currency === 'USD' || price.currency !== 'USD') return null;
  return (
    <Text>
      {t('plus.payment.displayEstimate', { estimate: formatUsd(price.amountMinorUnits) })}
    </Text>
  );
}
