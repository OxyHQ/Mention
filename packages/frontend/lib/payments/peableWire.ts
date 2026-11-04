// The Peable local harness's wire (ADR 0014: snake_case, base-unit strings),
// parsed into what Mention's checkout shows. No transport: tests and the
// configuration warmup load this without the payer SDK.

/** A Peable method this checkout can show, and why it cannot be taken when it cannot. */
export interface CheckoutPaymentMethod {
  id: 'card' | 'bank' | 'installments' | 'faircoin';
  available: boolean;
  reason?: string;
}

/** A Peable base-unit amount (a canonical integer string) as a safe integer, or `null`. */
export function parseBaseUnits(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const amount = Number(value);
  return Number.isSafeInteger(amount) ? amount : null;
}

const PAYMENT_METHOD_TYPES: readonly CheckoutPaymentMethod['id'][] = [
  'card',
  'bank',
  'installments',
  'faircoin',
];

/**
 * The local harness's `payment_methods` (`{ type, available, unavailable_reason }`),
 * one entry per method type. Anything else is refused rather than partially shown.
 */
export function parsePaymentMethods(value: unknown): CheckoutPaymentMethod[] {
  if (!Array.isArray(value) || value.length !== PAYMENT_METHOD_TYPES.length)
    throw new Error('Payment availability is unavailable.');
  const seen = new Set<string>();
  return value.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !('type' in entry) ||
      typeof entry.type !== 'string' ||
      !(PAYMENT_METHOD_TYPES as readonly string[]).includes(entry.type) ||
      seen.has(entry.type) ||
      !('available' in entry) ||
      typeof entry.available !== 'boolean' ||
      !('unavailable_reason' in entry) ||
      (entry.unavailable_reason !== null &&
        (typeof entry.unavailable_reason !== 'string' || entry.unavailable_reason.length > 200))
    )
      throw new Error('Payment availability is unavailable.');
    seen.add(entry.type);
    return {
      id: entry.type as CheckoutPaymentMethod['id'],
      available: entry.available,
      ...(typeof entry.unavailable_reason === 'string' ? { reason: entry.unavailable_reason } : {}),
    };
  });
}
