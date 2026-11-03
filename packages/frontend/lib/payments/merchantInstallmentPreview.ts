/** Local provider capability fixtures, never live financing eligibility or a credit decision. */
export type InstallmentFamily = 'pay_later' | 'pay_in_3' | 'pay_in_4' | 'financing';
export type InstallmentPreviewDecision = 'available' | 'pending' | 'rejected' | 'unavailable';
export type PurchaseKind = 'one_time' | 'subscription';
export interface MerchantInstallmentPreferences {
  enabled: boolean;
  families: readonly InstallmentFamily[];
  minMinorUnits: number;
  maxMinorUnits: number;
  countries: readonly string[];
  currencies: readonly string[];
  purchaseKinds: readonly PurchaseKind[];
  message: string;
  terms: string;
}
export interface InstallmentContext {
  currency: string;
  country: string;
  amountMinorUnits: number;
  purchaseKind: PurchaseKind;
}
export interface InstallmentCapability {
  id: InstallmentFamily;
  family: InstallmentFamily;
  available: boolean;
  paymentCount: number;
  spacingDays: number;
  firstPaymentDays: number;
  minMinorUnits: number;
  maxMinorUnits: number;
  countries: readonly string[];
  currencies: readonly string[];
  purchaseKinds: readonly PurchaseKind[];
}
const base = {
  available: true,
  countries: ['US', 'CA'],
  currencies: ['USD'],
  purchaseKinds: ['one_time'] as const,
  minMinorUnits: 1000,
  maxMinorUnits: 100000,
  firstPaymentDays: 0,
};
export const INSTALLMENT_CAPABILITY_FIXTURES: readonly InstallmentCapability[] = [
  { ...base, id: 'pay_in_4', family: 'pay_in_4', paymentCount: 4, spacingDays: 14 },
  { ...base, id: 'pay_in_3', family: 'pay_in_3', paymentCount: 3, spacingDays: 30 },
  {
    ...base,
    id: 'pay_later',
    family: 'pay_later',
    paymentCount: 1,
    spacingDays: 0,
    firstPaymentDays: 30,
  },
  {
    ...base,
    id: 'financing',
    family: 'financing',
    available: false,
    paymentCount: 6,
    spacingDays: 30,
  },
];
export const DEFAULT_MERCHANT_INSTALLMENT_PREFERENCES: MerchantInstallmentPreferences = {
  enabled: true,
  families: ['pay_in_4'],
  minMinorUnits: 1000,
  maxMinorUnits: 100000,
  countries: ['US'],
  currencies: ['USD'],
  purchaseKinds: ['one_time'],
  message: '',
  terms: '',
};

export function validMerchantInstallmentPreferences(
  value: MerchantInstallmentPreferences,
): boolean {
  return (
    Number.isSafeInteger(value.minMinorUnits) &&
    value.minMinorUnits >= 0 &&
    Number.isSafeInteger(value.maxMinorUnits) &&
    value.maxMinorUnits >= value.minMinorUnits &&
    value.message.length <= 160 &&
    value.terms.length <= 2000
  );
}

/** Merchant preferences narrow the provider's capability; they cannot create one. */
export function eligibleInstallmentPlans(
  preferences: MerchantInstallmentPreferences,
  context: InstallmentContext,
  capabilities: readonly InstallmentCapability[] = INSTALLMENT_CAPABILITY_FIXTURES,
): readonly InstallmentCapability[] {
  if (
    !preferences.enabled ||
    !validMerchantInstallmentPreferences(preferences) ||
    !Number.isSafeInteger(context.amountMinorUnits) ||
    context.amountMinorUnits <= 0 ||
    !preferences.countries.includes(context.country) ||
    !preferences.currencies.includes(context.currency) ||
    !preferences.purchaseKinds.includes(context.purchaseKind) ||
    context.amountMinorUnits < preferences.minMinorUnits ||
    context.amountMinorUnits > preferences.maxMinorUnits
  )
    return [];
  return capabilities.filter(
    (capability) =>
      capability.available &&
      preferences.families.includes(capability.family) &&
      capability.countries.includes(context.country) &&
      capability.currencies.includes(context.currency) &&
      capability.purchaseKinds.includes(context.purchaseKind) &&
      context.amountMinorUnits >= capability.minMinorUnits &&
      context.amountMinorUnits <= capability.maxMinorUnits,
  );
}

/** Explicit local quote fixture. Real schedules, fees and approval must come from the provider. */
export function previewInstallmentSchedule(
  totalMinorUnits: number,
  capability: InstallmentCapability,
) {
  if (
    !Number.isSafeInteger(totalMinorUnits) ||
    totalMinorUnits <= 0 ||
    !capability.available ||
    !Number.isSafeInteger(capability.paymentCount) ||
    capability.paymentCount < 1 ||
    capability.paymentCount > 36
  )
    return null;
  const regular = Math.floor(totalMinorUnits / capability.paymentCount);
  const remainder = totalMinorUnits % capability.paymentCount;
  const payments = Array.from({ length: capability.paymentCount }, (_, index) => ({
    amountMinorUnits: regular + (index === 0 ? remainder : 0),
    dueInDays: capability.firstPaymentDays + index * capability.spacingDays,
  }));
  return {
    totalMinorUnits,
    feesMinorUnits: 0,
    dueTodayMinorUnits: payments
      .filter((payment) => payment.dueInDays === 0)
      .reduce((sum, payment) => sum + payment.amountMinorUnits, 0),
    payments,
  };
}
