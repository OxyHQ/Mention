/**
 * Pre-flight probe. Runs once, before any browser flow.
 *
 * The flows browse at the production origin against the LIVE backend — that is
 * deliberate and documented in the README — which means a backend outage makes
 * every one of them fail. Without this file it fails as "cold boot did not paint
 * feed rows", which reads as *your candidate is broken* and points the person
 * being blocked at their own diff. The first time someone is stopped from
 * promoting an unrelated frontend fix by a message that blames their build is
 * the day this gate gets switched off.
 *
 * So: fail closed, because with the API down there is genuinely no way to tell a
 * safe candidate from a broken one — but say which side is at fault, in terms an
 * operator can act on without opening a trace.
 */

import { request } from '@playwright/test';
import { API_ORIGIN, APP_ORIGIN, CANDIDATE_ORIGIN } from './environment';

/** Rate limiting: the API is up but will not serve this caller. */
const TOO_MANY_REQUESTS = 429;

/** Generous: this only has to separate "unavailable" from "slow". */
const PROBE_TIMEOUT_MS = 20_000;

/**
 * A dropped connection must not read as an outage — that false positive blocks a
 * release just as effectively as a real one. This bounds transient network
 * flake in a network probe; it is not a wait on a UI condition.
 */
const PROBE_ATTEMPTS = 3;
const PROBE_RETRY_DELAY_MS = 2_000;

interface ProbeResult {
  ok: boolean;
  detail: string;
  headers: Record<string, string>;
}

async function probe(url: string, headers: Record<string, string>): Promise<ProbeResult> {
  const context = await request.newContext({ timeout: PROBE_TIMEOUT_MS });
  try {
    let lastDetail = '';
    for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
      try {
        const response = await context.get(url, { headers, failOnStatusCode: false });
        const status = response.status();
        if (status !== TOO_MANY_REQUESTS && status < 500) {
          return { ok: true, detail: `HTTP ${status}`, headers: response.headers() };
        }
        // 429 is the likeliest way this gate meets an unusable backend, and it
        // is the most misleading: the API is healthy, it just will not serve
        // THIS caller, so the browser boots into an empty feed and every flow
        // fails as though the candidate never rendered. Observed for real —
        // repeated gate runs from one address exhausted a 600-per-900s budget
        // and produced exactly that. It belongs on the inconclusive side.
        const retryAfter = response.headers()['retry-after'];
        lastDetail =
          `HTTP ${status} ${response.statusText()}` +
          (retryAfter ? ` (retry-after: ${retryAfter}s)` : '');
        if (status === TOO_MANY_REQUESTS) break;
      } catch (error) {
        lastDetail = error instanceof Error ? error.message.split('\n')[0] : String(error);
      }
      if (attempt < PROBE_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, PROBE_RETRY_DELAY_MS));
      }
    }
    return { ok: false, detail: lastDetail, headers: {} };
  } finally {
    await context.dispose();
  }
}

/** Raised when the gate cannot reach a verdict, as opposed to reaching a bad one. */
function inconclusive(subject: string, lines: string[]): never {
  throw new Error(
    [
      '',
      `GATE COULD NOT EVALUATE THIS CANDIDATE — ${subject}.`,
      '',
      ...lines.map((line) => `  ${line}`),
      '',
      'This is NOT a failure of the candidate build, and nothing has been promoted.',
      'The browser flows run against the live backend by design, so with it',
      'unavailable they cannot tell a healthy candidate from a broken one.',
      'Re-run this job once the dependency above is healthy.',
      '',
    ].join('\n'),
  );
}

export default async function preflight(): Promise<void> {
  const feedProbe = await probe(`${API_ORIGIN}/feed/mtn?descriptor=for_you&limit=1`, {
    Origin: APP_ORIGIN,
  });
  if (!feedProbe.ok) {
    inconclusive('the Mention backend is not serving this caller', [
      `probe:  GET ${API_ORIGIN}/feed/mtn?descriptor=for_you&limit=1`,
      `result: ${feedProbe.detail}`,
      `after:  ${PROBE_ATTEMPTS} attempts`,
    ]);
  }

  // The whole design rests on the API allowing exactly the production origin: it
  // is why the browser runs there and is served candidate bytes. If that header
  // ever changes, every flow fails with an empty feed and reads as a broken
  // build, which is the same misdirection this file exists to prevent.
  const allowedOrigin = feedProbe.headers['access-control-allow-origin'];
  if (allowedOrigin !== APP_ORIGIN) {
    inconclusive("the backend's CORS contract no longer matches the origin under test", [
      `expected: access-control-allow-origin: ${APP_ORIGIN}`,
      `received: access-control-allow-origin: ${allowedOrigin ?? '(absent)'}`,
      '',
      'The browser is parked on that origin precisely so the API will answer it.',
      'Until these agree the flows would boot into an empty shell and blame the build.',
    ]);
  }

  // A candidate origin that does not answer is an infrastructure problem too:
  // the preview deploy failed, expired, or the URL never reached this job.
  const candidateProbe = await probe(`${CANDIDATE_ORIGIN}/`, { Accept: 'text/html' });
  if (!candidateProbe.ok) {
    inconclusive('the candidate deployment is unreachable', [
      `probe:  GET ${CANDIDATE_ORIGIN}/`,
      `result: ${candidateProbe.detail}`,
      `after:  ${PROBE_ATTEMPTS} attempts`,
    ]);
  }
}
