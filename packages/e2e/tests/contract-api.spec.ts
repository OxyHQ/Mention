import { test, expect } from '@playwright/test';
import { API_ORIGIN } from '../environment';
import { closeContractPages, installContractApi } from '../contractApi';

test('synthetic chrome is owned while unknown routes and writes cannot escape', async ({
  context,
  page,
}) => {
  const escaped: string[] = [];
  // A lower-priority sentinel stands in for the network. No request in this
  // self-test may reach it, including deliberate malformed/unknown contracts.
  await context.route(
    (url) => url.origin === API_ORIGIN,
    (route) => {
      escaped.push(route.request().url());
      return route.fulfill({ status: 500 });
    },
  );
  const escapedSockets: string[] = [];
  const socketOrigin = API_ORIGIN.replace(/^http/, 'ws');
  await context.routeWebSocket(
    (url) => url.host === new URL(API_ORIGIN).host,
    (socket) => {
      escapedSockets.push(socket.url());
      void socket.close();
    },
  );
  const unexpected = await installContractApi(context);
  await page.goto('data:text/html,<title>Contract boundary</title>');
  const read = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return response.json();
  }, `${API_ORIGIN}/lanes?ownerId=synthetic-owner`);
  expect(read).toEqual({ data: [] });
  for (const input of [
    { path: '/unknown-contract', method: 'GET' },
    { path: '/lanes', method: 'POST' },
  ]) {
    const failed = await page.evaluate(
      async ({ url, method }) => {
        try {
          await fetch(url, { method });
          return false;
        } catch {
          return true;
        }
      },
      { url: `${API_ORIGIN}${input.path}`, method: input.method },
    );
    expect(failed).toBe(true);
  }
  await page.evaluate(
    (url) =>
      new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(url);
        socket.onopen = () => {
          socket.send('must-not-leave-browser');
          socket.close();
          resolve();
        };
        socket.onerror = () => reject(new Error('Local fixture websocket did not open'));
      }),
    `${socketOrigin}/socket.io/?EIO=4&transport=websocket`,
  );
  await closeContractPages(context);
  expect(page.isClosed()).toBe(true);
  await context.unrouteAll({ behavior: 'wait' });
  expect(unexpected).toEqual(['GET /unknown-contract', 'POST /lanes']);
  expect(escapedSockets).toEqual([]);
  expect(escaped).toEqual([]);
});

test('live contexts retain their pages for the existing candidate teardown', async ({
  context,
  page,
}) => {
  await page.goto('data:text/html,<title>Live fixture ownership</title>');
  await closeContractPages(context);
  expect(page.isClosed()).toBe(false);
});
