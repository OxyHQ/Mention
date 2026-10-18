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
