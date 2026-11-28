// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { EmbeddedCheckoutBinding } from './embeddedCheckout';
import type { PlusOffer } from './plusCheckout';

/** Immutable catalogue terms captured by the explicit Subscribe action. */
export interface CheckoutReview {
  productId: string;
  offerId: string;
  offerVersion: number;
  amountMinorUnits: number;
  currency: string;
  interval: 'month' | 'year';
}
export function captureCheckoutReview(offer: PlusOffer | null): CheckoutReview | null {
  const price = offer?.price;
  if (
    !offer ||
    !price ||
    !offer.productId ||
    !offer.offerId ||
    !Number.isSafeInteger(offer.offerVersion) ||
    offer.offerVersion < 1 ||
    !/^[A-Z]{3}$/.test(price.currency) ||
    (price.interval !== 'month' && price.interval !== 'year') ||
    !Number.isSafeInteger(price.amountMinorUnits) ||
    price.amountMinorUnits <= 0
  )
    return null;
  return {
    productId: offer.productId,
    offerId: offer.offerId,
    offerVersion: offer.offerVersion,
    amountMinorUnits: price.amountMinorUnits,
    currency: price.currency,
    interval: price.interval,
  };
}

/** The bootstrap cannot silently replace the price or cadence the buyer reviewed. */
export function checkoutMatchesReview(
  binding: EmbeddedCheckoutBinding,
  review: CheckoutReview,
): boolean {
  const subscription = binding.subscription;
  const intent = binding.initial?.intent;
  return (
    !!subscription &&
    !!intent &&
    subscription.interval === review.interval &&
    subscription.currency === review.currency &&
    subscription.amountMinorUnits === review.amountMinorUnits &&
    intent.currency === review.currency &&
    intent.amount === String(review.amountMinorUnits)
  );
}
