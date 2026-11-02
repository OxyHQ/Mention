import type { ProductPlanCatalogue } from '@oxy.so/contracts';

export interface PlusOfferBinding {
  productId: string;
  capabilityKey: string;
  offerId: string;
  offerVersion: number;
}
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
  if (!binding || catalogue.productId !== binding.productId || catalogue.purchase !== 'available')
    return null;
  const matches = catalogue.plans.filter(
    (plan) =>
      plan.productId === binding.productId &&
      plan.offerId === binding.offerId &&
      plan.offerVersion === binding.offerVersion,
  );
  const offer = matches.length === 1 ? matches[0] : undefined;
  return offer?.price?.currency === 'USD' &&
    (offer.price.interval === 'month' || offer.price.interval === 'year')
    ? offer
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
  binding: PlusOfferBinding,
): boolean {
  if (access.subjectAccountId !== accountId || access.productId !== binding.productId)
    throw new Error('Account changed');
  return access.capabilities.some(
    (capability) => capability.key === binding.capabilityKey && capability.grantIds.length > 0,
  );
}
