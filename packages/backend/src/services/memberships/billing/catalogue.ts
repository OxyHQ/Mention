/** Reviewed deployment catalogue, not creator-controlled metadata or provider discovery. */
export interface MembershipBillingOffer {
  communityId: string;
  tierId: string;
  offerId: string;
  offerVersion: number;
  merchantId: string;
  appId: string;
  mode: 'test' | 'live';
  environment: 'development' | 'staging' | 'production';
  providerPriceId: string;
  planId: string;
}

/** Commercial configuration is deferred. No existing merchant/cohort is borrowed. */
export const MEMBERSHIP_BILLING_CATALOGUE: readonly MembershipBillingOffer[] = Object.freeze([]);
