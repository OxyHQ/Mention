import {
  DEFAULT_MERCHANT_INSTALLMENT_PREFERENCES as defaults,
  INSTALLMENT_CAPABILITY_FIXTURES,
  eligibleInstallmentPlans,
  previewInstallmentSchedule,
} from '../merchantInstallmentPreview';
const order = {
  currency: 'USD',
  country: 'US',
  amountMinorUnits: 2800,
  purchaseKind: 'one_time' as const,
};

it('offers only merchant-enabled provider-capable plans and supports disabling them', () => {
  expect(eligibleInstallmentPlans(defaults, order).map((plan) => plan.id)).toEqual(['pay_in_4']);
  expect(eligibleInstallmentPlans({ ...defaults, enabled: false }, order)).toEqual([]);
  expect(
    eligibleInstallmentPlans(
      { ...defaults, families: ['pay_in_3', 'pay_later', 'financing'] },
      order,
    ).map((plan) => plan.id),
  ).toEqual(['pay_in_3', 'pay_later']);
});
it('intersects country, currency, amount and purchase-kind restrictions without expanding provider authority', () => {
  expect(eligibleInstallmentPlans({ ...defaults, minMinorUnits: 2801 }, order)).toEqual([]);
  expect(eligibleInstallmentPlans({ ...defaults, maxMinorUnits: 2799 }, order)).toEqual([]);
  expect(eligibleInstallmentPlans({ ...defaults, countries: ['CA'] }, order)).toEqual([]);
  expect(
    eligibleInstallmentPlans({ ...defaults, currencies: ['EUR'] }, { ...order, currency: 'EUR' }),
  ).toEqual([]);
  expect(
    eligibleInstallmentPlans({ ...defaults, countries: ['FR'] }, { ...order, country: 'FR' }),
  ).toEqual([]);
  expect(
    eligibleInstallmentPlans(
      { ...defaults, purchaseKinds: ['subscription'] },
      { ...order, purchaseKind: 'subscription' },
    ),
  ).toEqual([]);
  // Subscription support belongs to each capability, not a hard-coded global exclusion.
  expect(
    eligibleInstallmentPlans(
      { ...defaults, purchaseKinds: ['subscription'] },
      { ...order, purchaseKind: 'subscription' },
      INSTALLMENT_CAPABILITY_FIXTURES.map((plan) => ({
        ...plan,
        purchaseKinds: ['subscription'] as const,
      })),
    ),
  ).toHaveLength(1);
});
it('rejects malformed limits and a zero-due order', () => {
  for (const limits of [
    { minMinorUnits: Number.NaN },
    { maxMinorUnits: 1 },
    { minMinorUnits: -1 },
    { maxMinorUnits: Number.MAX_SAFE_INTEGER + 1 },
  ])
    expect(eligibleInstallmentPlans({ ...defaults, ...limits }, order)).toEqual([]);
  expect(eligibleInstallmentPlans(defaults, { ...order, amountMinorUnits: 0 })).toEqual([]);
  expect(eligibleInstallmentPlans({ ...defaults, message: 'x'.repeat(161) }, order)).toEqual([]);
});
it('keeps quoted schedules exact, including unequal first payment and deferred first payment', () => {
  const plans = eligibleInstallmentPlans(
    { ...defaults, families: ['pay_in_3', 'pay_in_4', 'pay_later'] },
    order,
  );
  const schedules = plans.map((plan) => ({
    id: plan.id,
    quote: previewInstallmentSchedule(2800, plan),
  }));
  expect(
    schedules
      .find((item) => item.id === 'pay_in_3')
      ?.quote?.payments.map((item) => item.amountMinorUnits),
  ).toEqual([934, 933, 933]);
  expect(schedules.find((item) => item.id === 'pay_in_4')?.quote?.dueTodayMinorUnits).toBe(700);
  expect(schedules.find((item) => item.id === 'pay_later')?.quote?.dueTodayMinorUnits).toBe(0);
  expect(schedules.find((item) => item.id === 'pay_later')?.quote?.payments).toEqual([
    { amountMinorUnits: 2800, dueInDays: 30 },
  ]);
  for (const { quote } of schedules)
    expect(quote?.payments.reduce((sum, payment) => sum + payment.amountMinorUnits, 0)).toBe(2800);
});
