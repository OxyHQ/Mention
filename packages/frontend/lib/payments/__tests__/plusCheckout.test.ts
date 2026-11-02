import {
  checkoutStorageKey,
  checkoutUrl,
  plusOfferBinding,
  resolvePlusOffer,
} from '../plusCheckout';
import type { PersonalPlanCatalogue } from '@oxy.so/contracts';

const catalogue: PersonalPlanCatalogue = {
  schemaVersion: 1,
  state: 'configured',
  purchase: 'available',
  plans: [
    {
      offerId: 'approved-bundle',
      offerVersion: 2,
      displayName: 'Oxy One',
      audience: 'personal',
      kind: 'oxy_one',
      benefits: [],
      price: {
        currency: 'USD',
        amountMinorUnits: 500,
        interval: 'month',
        trial: 'none',
        taxTreatment: 'inclusive',
        merchantTotal: 'final',
      },
    },
  ],
};
it('requires explicit valid binding, matching version, price and enabled catalogue', () => {
  expect(plusOfferBinding(undefined, '2')).toBeNull();
  expect(plusOfferBinding('approved-bundle', '2x')).toBeNull();
  expect(plusOfferBinding('approved-bundle', '9007199254740992')).toBeNull();
  const binding = plusOfferBinding('approved-bundle', '2');
  expect(resolvePlusOffer(catalogue, binding)?.price?.amountMinorUnits).toBe(500);
  expect(resolvePlusOffer(catalogue, { offerId: 'approved-bundle', offerVersion: 1 })).toBeNull();
  expect(resolvePlusOffer({ ...catalogue, purchase: 'unavailable' }, binding)).toBeNull();
  expect(
    resolvePlusOffer(
      { ...catalogue, plans: catalogue.plans.map((p) => ({ ...p, price: undefined })) },
      binding,
    ),
  ).toBeNull();
  expect(
    resolvePlusOffer({ ...catalogue, plans: [...catalogue.plans, ...catalogue.plans] }, binding),
  ).toBeNull();
});
it('isolates durable keys by account, offer and version', () => {
  const binding = { offerId: 'a.b', offerVersion: 1 };
  expect(checkoutStorageKey('a', binding)).not.toBe(checkoutStorageKey('b', binding));
  expect(checkoutStorageKey('a', binding)).not.toBe(
    checkoutStorageKey('a', { ...binding, offerVersion: 2 }),
  );
});
it('accepts provider-owned HTTPS destinations without executable or credential URLs', () => {
  expect(checkoutUrl('https://checkout.peable.to/c/id#cs=secret')).toContain('#cs=secret');
  expect(checkoutUrl('https://checkout.stripe.com/c/pay')).toBe(
    'https://checkout.stripe.com/c/pay',
  );
  for (const value of [
    'javascript:alert(1)',
    'http://checkout.peable.to',
    'https://user:pass@host.test',
  ]) {
    expect(() => checkoutUrl(value)).toThrow();
  }
});
