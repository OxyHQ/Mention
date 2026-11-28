import {
  checkoutStorageKey,
  checkoutUrl,
  plusOfferBinding,
  resolvePlusOffer,
} from '../plusCheckout';
import type { ProductPlanCatalogue } from '@oxy.so/contracts';

const catalogue: ProductPlanCatalogue = {
  schemaVersion: 1,
  productId: 'mention-product',
  purchase: 'available',
  plans: [
    {
      offerId: 'approved-bundle',
      offerVersion: 2,
      displayName: 'Oxy One',
      productId: 'mention-product',
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
it('requires explicit valid binding, matching version, published price independently from purchase readiness', () => {
  expect(plusOfferBinding(undefined, '2')).toBeNull();
  expect(plusOfferBinding('approved-bundle', '2x')).toBeNull();
  expect(plusOfferBinding('approved-bundle', '9007199254740992')).toBeNull();
  const binding = plusOfferBinding('approved-bundle', '2', 'mention-product', 'plus');
  expect(resolvePlusOffer(catalogue, binding)?.price?.amountMinorUnits).toBe(500);
  expect(
    resolvePlusOffer(catalogue, {
      productId: 'mention-product',
      capabilityKey: 'plus',
      offerId: 'approved-bundle',
      offerVersion: 1,
    }),
  ).toBeNull();
  expect(resolvePlusOffer({ ...catalogue, purchase: 'unavailable' }, binding)).toEqual(
    catalogue.plans[0],
  );
  expect(
    resolvePlusOffer({ ...catalogue, plans: [...catalogue.plans, ...catalogue.plans] }, binding),
  ).toBeNull();
});
it('isolates durable keys by account, offer and version', () => {
  const binding = {
    productId: 'mention-product',
    capabilityKey: 'plus',
    offerId: 'a.b',
    offerVersion: 1,
  };
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

import { annualPlusTotal, plusPriceMajorUnits, resolvePlusCadenceOffer } from '../plusCheckout';
const monthBinding = {
  productId: 'mention-product',
  capabilityKey: 'plus',
  offerId: 'month',
  offerVersion: 1,
};
const yearBinding = { ...monthBinding, offerId: 'year' };
function cadenceCatalogue(monthly = 999, annual = 9590, currency = 'EUR'): ProductPlanCatalogue {
  const base = catalogue.plans[0];
  if (!base?.price) throw new Error('Missing fixture');
  return {
    ...catalogue,
    plans: [
      {
        ...base,
        offerId: 'month',
        offerVersion: 1,
        price: { ...base.price, currency, amountMinorUnits: monthly, interval: 'month' },
      },
      {
        ...base,
        offerId: 'year',
        offerVersion: 1,
        price: { ...base.price, currency, amountMinorUnits: annual, interval: 'year' },
      },
    ],
  };
}
it('uses the published annual total only when it gives 20% off twelve monthly payments', () => {
  const bindings = { month: monthBinding, year: yearBinding };
  expect(
    resolvePlusCadenceOffer(cadenceCatalogue(), 'year', bindings)?.price?.amountMinorUnits,
  ).toBe(9590);
  expect(resolvePlusCadenceOffer(cadenceCatalogue(999, 9591), 'year', bindings)).toBeNull();
  expect(
    resolvePlusCadenceOffer(cadenceCatalogue(999, 9591), 'month', bindings)?.price
      ?.amountMinorUnits,
  ).toBe(999);
  expect(
    resolvePlusCadenceOffer(cadenceCatalogue(), 'year', { ...bindings, year: null }),
  ).toBeNull();
  expect(
    resolvePlusCadenceOffer(cadenceCatalogue(), 'year', { ...bindings, month: null }),
  ).toBeNull();
  expect(
    resolvePlusCadenceOffer(cadenceCatalogue(), 'year', {
      ...bindings,
      year: { ...yearBinding, capabilityKey: 'other' },
    }),
  ).toBeNull();
});
it('rejects annual currency or cadence mismatch and stale offer versions', () => {
  const c = cadenceCatalogue();
  const annual = c.plans[1];
  if (!annual?.price) throw new Error('Missing fixture');
  const bindings = { month: monthBinding, year: yearBinding };
  for (const changed of [
    { ...annual, price: { ...annual.price, currency: 'USD' } },
    { ...annual, price: { ...annual.price, interval: 'month' as const } },
    { ...annual, offerVersion: 2 },
  ])
    expect(
      resolvePlusCadenceOffer({ ...c, plans: [...c.plans.slice(0, 1), changed] }, 'year', bindings),
    ).toBeNull();
});
it('rounds the discount with integer minor units and refuses invalid or overflowing prices', () => {
  expect(annualPlusTotal(1)).toBe(10);
  expect(annualPlusTotal(2)).toBe(19);
  expect(annualPlusTotal(500)).toBe(4800);
  for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    expect(annualPlusTotal(invalid)).toBeNull();
});
it('formats supported currency precision without assuming all currencies have cents', () => {
  const price = catalogue.plans[0]?.price;
  if (!price) throw new Error('Missing fixture');
  expect(plusPriceMajorUnits({ ...price, currency: 'EUR', amountMinorUnits: 999 })).toBe(9.99);
  expect(plusPriceMajorUnits({ ...price, currency: 'JPY', amountMinorUnits: 999 })).toBe(999);
  expect(plusPriceMajorUnits({ ...price, currency: 'KWD', amountMinorUnits: 999 })).toBe(0.999);
});

it('refuses to display an amount when currency precision is unavailable', () => {
  const price = catalogue.plans[0]?.price;
  if (!price) throw new Error('Missing fixture');
  const resolved = new Intl.NumberFormat('en', {
    style: 'currency',
    currency: 'USD',
  }).resolvedOptions();
  const spy = jest.spyOn(Intl.NumberFormat.prototype, 'resolvedOptions').mockReturnValue({
    ...resolved,
    maximumFractionDigits: undefined,
  });
  try {
    expect(() => plusPriceMajorUnits(price)).toThrow('Currency precision unavailable');
  } finally {
    spy.mockRestore();
  }
});
