import { contractTest as test, expect } from '../fixtures';
import { API_ORIGIN, APP_ORIGIN } from '../environment';

const isScreenChunk = (url: URL) =>
  url.origin === APP_ORIGIN && /\/screenComponents-.*\.js$/.test(url.pathname);

test.beforeEach(async ({ page, context }) => {
  await page.route(
    (url) => url.origin === API_ORIGIN && url.pathname === '/feed/mtn',
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(
    (url) => url.hostname === 'api.oxy.so',
    (route) => {
      if (new URL(route.request().url()).pathname.startsWith('/auth/oauth/client/')) {
        return route.fulfill({
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
        });
      }
      return route.fulfill({ status: 401, json: { error: 'synthetic' } });
    },
  );
  await context.routeWebSocket(
    (url) => url.hostname === 'api.oxy.so',
    (socket) => socket.close(),
  );
});

test('loads the account screen on first use and shows progress while the chunk is delayed', async ({
  page,
  candidate,
}) => {
  let release: (() => void) | undefined;
  let requested = false;
  page.on('request', (request) => {
    if (isScreenChunk(new URL(request.url()))) requested = true;
  });
  try {
    await page.goto('/');
    await expect(page.getByTestId('mention-shell-panels-main-surface-bounds')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(requested).toBe(false);
    await page.route(isScreenChunk, async (route) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fallback();
    });
    await page
      .getByRole('button', { name: /sign in/i })
      .first()
      .click();
    await expect.poll(() => requested).toBe(true);
    await expect(page.getByRole('progressbar', { name: 'Loading...' })).toBeVisible();
    release?.();
    await expect(page.getByText('Email or username', { exact: true })).toBeVisible();
    expect(candidate.scriptErrors.filter((error) => error.startsWith('uncaught'))).toEqual([]);
  } finally {
    release?.();
  }
});

test('retries a failed screen download and opens sign-in', async ({ page, candidate }) => {
  let attempts = 0;
  await page.route(isScreenChunk, async (route) => {
    attempts += 1;
    if (attempts === 1) await route.abort('failed');
    else await route.fallback();
  });
  await page.goto('/');
  await expect(page.getByTestId('mention-shell-panels-main-surface-bounds')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page
    .getByRole('button', { name: /sign in/i })
    .first()
    .click();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Email or username', { exact: true })).toBeVisible();
  expect(attempts).toBeGreaterThanOrEqual(2);
  expect(candidate.scriptErrors.filter((error) => error.startsWith('uncaught'))).toEqual([]);
});

test('closing during a delayed download does not reopen the account dialog', async ({
  page,
  candidate,
}) => {
  expect(candidate.servedPaths).toEqual([]);
  let release: (() => void) | undefined;
  let requested = false;
  await page.route(isScreenChunk, async (route) => {
    requested = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fallback();
  });
  try {
    await page.goto('/');
    await expect(page.getByTestId('mention-shell-panels-main-surface-bounds')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page
      .getByRole('button', { name: /sign in/i })
      .first()
      .click();
    await expect.poll(() => requested).toBe(true);
    await expect(page.getByRole('progressbar', { name: 'Loading...' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const response = page.waitForResponse(
      (item) => isScreenChunk(new URL(item.url())) && item.ok(),
    );
    release?.();
    await response;
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally {
    release?.();
  }
});
