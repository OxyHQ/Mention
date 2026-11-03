import type { ProductPlanCatalogue } from '@oxy.so/contracts';

export interface PlusOfferBinding {
  productId: string;
  capabilityKey: string;
  offerId: string;
  offerVersion: number;
}
export type PlusCadence = 'month' | 'year';
export type PlusOffer = ProductPlanCatalogue['plans'][number];

/** Deployment chooses a reviewed central offer; never infer one from a label or price. */
export function plusOfferBinding(
  id?: string,
  version?: string,
  productId?: string,
  capabilityKey?: string,
): PlusOfferBinding | null {
  if (!productId || !capabilityKey || !id || !version || !/^[1-9][0-9]*$/.test(version))
    return null;
  const offerVersion = Number(version);
  return Number.isSafeInteger(offerVersion)
    ? { productId, capabilityKey, offerId: id, offerVersion }
    : null;
}
export function resolvePlusOffer(
  catalogue: ProductPlanCatalogue,
  binding: PlusOfferBinding | null,
): PlusOffer | null {
  if (!binding || catalogue.productId !== binding.productId) return null;
  const matches = catalogue.plans.filter(
    (plan) =>
      plan.productId === binding.productId &&
      plan.offerId === binding.offerId &&
      plan.offerVersion === binding.offerVersion,
  );
  const offer = matches.length === 1 ? matches[0] : undefined;
  return offer?.price &&
    /^[A-Z]{3}$/.test(offer.price.currency) &&
    (offer.price.interval === 'month' || offer.price.interval === 'year')
    ? offer
    : null;
}

/** Display only: preserve ISO currency precision (JPY 0, EUR/USD 2, KWD 3). */
export function plusPriceMajorUnits(price: NonNullable<PlusOffer['price']>): number {
  const digits = new Intl.NumberFormat('en', {
    style: 'currency',
    currency: price.currency,
  }).resolvedOptions().maximumFractionDigits;
  if (digits === undefined) throw new Error('Currency precision unavailable');
  return price.amountMinorUnits / 10 ** digits;
}

/** 20% off twelve monthly payments, rounded to the nearest currency minor unit (half up).
 * This verifies a published total; it never supplies a checkout price. */
export function annualPlusTotal(monthlyMinorUnits: number): number | null {
  if (!Number.isSafeInteger(monthlyMinorUnits) || monthlyMinorUnits <= 0) return null;
  const total = (BigInt(monthlyMinorUnits) * 48n + 2n) / 5n;
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
}

export function resolvePlusCadenceOffer(
  catalogue: ProductPlanCatalogue,
  cadence: PlusCadence,
  bindings: Readonly<Record<PlusCadence, PlusOfferBinding | null>>,
): PlusOffer | null {
  const monthly = resolvePlusOffer(catalogue, bindings.month);
  if (
    monthly?.price?.interval !== 'month' ||
    annualPlusTotal(monthly.price.amountMinorUnits) === null
  )
    return null;
  if (cadence === 'month') return monthly;
  const annual = resolvePlusOffer(catalogue, bindings.year);
  if (
    !bindings.year ||
    bindings.year.productId !== bindings.month?.productId ||
    bindings.year.capabilityKey !== bindings.month?.capabilityKey
  )
    return null;
  return annual?.price?.interval === 'year' &&
    annual.price.currency === monthly.price.currency &&
    annual.price.amountMinorUnits === annualPlusTotal(monthly.price.amountMinorUnits)
    ? annual
    : null;
}

export function checkoutStorageKey(accountId: string, offer: PlusOfferBinding): string {
  return `mention.plus.checkout.${encodeURIComponent(accountId)}.${encodeURIComponent(offer.productId)}.${encodeURIComponent(offer.offerId)}.${offer.offerVersion}`;
}

/** Central checkout owns the destination; disallow executable/userinfo URLs. */
export function checkoutUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('Invalid checkout URL');
  return url.toString();
}

export function includesPlus(
  access: import('@oxy.so/contracts').SubjectProductAccess,
  accountId: string,
  binding: Pick<PlusOfferBinding, 'productId' | 'capabilityKey'>,
): boolean {
  if (access.subjectAccountId !== accountId || access.productId !== binding.productId)
    throw new Error('Account changed');
  return access.capabilities.some(
    (capability) => capability.key === binding.capabilityKey && capability.grantIds.length > 0,
  );
}
