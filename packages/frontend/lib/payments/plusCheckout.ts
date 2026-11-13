import type { PersonalPlanCatalogue } from '@oxy.so/contracts';

export interface PlusOfferBinding {
  offerId: string;
  offerVersion: number;
}
export type PlusOffer = PersonalPlanCatalogue['plans'][number];

/** Deployment chooses a reviewed central offer; never infer one from a label or price. */
export function plusOfferBinding(id?: string, version?: string): PlusOfferBinding | null {
  if (!id || !version || !/^[1-9][0-9]*$/.test(version)) return null;
  const offerVersion = Number(version);
  return Number.isSafeInteger(offerVersion) ? { offerId: id, offerVersion } : null;
}
export function resolvePlusOffer(
  catalogue: PersonalPlanCatalogue,
  binding: PlusOfferBinding | null,
): PlusOffer | null {
  if (!binding || catalogue.state !== 'configured' || catalogue.purchase !== 'available')
    return null;
  const matches = catalogue.plans.filter(
    (plan) => plan.offerId === binding.offerId && plan.offerVersion === binding.offerVersion,
  );
  const offer = matches.length === 1 ? matches[0] : undefined;
  return offer?.price?.currency === 'USD' &&
    offer.price.interval === 'month' &&
    offer.kind === 'oxy_one' &&
    offer.audience === 'personal'
    ? offer
    : null;
}

export function checkoutStorageKey(accountId: string, offer: PlusOfferBinding): string {
  return `mention.plus.checkout.${encodeURIComponent(accountId)}.${encodeURIComponent(offer.offerId)}.${offer.offerVersion}`;
}

/** Central checkout owns the destination; disallow executable/userinfo URLs. */
export function checkoutUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('Invalid checkout URL');
  return url.toString();
}
