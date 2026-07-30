/**
 * The gate's own transport retry — the one piece of this suite that can fail
 * silently in the dangerous direction.
 *
 * `fixtures.ts` retries a dead connection to the candidate deployment so a
 * Cloudflare Pages reset cannot block a release. Loosen that predicate and the
 * gate starts swallowing real failures: a broken build would report green and
 * promote itself. Nothing else in this suite would notice, because a swallowed
 * failure looks exactly like a passing one.
 *
 * So these run against a REAL socket reset driven through a REAL `route.fetch`,
 * not a hand-built `Error`. A matcher tested against a fake error proves only
 * that the fake matches itself — and the entire fix depends on recognising the
 * shape Playwright actually throws, which changed once already when the message
 * gained its call log. Everything here is localhost: no live origin, no network,
 * no dependence on the release under test.
 */

import http from 'node:http';
import { expect, test } from '@playwright/test';
import { isTransientTransportFault, withTransientTransportRetry } from '../transientNetwork';

/** No waiting: these flows assert the retry HAPPENS, not how long it pauses. */
const NO_DELAY_RETRIES = [0, 0, 0];

/**
 * Serves a marker page, but kills the first `resetsToServe` connections with a
 * TCP RST — `resetAndDestroy` rather than `destroy`, which is what makes the
 * client read ECONNRESET instead of a graceful close.
 */
function resettingServer(resetsToServe: number): { server: http.Server; requestCount: () => number } {
  let resets = 0;
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    if (resets < resetsToServe) {
      resets += 1;
      req.socket.resetAndDestroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><h1 id="marker">candidate</h1></body></html>');
  });
  return { server, requestCount: () => requests };
}

async function listenOnLoopback(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('probe server did not bind to a port');
  return `http://127.0.0.1:${address.port}`;
}

test('a reset connection is retried and the page still gets its bytes', async ({ context, page }) => {
  const { server, requestCount } = resettingServer(2);
  const origin = await listenOnLoopback(server);
  const retried: number[] = [];

  await context.route('**/*', async (route) => {
    const served = await withTransientTransportRetry(
      async () => {
        const response = await route.fetch({ url: `${origin}/`, maxRedirects: 0 });
        return { status: response.status(), body: await response.body() };
      },
      {
        retryDelaysMs: NO_DELAY_RETRIES,
        onRetry: (_error, attemptsRemaining) => retried.push(attemptsRemaining),
      },
    );
    await route.fulfill({
      status: served.status,
      headers: { 'content-type': 'text/html' },
      body: served.body,
    });
  });

  await page.goto(`${origin}/`);

  await expect(page.locator('#marker')).toHaveText('candidate');
  // The two resets were survived rather than avoided: three requests reached the
  // server for one navigation. Without this the flow would pass just as happily
  // against a server that never reset at all.
  expect(retried, 'the reset connections must have been retried').toHaveLength(2);
  expect(requestCount(), 'each retry must open a new request').toBe(3);

  await context.unrouteAll({ behavior: 'ignoreErrors' });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('a reset that outlives the budget still fails the gate', async ({ context, page }) => {
  // Every connection dies, i.e. the candidate origin is genuinely unreachable.
  const { server } = resettingServer(Number.MAX_SAFE_INTEGER);
  const origin = await listenOnLoopback(server);
  let surfaced: string | undefined;

  await context.route('**/*', async (route) => {
    try {
      await withTransientTransportRetry(
        async () => {
          const response = await route.fetch({ url: `${origin}/`, maxRedirects: 0 });
          return await response.body();
        },
        { retryDelaysMs: NO_DELAY_RETRIES },
      );
      surfaced = 'RESOLVED';
    } catch (error) {
      surfaced = error instanceof Error ? error.message : String(error);
    }
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: '<html></html>' });
  });

  await page.goto(`${origin}/`);

  // Rethrown unchanged, so an unreachable candidate reads in the report exactly
  // as it did before any of this existed.
  expect(surfaced, 'an exhausted retry must rethrow, never resolve').toContain('route.fetch');
  expect(surfaced).toContain('ECONNRESET');

  await context.unrouteAll({ behavior: 'ignoreErrors' });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('the predicate admits transport faults and refuses everything else', () => {
  for (const fault of ['read ECONNRESET', 'connect ECONNREFUSED 127.0.0.1:1', 'write EPIPE', 'socket hang up']) {
    expect(isTransientTransportFault(new Error(`route.fetch: ${fault}`)), fault).toBe(true);
  }

  // The failures this gate exists to find all arrive as well-formed HTTP or as
  // an assertion, and must never be retried away. `ETIMEDOUT` is in this list on
  // purpose — see `transientNetwork.ts`.
  for (const real of [
    'route.fetch: 404 Not Found',
    'expect(page).toHaveTitle(expected) failed',
    'Target page, context or browser has been closed',
    'route.fetch: connect ETIMEDOUT 10.0.0.1:443',
  ]) {
    expect(isTransientTransportFault(new Error(real)), real).toBe(false);
  }
});

test('an empty budget disables retrying without disabling the call', async () => {
  let calls = 0;
  await expect(
    withTransientTransportRetry(
      async () => {
        calls += 1;
        throw new Error('route.fetch: read ECONNRESET');
      },
      { retryDelaysMs: [] },
    ),
  ).rejects.toThrow('ECONNRESET');
  expect(calls, 'an empty budget still runs the first attempt, exactly once').toBe(1);
});
