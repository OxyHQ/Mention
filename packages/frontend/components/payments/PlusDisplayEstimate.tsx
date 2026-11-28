// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
