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
 * Refusals decided before any provider ran: authentication, Oxy's grant, the
 * request's own validity, or no route to run it on. Nothing was spent.
 */
const REFUSED_CODES: ReadonlySet<string> = new Set([
  'invalid_request',
  'authentication_failed',
  'permission_denied',
  'insufficient_scope',
  'model_not_found',
  'unsupported_modality',
  'request_too_large',
  'idempotency_conflict',
  'policy_violation',
  'commercial_permission_denied',
  'no_route_available',
  'service_unavailable',
]);

/**
 * Whether a failed Kaana call was refused before it ran (`exhausted` for the
 * day, or `refused` outright), or `undefined` when it may have run and its
 * cost is unknown: a provider error, a timeout, a dropped connection, a
 * response outside the contract, or anything after output began.
 */
export async function kaanaRefusalOf(error: unknown): Promise<'exhausted' | 'refused' | undefined> {
  const { KaanaError } = await import('@kaana.ai/sdk');
  if (!(error instanceof KaanaError) || error.status === null || error.afterOutput) {
    return undefined;
  }
  if (EXHAUSTED_CODES.has(error.code)) return 'exhausted';
  return REFUSED_CODES.has(error.code) ? 'refused' : undefined;
}
