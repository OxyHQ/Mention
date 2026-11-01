import { contractTest as test, expect } from '../fixtures';
import { API_ORIGIN } from '../environment';

test('a route chunk failure caught by a boundary reloads and recovers', async ({
  page,
  context,
  candidate,
}) => {
  await page.route(
    (url) => url.origin === API_ORIGIN && url.pathname === '/feed/mtn',
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(
    (url) => url.hostname === 'api.oxy.so',
    (route) =>
      new URL(route.request().url()).pathname.startsWith('/auth/oauth/client/')
        ? route.fulfill({
            json: {
              application: {
                id: 'synthetic-client',
                name: 'Synthetic Mention',
                type: 'first_party',
                isOfficial: true,
                isInternal: true,
                scopes: [],
              },
            },
          })
        : route.fulfill({ status: 401, json: { error: 'synthetic' } }),
  );
  await context.routeWebSocket(
    (url) => url.hostname === 'api.oxy.so',
    (socket) => socket.close(),
  );
  expect(candidate.servedPaths).toEqual([]);
  let attempts = 0;
  await page.route(/\/FeedBuilder-[0-9a-f]{32}\.js$/, async (route) => {
    attempts++;
    if (attempts === 1) await route.abort('failed');
    else await route.fallback();
  });
  await page.goto('/feeds/new');
  await expect(page.getByText('Sign in to build a feed', { exact: true })).toBeVisible();
  expect(attempts).toBeGreaterThanOrEqual(2);
});
