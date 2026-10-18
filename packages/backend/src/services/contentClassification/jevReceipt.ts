import { z } from 'zod';
import type { Kaana } from '@kaana.ai/sdk' with { 'resolution-mode': 'import' };

const decimal = z.string().regex(/^\d+(?:\.\d+)?$/);
const currency = z.string().regex(/^[A-Z]{3}$/);

/**
 * Storage projection of a generation record recovered by idempotency key,
 * deliberately separate from answers. The SDK has validated the record against
 * `@kaana.ai/contracts`; this is what Mention keeps of it.
 */
export const shadowUsageReconciliationSchema = z
  .object({
    status: z.literal('reconciled_result_missing'),
    requestId: z.string().min(1),
    /** The model that served the original request. */
    model: z.string().min(1),
    /** Whose request it was, as Oxy attributed it; Kaana reads only the caller's own. */
    attribution: z
      .object({
        applicationId: z.string().min(1),
        credentialId: z.string().min(1),
        environment: z.enum(['development', 'staging', 'production']),
      })
      .strict(),
    outcome: z.enum(['completed', 'partial', 'failed', 'cancelled']),
    usageSource: z.enum(['provider_reported', 'oxy_measured', 'estimated']),
    units: z
      .array(z.object({ unit: z.string().min(1), quantity: z.number().min(0) }).strict())
      .refine((units) => new Set(units.map((unit) => unit.unit)).size === units.length),
    settledAt: z.string().datetime(),
    // Provider invoiced cost is not part of either generation-record variant.
    providerCost: z.literal('unknown'),
    economics: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('customer_charge'),
          receiptId: z.string().min(1),
          amount: decimal,
          currency,
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
                amount: decimal,
                currency,
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
  readOriginal(key: string, signal?: AbortSignal): Promise<ShadowUsageReconciliation>;
}

export function createJevReceiptReader(client: {
  readonly generations: Pick<Kaana['generations'], 'getByIdempotencyKey'>;
}): ShadowReceiptReader {
  return {
    async readOriginal(key, signal) {
      // Exactly one read; failures/404 propagate, leaving the original claim intact.
      const record = await client.generations.getByIdempotencyKey(key, { signal });
      return shadowUsageReconciliationSchema.parse({
        status: 'reconciled_result_missing',
        requestId: record.requestId,
        model: record.model,
        attribution: {
          applicationId: record.applicationId,
          credentialId: record.credentialId,
          environment: record.environment,
        },
        outcome: record.outcome,
        usageSource: record.usageSource,
        units: record.units,
        settledAt: record.settledAt,
        providerCost: 'unknown',
        economics:
          record.kind === 'charge'
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
