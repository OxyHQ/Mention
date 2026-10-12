import { z } from 'zod';
import type {
  InferenceEnvironment,
  InferenceRequestOutcome,
  UsageQuantity,
  UsageSource,
} from '@oxy.so/contracts';
import {
  currencyCodeSchema,
  exactDecimalSchema,
  inferenceEnvironmentSchema,
  inferenceRequestOutcomeSchema,
  usageQuantitySchema,
  usageSourceSchema,
} from '@oxy.so/contracts';
import type { OxyInferenceClient } from '@oxy.so/core/inference';

/** Immutable source lineage, persisted before the original send; not a new permission. */
export const shadowRecoveryLineageSchema = z
  .object({
    version: z.literal(1),
    ownerAccountId: z.string().min(1),
    deploymentId: z.string().min(1),
    model: z.string().min(1),
    policyRef: z.string().min(1),
    policyVersion: z.number().int().positive(),
    evaluationVersion: z.string().min(1),
    provider: z.string().min(1),
    priceVersionId: z.string().min(1),
    sourceApprovalSha256: z.string().regex(/^[a-f0-9]{64}$/),
    inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.string().min(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ShadowRecoveryLineage = z.infer<typeof shadowRecoveryLineageSchema>;

/** Original public attribution only; never a bearer or provider credential. */
export const shadowReceiptAuthoritySchema = z
  .object({
    applicationId: z.string().min(1),
    credentialId: z.string().min(1),
    recovery: shadowRecoveryLineageSchema.optional(),
    environment: z.custom<InferenceEnvironment>(
      (value) => inferenceEnvironmentSchema.safeParse(value).success,
    ),
    delegatedUserId: z.string().min(1).optional(),
  })
  .strict();
export type ShadowReceiptAuthority = z.infer<typeof shadowReceiptAuthoritySchema>;

/** Storage projection of usage evidence, deliberately separate from answers. */
export const shadowUsageReconciliationSchema = z
  .object({
    status: z.literal('reconciled_result_missing'),
    requestId: z.string().min(1),
    authority: shadowReceiptAuthoritySchema,
    model: z.string().min(1),
    provider: z.string().min(1),
    outcome: z.custom<InferenceRequestOutcome>(
      (value) => inferenceRequestOutcomeSchema.safeParse(value).success,
    ),
    usageSource: z.custom<UsageSource>((value) => usageSourceSchema.safeParse(value).success),
    units: z
      .array(z.custom<UsageQuantity>((value) => usageQuantitySchema.safeParse(value).success))
      .refine((units) => new Set(units.map((unit) => unit.unit)).size === units.length),
    settledAt: z.string().datetime(),
    // Provider invoiced cost is not part of either generation-record variant.
    providerCost: z.literal('unknown'),
    economics: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('customer_charge'),
          receiptId: z.string().min(1),
          amount: z.custom<string>((value) => exactDecimalSchema.safeParse(value).success),
          currency: z.custom<string>((value) => currencyCodeSchema.safeParse(value).success),
          priceVersionId: z.string().min(1),
          platformFeeOnly: z.boolean(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('internal_usage'),
          customerCharge: z.literal('not_charged'),
          tariff: z.discriminatedUnion('status', [
            z
              .object({
                status: z.literal('quoted'),
                amount: z.custom<string>((value) => exactDecimalSchema.safeParse(value).success),
                currency: z.custom<string>((value) => currencyCodeSchema.safeParse(value).success),
                priceVersionId: z.string().min(1),
              })
              .strict(),
            z
              .object({
                status: z.literal('unpriced'),
                priceVersionId: z.string().min(1).nullable(),
              })
              .strict(),
          ]),
        })
        .strict(),
    ]),
  })
  .strict();
export type ShadowUsageReconciliation = z.infer<typeof shadowUsageReconciliationSchema>;
export interface ShadowReceiptReader {
  readonly authority: ShadowReceiptAuthority;
  readonly recoveryOwnerAccountId?: string;
  readOriginal(
    key: string,
    model: string,
    signal?: AbortSignal,
    lineage?: ShadowRecoveryLineage,
  ): Promise<ShadowUsageReconciliation>;
}
export function sameReceiptAuthority(
  a: ShadowReceiptAuthority,
  b: ShadowReceiptAuthority,
): boolean {
  return (
    a.applicationId === b.applicationId &&
    a.credentialId === b.credentialId &&
    a.environment === b.environment &&
    a.delegatedUserId === b.delegatedUserId
  );
}

export function createJevReceiptReader(
  client: Pick<OxyInferenceClient, 'getGenerationRecordByIdempotencyKey'>,
  input: ShadowReceiptAuthority,
): ShadowReceiptReader {
  const parsed = shadowReceiptAuthoritySchema.parse(input);
  if (parsed.recovery) Object.freeze(parsed.recovery);
  const authority = Object.freeze(parsed);
  return {
    authority,
    async readOriginal(key, model, signal, lineage) {
      // Exactly one read; failures/404 propagate, leaving the original claim intact.
      const record = await client.getGenerationRecordByIdempotencyKey(key, {
        signal,
        ...(authority.delegatedUserId === undefined
          ? {}
          : { delegatedUserId: authority.delegatedUserId }),
      });
      if (!sameReceiptAuthority(authority, record) || record.resolvedModelReference !== model) {
        throw new Error('Recovered usage does not match the original authority and model');
      }
      if (
        lineage &&
        (lineage.idempotencyKey !== key ||
          lineage.model !== model ||
          record.servingProvider !== lineage.provider ||
          (record.schemaVersion === 1
            ? record.priceSnapshot.priceVersionId
            : record.tariff.priceVersionId) !== lineage.priceVersionId)
      ) {
        throw new Error('Recovered usage differs from original route metadata');
      }
      // Public generation records do not attest deployment/policy or the source approval hash.
      return shadowUsageReconciliationSchema.parse({
        status: 'reconciled_result_missing',
        requestId: record.requestId,
        authority,
        model,
        provider: record.servingProvider,
        outcome: record.outcome,
        usageSource: record.usageSource,
        units: record.units,
        settledAt: record.settledAt,
        providerCost: 'unknown',
        economics:
          record.schemaVersion === 1
            ? {
                kind: 'customer_charge',
                receiptId: record.receiptId,
                amount: record.billedAmount,
                currency: record.currency,
                priceVersionId: record.priceSnapshot.priceVersionId,
                platformFeeOnly: record.platformFeeOnly,
              }
            : {
                kind: 'internal_usage',
                customerCharge: record.customerCharge.status,
                tariff: record.tariff,
              },
      });
    },
  };
}
