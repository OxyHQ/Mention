// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
  /** The Orbit price (`price_…`) the tier is sold at; a Peable price never changes what it charges. */
  providerPriceId: string;
}

/** Commercial configuration is deferred. No existing merchant/cohort is borrowed. */
export const MEMBERSHIP_BILLING_CATALOGUE: readonly MembershipBillingOffer[] = Object.freeze([]);
