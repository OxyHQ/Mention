import type { Kaana } from '@kaana.ai/sdk' with { 'resolution-mode': 'import' };
import { getServiceOxyClient } from './oxyHelpers';

let kaana: Promise<Kaana> | undefined;

/**
 * The one Kaana client. `@kaana.ai/sdk` is ESM-only and this package emits
 * CommonJS, so it is loaded with a dynamic import, as `utils/clarityClient.ts`
 * does. The credential is a service token minted for the `kaana.ai` audience;
 * Kaana refuses an `oxy-api` one.
 */
export function kaanaClient(): Promise<Kaana> {
  kaana ??= import('@kaana.ai/sdk').then(
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
 * grant, or no route to run it on. Nothing was spent, and the next post would
 * be refused the same way.
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
 * the same post the same way every time. Nothing was spent.
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

export type KaanaRefusal = 'exhausted' | 'refused' | 'rejected';

/**
 * Whether a failed Kaana call was refused before it ran (`exhausted` for the
 * day, `refused` for the whole lane, or `rejected` for this request alone), or
 * `undefined` when it may have run and its cost is unknown: a provider error, a
 * gateway error, a timeout, a dropped connection, a response outside the
 * contract, or anything after output began.
 */
export async function kaanaRefusalOf(error: unknown): Promise<KaanaRefusal | undefined> {
  const { KaanaError } = await import('@kaana.ai/sdk');
  if (
    !(error instanceof KaanaError) ||
    error.status === null ||
    error.afterOutput ||
    AFTER_DISPATCH_STATUSES.has(error.status)
  ) {
    return undefined;
  }
  if (EXHAUSTED_CODES.has(error.code)) return 'exhausted';
  if (REJECTED_CODES.has(error.code)) return 'rejected';
  return REFUSED_CODES.has(error.code) ? 'refused' : undefined;
}

/**
 * What an operator log may say about a failed Kaana call: the public code,
 * status and Kaana's request id, or the kind of failure. Never a Kaana message
 * or body.
 */
export async function kaanaFailureFacts(error: unknown): Promise<Record<string, unknown>> {
  const { KaanaError } = await import('@kaana.ai/sdk');
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
  const facts: Record<string, unknown> = {
    errorType: error instanceof Error ? error.name : typeof error,
    ...(error instanceof Error ? { error: error.message.slice(0, 200) } : {}),
  };
  if (error && typeof error === 'object' && 'requestId' in error) {
    facts.kaanaRequestId = (error as { requestId: unknown }).requestId;
  }
  if (error && typeof error === 'object' && 'timedOut' in error) {
    facts.timedOut = (error as { timedOut: unknown }).timedOut;
  }
  return facts;
}
