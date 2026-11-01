import type { Page } from '@playwright/test';
import { APP_ORIGIN } from '../environment';
import { expect, test } from '../fixtures';
import { installNotificationFixture, selectedText, user } from '../notificationFixture';

const userA = user.id;
const userB = 'remote-switch-viewer';
const expiresAt = new Date(Date.now() + 7_200_000).toISOString();
function token(id: string) {
  return [
    Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url'),
    Buffer.from(
      JSON.stringify({
        sub: id,
        userId: id,
        sessionId: id === userA ? 'notification-fixture' : 'fixture-b',
        exp: Math.floor(Date.now() / 1000) + 7200,
      }),
    ).toString('base64url'),
    'fixture',
  ].join('.');
}
function profile(id: string) {
  return {
    id,
    username: id,
    kind: 'personal',
    name: { displayName: id },
    privacy: { isPrivate: false },
    counts: { followers: 0, following: 0, posts: 0 },
    locale: 'en',
  };
}

async function installSwitchingFixture(page: Page) {
  const context = page.context();
  await context.addInitScript(() => localStorage.setItem('welcome_modal_seen', 'true'));
  await context.routeWebSocket('**/*', (socket) => socket.close());
  await installNotificationFixture(context, undefined, true);
  let remote: string | null = userA;
  let revision = 1;
  let stateCalls = 0;
  const headers = {
    'access-control-allow-origin': APP_ORIGIN,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': '*',
  };
  await page.route('**/auth/signin/email/start', (route) => {
    if (route.request().method() === 'OPTIONS') return route.fallback();
    return route.fulfill({
      headers,
      json: {
        requestId: 'fixture-request',
        requestSecret: 'a'.repeat(43),
        expiresAt: Date.now() + 60_000,
      },
    });
  });
  await page.route('**/auth/signin/email/confirm', (route) => {
    if (route.request().method() === 'OPTIONS') return route.fallback();
    if (!remote) return route.abort();
    return route.fulfill({
      headers,
      json: {
        sessionId: remote === userA ? 'notification-fixture' : 'fixture-b',
        deviceId: 'fixture-device',
        deviceSecret: 'fixture-only',
        expiresAt,
        accessToken: token(remote),
        user: profile(remote),
      },
    });
  });
  const deviceSync = () => ({
    state: {
      deviceId: 'fixture-device',
      accounts: remote
        ? [
            { accountId: userA, sessionId: 'notification-fixture', authuser: 0 },
            { accountId: userB, sessionId: 'fixture-b', authuser: 1 },
          ]
        : [],
      activeAccountId: remote,
      revision,
      updatedAt: Date.now(),
    },
    activeToken: remote ? { accessToken: token(remote), expiresAt } : null,
  });
  await page.route('**/session/device/state', (route) => {
    stateCalls++;
    return route.fulfill({ headers, json: deviceSync() });
  });
  for (const action of ['add', 'switch']) {
    await page.route(`**/session/device/${action}`, (route) => {
      if (route.request().method() === 'OPTIONS') return route.fallback();
      return route.fulfill({ headers, json: deviceSync() });
    });
  }
  await page.route('**/session/user/**', (route) =>
    remote ? route.fulfill({ headers, json: profile(remote) }) : route.abort(),
  );
  await page.route('**/users/by-ids**', (route) =>
    route.fulfill({ headers, json: [profile(userA), profile(userB)] }),
  );
  await page.route('**/users/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (
      !remote ||
      (path !== '/users/me' && path !== `/users/${userA}` && path !== `/users/${userB}`)
    )
      return route.fallback();
    return route.fulfill({ headers, json: profile(remote) });
  });
  await page.route('**/notifications/unread-count', (route) =>
    route.fulfill({ headers, json: { count: 20 } }),
  );
  await page.route('**/notifications?*', (route) => {
    if (new URL(route.request().url()).origin === APP_ORIGIN || remote === userA)
      return route.fallback();
    return route.fulfill({
      headers,
      json: { notifications: [], unreadCount: 0, hasMore: false, limit: 20 },
    });
  });
  return {
    headers,
    viewer: () => remote,
    async changeTo(next: string | null) {
      const before = stateCalls;
      const previous = remote;
      remote = next;
      revision++;
      if (!previous && next) {
        await page.getByRole('button', { name: 'Sign in with Oxy' }).click();
        await page.getByTestId('signin-identifier').fill(next);
        await page.getByTestId('signin-identifier-continue').click();
        const signIn = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/auth/signin/email/confirm' &&
            response.request().method() === 'POST',
        );
        await page.getByTestId('signin-code-0').fill('123456');
        expect((await signIn).ok()).toBe(true);
        await expect(page.getByText(next, { exact: true }).first()).toBeVisible();
        return;
      }
      await page.evaluate(() => {
        const channel = new BroadcastChannel('oxy.session');
        channel.postMessage({ type: 'commit', at: Date.now() });
        channel.close();
      });
      await expect.poll(() => stateCalls).toBeGreaterThan(before);
      if (next) await expect(page.getByText(next, { exact: true }).first()).toBeVisible();
      else await expect(page.getByText(selectedText, { exact: true })).toHaveCount(0);
    },
  };
}

test('control: the switching fixture loads the initial inbox', async ({ page, candidate }) => {
  const fixture = await installSwitchingFixture(page);
  page.on('console', (message) => { if (message.type() === 'error') console.log('BROWSER ERROR:', message.text()); });
  page.on('pageerror', (error) => console.log('BROWSER EXCEPTION:', error.stack));
  await page.goto('/notifications');
  try {
    await expect(page.getByText(selectedText, { exact: true })).toBeVisible();
    await fixture.changeTo(userB);
    await fixture.changeTo(userA);
    await fixture.changeTo(null);
    await fixture.changeTo(userA);
  } finally {
    console.log('RECORDED ERRORS:', JSON.stringify(candidate.scriptErrors));
    console.log('INBOX EXCEPTION:', await page.evaluate(() => document.documentElement.dataset.notificationControlError ?? 'none'));
  }
});
