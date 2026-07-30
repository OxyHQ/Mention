/**
 * Bounded retry for transport faults against the candidate deployment.
 *
 * `fixtures.ts` re-issues every app-origin request at the Cloudflare Pages
 * deployment under test. That deployment is minutes old when the gate runs, and
 * Cloudflare intermittently resets connections on it — observed on 2026-07-30
 * (run 30563300446) as four `route.fetch: read ECONNRESET` failures, all against
 * `*.mention-frontend.pages.dev`, none against the API. Successful fetches
 * interleaved with the resets in the same seconds, so a fresh connection almost
 * always works; what does NOT work is Playwright's test-level retry, because
 * re-running a whole flow re-rolls the dice on every asset it loads. That run
 * failed two flows and blocked a production promotion for a reason that had
 * nothing to do with the build being gated.
 *
 * The retry is deliberately narrow. A gate that swallows upstream failures is
 * worse than one that flakes, because a genuinely broken release then reports
 * green.
 */

/**
 * Faults that mean the CONNECTION died, never that the origin answered badly.
 *
 * Two properties qualify a fault for this list, and both are required:
 *
 *  1. It cannot be produced by a well-formed HTTP response. Everything the gate
 *     exists to catch — a missing chunk, a bad build, a broken deploy — arrives
 *     as a *successful* HTTP exchange carrying a 404, a 500 or the wrong bytes,
 *     and is therefore untouched by anything here. That is what makes retrying
 *     safe rather than a way to launder a real failure into a pass.
 *  2. It fails FAST. A fault that takes a timeout to surface would turn a
 *     bounded retry into a multiple of that timeout and blow the per-test budget
 *     instead — trading a precisely named error for an unreadable "test timed
 *     out". `ETIMEDOUT` is excluded for exactly this reason, deliberately, and
 *     should stay excluded.
 *
 * Matching is on the message because that is where Playwright puts the code:
 * verified against Playwright 1.62, a real reset socket surfaces as a plain
 * `Error` reading `route.fetch: read ECONNRESET` followed by its call log.
 */
const TRANSIENT_TRANSPORT_FAULTS = ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'socket hang up'];

/** True when `error` is a transport fault worth another connection. */
export function isTransientTransportFault(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_TRANSPORT_FAULTS.some((fault) => message.includes(fault));
}

export interface TransientRetryOptions {
  /**
   * Delay before each retry. The LENGTH is the retry budget: `[250, 750]` means
   * three attempts in total, and an empty array disables retrying entirely.
   * Short on purpose — the resets this exists for are per-connection rather than
   * an outage window, so a new connection succeeds immediately or not at all.
   */
  readonly retryDelaysMs: readonly number[];
  /** Called before each retry, so a retried run is visible rather than silent. */
  readonly onRetry?: (error: Error, attemptsRemaining: number) => void;
}

/**
 * Run `attempt`, retrying only {@link isTransientTransportFault} failures and
 * only within `retryDelaysMs`.
 *
 * Anything else — and a transport fault that outlives the budget — is rethrown
 * UNCHANGED, so a candidate origin that is genuinely unreachable still fails the
 * gate with the same error it reports today.
 */
export async function withTransientTransportRetry<T>(
  attempt: () => Promise<T>,
  { retryDelaysMs, onRetry }: TransientRetryOptions,
): Promise<T> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (retry >= retryDelaysMs.length || !isTransientTransportFault(error)) {
        throw error;
      }
      onRetry?.(error instanceof Error ? error : new Error(String(error)), retryDelaysMs.length - retry);
      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[retry]));
    }
  }
}
