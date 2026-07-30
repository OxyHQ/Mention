/**
 * Test fixtures for the browser release gate.
 *
 * The `candidate` fixture does two things every flow needs:
 *
 *  1. Serves the candidate deployment's bytes AT the production origin. The
 *     browser's document URL stays `https://mention.earth`, so the page is
 *     subject to the real CORS contract, the real CSP and the real per-origin
 *     storage — while the HTML, the Expo chunks and every other same-origin
 *     asset come from the immutable Pages deployment under test. See
 *     `environment.ts` for why running the browser at the preview origin
 *     directly cannot work.
 *
 *  2. Records script errors, so a flow can assert that a page booted cleanly
 *     rather than merely finishing.
 */

import { test as base, expect } from '@playwright/test';
import { APP_ORIGIN, CANDIDATE_ORIGIN } from './environment';
import { withTransientTransportRetry } from './transientNetwork';

/**
 * Retry budget for a candidate fetch whose connection died. Three retries on a
 * short ramp: the Pages resets this defends against are per-connection, so a
 * fresh one either works at once or the origin is genuinely broken. Worst case
 * this adds 2.5s of waiting to a single asset, against a 90s per-test budget.
 */
const CANDIDATE_RETRY_DELAYS_MS = [250, 750, 1500];

/**
 * Headers describing how the body was framed on the wire. `route.fetch()` hands
 * back an already-decoded body, so replaying these would leave the browser
 * trying to gunzip plain bytes (or trusting a length that no longer holds) and
 * failing the resource.
 */
const WIRE_FRAMING_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding']);

/** Path prefix Expo emits every hashed JavaScript bundle and route chunk under. */
const CANDIDATE_SCRIPT_PREFIX = '/_expo/static/js/';

/**
 * `WelcomeModalGate` shows a viewport-covering first-visit modal to anonymous
 * web visitors 300ms after the app reports ready, and records the dismissal in
 * `localStorage` under this key. Left alone it would land on top of every flow
 * at a moment nothing can wait on, so the gate browses as a RETURNING anonymous
 * visitor instead. That is a deliberate narrowing: the first-visit modal itself
 * is not covered here.
 */
const WELCOME_MODAL_SEEN_KEY = 'welcome_modal_seen';

export interface CandidateBuild {
  /** Every app-origin path answered from the candidate deployment, in request order. */
  readonly servedPaths: string[];
  /** Uncaught page exceptions and `console.error` output, in emission order. */
  readonly scriptErrors: string[];
}

export const test = base.extend<{ candidate: CandidateBuild }>({
  candidate: async ({ context, page }, use) => {
    const servedPaths: string[] = [];
    const scriptErrors: string[] = [];

    await context.addInitScript((key: string) => {
      window.localStorage.setItem(key, 'true');
    }, WELCOME_MODAL_SEEN_KEY);

    // Matching on the parsed origin rather than a glob keeps this exact: only
    // the app's own origin is rerouted. Calls to api.mention.earth and the media
    // CDN go to the real network untouched, which is the entire point.
    await context.route(
      (url) => url.origin === APP_ORIGIN,
      async (route) => {
        const requested = new URL(route.request().url());
        // Reading the body inside the retried attempt keeps a connection that
        // dies mid-transfer on the same footing as one that never opened. Only
        // the transport is retried — see `transientNetwork.ts` for why that
        // cannot turn a broken build into a green gate.
        const served = await withTransientTransportRetry(
          async () => {
            const response = await route.fetch({
              url: `${CANDIDATE_ORIGIN}${requested.pathname}${requested.search}`,
              maxRedirects: 0,
            });
            return {
              status: response.status(),
              headers: response.headers(),
              body: await response.body(),
            };
          },
          {
            retryDelaysMs: CANDIDATE_RETRY_DELAYS_MS,
            // Announced rather than silent: an origin resetting often enough to
            // need this is worth seeing in the step log even when every retry
            // succeeds, because otherwise a degrading deployment reads as green.
            onRetry: (error, attemptsRemaining) => {
              console.warn(
                `[candidate] ${requested.pathname}: ${error.message.split('\n')[0]} — retrying (${attemptsRemaining} left)`,
              );
            },
          },
        );
        const headers = Object.fromEntries(
          Object.entries(served.headers).filter(([name]) => !WIRE_FRAMING_HEADERS.has(name)),
        );
        servedPaths.push(requested.pathname);
        await route.fulfill({
          status: served.status,
          headers,
          body: served.body,
        });
      },
    );

    page.on('pageerror', (error) => {
      scriptErrors.push(`uncaught ${error.name}: ${error.message}`);
    });
    page.on('console', (message) => {
      // Chromium synthesises argument-less `error` entries for things that are
      // network facts rather than script faults — "Failed to load resource: the
      // server responded with a status of 401", CSP refusals. An anonymous
      // visitor legitimately collects 401s from private endpoints (AGENTS.md:
      // "A 401 must fail quietly"), and which ones appear varies run to run, so
      // counting them would make this gate flake without ever finding a bug.
      // Anything raised from application code goes through `console.error(...)`
      // and therefore carries at least one argument; the synthesised entries
      // carry none. That is the discriminator, verified in Chromium 151.
      if (message.type() === 'error' && message.args().length > 0) {
        scriptErrors.push(`console.error: ${message.text()}`);
      }
    });

    await use({ servedPaths, scriptErrors });

    // A page goes on fetching assets after the last assertion, so handlers are
    // still in flight when the test ends and Playwright disposes their request
    // context — which surfaces as a spurious "Response has been disposed"
    // failure on an otherwise green test. Draining the routes first is the
    // supported way to close that race rather than letting it flake.
    await context.unrouteAll({ behavior: 'ignoreErrors' });

    // Vacuity floor. Every way the routing above can silently stop working — a
    // preview that 404s, an origin that no longer matches, a redirect that lands
    // the page somewhere else — otherwise reads as a green run against whatever
    // production happens to be serving. A flow that never executed a chunk from
    // the candidate deployment has not tested the release.
    expect(
      servedPaths.filter((path) => path.startsWith(CANDIDATE_SCRIPT_PREFIX)),
      `the page must execute JavaScript served from ${CANDIDATE_ORIGIN}`,
    ).not.toHaveLength(0);
  },
});

export { expect };
