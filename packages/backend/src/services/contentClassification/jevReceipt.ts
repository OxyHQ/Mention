import { z } from 'zod';
import type { InferenceEnvironment, InferenceRequestOutcome, UsageQuantity, UsageSource } from '@oxy.so/contracts';
import { currencyCodeSchema, exactDecimalSchema, inferenceEnvironmentSchema,
  inferenceRequestOutcomeSchema, usageQuantitySchema, usageSourceSchema } from '@oxy.so/contracts';
import type { OxyInferenceClient } from '@oxy.so/core/inference';

/** Original public attribution only; never a bearer or provider credential. */
export const shadowReceiptAuthoritySchema = z.object({
  applicationId: z.string().min(1), credentialId: z.string().min(1),
  environment: z.custom<InferenceEnvironment>(value => inferenceEnvironmentSchema.safeParse(value).success), delegatedUserId: z.string().min(1).optional(),
}).strict();
export type ShadowReceiptAuthority = z.infer<typeof shadowReceiptAuthoritySchema>;

/** Storage projection of usage evidence, deliberately separate from answers. */
export const shadowUsageReconciliationSchema = z.object({
  status: z.literal('reconciled_result_missing'), requestId: z.string().min(1),
  authority: shadowReceiptAuthoritySchema, model: z.string().min(1), provider: z.string().min(1),
  outcome: z.custom<InferenceRequestOutcome>(value => inferenceRequestOutcomeSchema.safeParse(value).success),
  usageSource: z.custom<UsageSource>(value => usageSourceSchema.safeParse(value).success),
  units: z.array(z.custom<UsageQuantity>(value => usageQuantitySchema.safeParse(value).success))
    .refine(units => new Set(units.map(unit => unit.unit)).size === units.length), settledAt: z.string().datetime(),
  // Provider invoiced cost is not part of either generation-record variant.
  providerCost: z.literal('unknown'),
  economics: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('customer_charge'), receiptId: z.string().min(1),
      amount: z.custom<string>(value => exactDecimalSchema.safeParse(value).success),
      currency: z.custom<string>(value => currencyCodeSchema.safeParse(value).success), priceVersionId: z.string().min(1),
      platformFeeOnly: z.boolean() }).strict(),
    z.object({ kind: z.literal('internal_usage'), customerCharge: z.literal('not_charged'),
      tariff: z.discriminatedUnion('status', [
        z.object({ status: z.literal('quoted'), amount: z.custom<string>(value => exactDecimalSchema.safeParse(value).success),
      currency: z.custom<string>(value => currencyCodeSchema.safeParse(value).success),
          priceVersionId: z.string().min(1) }).strict(),
        z.object({ status: z.literal('unpriced'), priceVersionId: z.string().min(1).nullable() }).strict(),
      ]) }).strict(),
  ]),
}).strict();
export type ShadowUsageReconciliation = z.infer<typeof shadowUsageReconciliationSchema>;
export interface ShadowReceiptReader {
  readonly authority: ShadowReceiptAuthority;
  readOriginal(key: string, model: string, signal?: AbortSignal): Promise<ShadowUsageReconciliation>;
}
export function sameReceiptAuthority(a: ShadowReceiptAuthority, b: ShadowReceiptAuthority): boolean {
  return a.applicationId === b.applicationId && a.credentialId === b.credentialId
    && a.environment === b.environment && a.delegatedUserId === b.delegatedUserId;
}

export function createJevReceiptReader(
  client: Pick<OxyInferenceClient, 'getGenerationRecordByIdempotencyKey'>,
  input: ShadowReceiptAuthority,
): ShadowReceiptReader {
  const authority = Object.freeze(shadowReceiptAuthoritySchema.parse(input));
  return { authority, async readOriginal(key, model, signal) {
    // Exactly one read; failures/404 propagate, leaving the original claim intact.
    const record = await client.getGenerationRecordByIdempotencyKey(key,
      { signal, ...(authority.delegatedUserId === undefined ? {} : { delegatedUserId: authority.delegatedUserId }) });
    if (!sameReceiptAuthority(authority, record) || record.resolvedModelReference !== model) {
      throw new Error('Recovered usage does not match the original authority and model');
    }
    return shadowUsageReconciliationSchema.parse({ status: 'reconciled_result_missing',
      requestId: record.requestId, authority, model, provider: record.servingProvider,
      outcome: record.outcome, usageSource: record.usageSource, units: record.units,
      settledAt: record.settledAt, providerCost: 'unknown',
      economics: record.schemaVersion === 1
        ? { kind: 'customer_charge', receiptId: record.receiptId, amount: record.billedAmount,
            currency: record.currency, priceVersionId: record.priceSnapshot.priceVersionId, platformFeeOnly: record.platformFeeOnly }
        : { kind: 'internal_usage', customerCharge: record.customerCharge.status, tariff: record.tariff },
    });
  } };
}
