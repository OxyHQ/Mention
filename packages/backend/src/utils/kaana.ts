import type { Kaana } from '@kaana.ai/sdk' with { 'resolution-mode': 'import' };
import { getServiceOxyClient } from './oxyHelpers';

type KaanaSdk = typeof import('@kaana.ai/sdk', { with: { 'resolution-mode': 'import' }});

let sdk: Promise<KaanaSdk> | undefined;
let kaana: Promise<Kaana> | undefined;

/**
 * `@kaana.ai/sdk` is ESM-only and this package emits CommonJS, so it is loaded
 * once with a dynamic import, as `utils/clarityClient.ts` does.
 */
function kaanaSdk(): Promise<KaanaSdk> {
  sdk ??= import('@kaana.ai/sdk');
  return sdk;
}

/**
 * The one Kaana client. The credential is a service token minted for the
 * `kaana.ai` audience; Kaana refuses an `oxy-api` one.
 */
export function kaanaClient(): Promise<Kaana> {
  kaana ??= kaanaSdk().then(
    ({ Kaana: Client }) =>
      new Client({
        credential: () => getServiceOxyClient().serviceTokenFor('kaana.ai'),
        // Resolved per call, not captured once, so the one client follows the
        // runtime's fetch (and a test's stub).
        fetch: (input, init) => fetch(input, init),
        // Never resend. Kaana already retries and fails over provider-side
        // before any output; a second send here would wait out a long
        // `retryAfterMs` inside a worker's deadline and blur the one-dispatch
        // accounting the shadow ledger keeps (docs/jev-shadow-evaluation.md).
        maxRetries: 0,
      }),
  );
  return kaana;
}

/** Test/lifecycle hook: the next {@link kaanaClient} call builds a new client. */
export function resetKaanaClient(): void {
  kaana = undefined;
}

/** Refusals that mean "no more today": Oxy's daily cap, quota or spend limits. */
const EXHAUSTED_CODES: ReadonlySet<string> = new Set([
  'rate_limited',
  'quota_exceeded',
  'insufficient_balance',
  'spending_limit_exceeded',
]);

/**
 * Refusals of the lane, decided before any provider ran: authentication, Oxy's
 * grant, or no route to run it on. Nothing was spent, and the next request
 * would be refused the same way.
 */
const REFUSED_CODES: ReadonlySet<string> = new Set([
  'authentication_failed',
  'permission_denied',
  'insufficient_scope',
  'model_not_found',
  'unsupported_modality',
  'policy_violation',
  'commercial_permission_denied',
  'no_route_available',
  'service_unavailable',
]);

/**
 * Refusals of THIS request, decided before any provider ran: Kaana would refuse
 * the same request the same way every time. Nothing was spent.
 */
const REJECTED_CODES: ReadonlySet<string> = new Set([
  'invalid_request',
  'request_too_large',
  'idempotency_conflict',
]);

/**
 * Gateway statuses: Cloudflare, in front of kaana.ai, answers an origin 502 or
 * 504 with its own page, which the SDK reads as a body-less
 * `service_unavailable`. Kaana answers 502 (`provider_error`) and 504
 * (`provider_timeout`) after a provider ran, so neither proves nothing ran.
 */
const AFTER_DISPATCH_STATUSES: ReadonlySet<number> = new Set([502, 504]);

/**
 * What a failed Kaana call means to Mention.
 *
 * - `kind`, for an API caller: Kaana's rate limit, Oxy's billing limits, or
 *   the inference dependency being unavailable (authentication, scope, policy,
 *   routing, provider, protocol and network failures).
 * - `refusal`, for a caller that accounts for spend: set when Kaana refused
 *   before any provider ran (`exhausted` for the day, `refused` for the whole
 *   lane, `rejected` for this request alone); absent when the call may have
 *   run and its cost is unknown (a provider or gateway error, a timeout, a
 *   dropped connection, a response outside the contract, anything after output
 *   began).
 */
export interface KaanaFailure {
  readonly kind: 'rate_limited' | 'billing' | 'unavailable';
  readonly refusal?: 'exhausted' | 'refused' | 'rejected';
}

function refusalOf(error: InstanceType<KaanaSdk['KaanaError']>): KaanaFailure['refusal'] {
  if (error.status === null || error.afterOutput || AFTER_DISPATCH_STATUSES.has(error.status)) {
    return undefined;
  }
  if (EXHAUSTED_CODES.has(error.code)) return 'exhausted';
  if (REJECTED_CODES.has(error.code)) return 'rejected';
  return REFUSED_CODES.has(error.code) ? 'refused' : undefined;
}

/**
 * Classify a failure from the Kaana SDK, or `undefined` when it did not come
 * from the SDK (a Mention bug stays a Mention bug).
 */
export async function classifyKaanaFailure(error: unknown): Promise<KaanaFailure | undefined> {
  const {
    KaanaError,
    KaanaRateLimitError,
    KaanaBillingError,
    KaanaConnectionError,
    KaanaProtocolError,
  } = await kaanaSdk();
  if (error instanceof KaanaError) {
    const kind =
      error instanceof KaanaRateLimitError
        ? 'rate_limited'
        : error instanceof KaanaBillingError
          ? 'billing'
          : 'unavailable';
    const refusal = refusalOf(error);
    return refusal === undefined ? { kind } : { kind, refusal };
  }
  if (error instanceof KaanaConnectionError || error instanceof KaanaProtocolError) {
    return { kind: 'unavailable' };
  }
  return undefined;
}

/**
 * What an operator log may say about a failed Kaana call: the public code,
 * status and Kaana's request id, or the kind of failure. Never a Kaana message
 * or body.
 */
export async function kaanaFailureFacts(error: unknown): Promise<Record<string, unknown>> {
  const { KaanaError, KaanaConnectionError, KaanaProtocolError } = await kaanaSdk();
  if (error instanceof KaanaError) {
    return {
      code: error.code,
      status: error.status,
      kaanaRequestId: error.requestId,
      retryable: error.retryable,
      afterOutput: error.afterOutput,
    };
  }
  // Not a Kaana answer: a timeout, a dropped connection or a response outside
  // the contract. Those messages are this process's own and carry no post.
  return {
    errorType: error instanceof Error ? error.name : typeof error,
    ...(error instanceof Error ? { error: error.message.slice(0, 200) } : {}),
    ...(error instanceof KaanaProtocolError ? { kaanaRequestId: error.requestId } : {}),
    ...(error instanceof KaanaConnectionError ? { timedOut: error.timedOut } : {}),
  };
}
