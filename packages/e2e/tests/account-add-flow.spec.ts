import type { BrowserContext } from '@playwright/test';
import { APP_ORIGIN } from '../environment';
import { expect, test } from '../fixtures';

const viewer = {
  id: 'account-flow-fixture-user',
  username: 'account-flow-fixture',
  kind: 'personal',
  name: { displayName: 'Account fixture' },
  privacy: { isPrivate: false },
  counts: { followers: 0, following: 0, posts: 0 },
};

async function installSession(context: BrowserContext) {
  const expiresAt = new Date(Date.now() + 7_200_000).toISOString();
  const token = [
    Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url'),
    Buffer.from(
      JSON.stringify({
        sub: viewer.id,
        userId: viewer.id,
        exp: Math.floor(Date.now() / 1000) + 7200,
      }),
    ).toString('base64url'),
    'fixture',
  ].join('.');
  await context.addInitScript(
    ({ viewer, token, expiresAt }) => {
      localStorage.setItem(
        'oxy.auth.v1',
        JSON.stringify({
          sessionId: 'account-fixture',
          userId: viewer.id,
          deviceId: 'fixture',
          deviceSecret: 'fixture',
        }),
      );
      localStorage.setItem('oxy.auth.token.v1', JSON.stringify({ accessToken: token, expiresAt }));
    },
    { viewer, token, expiresAt },
  );

  await context.routeWebSocket(
    () => true,
    (socket) => void socket.close(),
  );
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === APP_ORIGIN || !['http:', 'https:'].includes(url.protocol))
      return route.fallback();
    const path = url.pathname;
    const method = request.method();
    const headers = {
      'access-control-allow-origin': APP_ORIGIN,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': '*',
    };
    const json = (body: unknown) => route.fulfill({ headers, json: body });
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (method === 'POST' && ['/telemetry/web', '/feed/mtn/interactions'].includes(path))
      return route.fulfill({ status: 204, headers });
    // Unrelated services are deliberately unavailable in this fixture. Abort
    // them locally rather than pretending that identity proofs or writes succeeded.
    const unrelated = new Set([
      'GET /',
      'POST /session/device/add',
      'GET /deck',
      'GET /users/me/graph',
      'GET /community-notes/availability',
      'POST /apps/assertions',
      'GET /privacy/blocked',
      'GET /privacy/restricted',
      'POST /stickers/resolve',
    ]);
    if (unrelated.has(`${method} ${path}`)) return route.abort('blockedbyclient');
    if (method !== 'GET' && !(method === 'POST' && path === '/session/device/token')) {
      return route.abort('blockedbyclient');
    }
    if (path.startsWith('/auth/oauth/client/'))
      return json({
        application: {
          id: 'fixture-app',
          name: 'Fixture',
          type: 'internal',
          isOfficial: true,
          isInternal: true,
          clientId: path.split('/').pop(),
          scopes: [],
        },
      });
    if (path === '/session/device/directory')
      return json({
        deviceId: 'fixture',
        revision: 1,
        activeContextId: 'fixture-context',
        updatedAt: Date.now(),
        principals: [
          {
            id: 'fixture-principal',
            userId: viewer.id,
            authuser: 0,
            user: viewer,
            contexts: [
              {
                id: 'fixture-context',
                accountId: viewer.id,
                kind: 'personal',
                relationship: 'self',
                account: viewer,
                onDevice: true,
                available: true,
                active: true,
                lastUsedAt: null,
              },
            ],
          },
        ],
      });
    if (path === '/session/device/token')
      return json({
        accessToken: token,
        expiresAt,
        userId: viewer.id,
        sessionId: 'account-fixture',
        nextDeviceSecret: 'fixture',
        user: viewer,
      });
    if (path.startsWith('/session/user/') || path === '/users/me' || path === `/users/${viewer.id}`)
      return json(viewer);
    if (path === `/profiles/username/${viewer.username}`) return json(viewer);
    if (path.includes('/session/sessions') || path.startsWith('/session/device/sessions/'))
      return json([]);
    if (path.includes('/accounts')) return json({ accounts: [], items: [] });
    if (path.includes('/users/by-ids')) return json({ users: [viewer] });
    if (path === '/safety/supervision') return json({ self: null, children: [], invitations: [] });
    if (path.startsWith('/profile/design/'))
      return json({ privacy: { profileVisibility: 'public' }, appearance: {}, profileMedia: null });
    if (path.includes('settings') || path.includes('preferences') || path.includes('entitlements'))
      return json({});
    if (path === '/notifications' || path.startsWith('/notifications/'))
      return json({ notifications: [], unreadCount: 0, count: 0, hasMore: false });
    if (path === '/feed/mtn') return json({ items: [], hasMore: false });
    if (path === '/trending') {
      return json({ trending: [], count: 0 });
    }
    if (path === '/recommendations') return json({ recommendations: [], hasMore: false });
    if (path === '/lanes') return json({ data: [] });
    if (method === 'GET' && path === '/api/rooms') {
      return json({ rooms: [] });
    }
    return route.abort('blockedbyclient');
  });
}

test('drawer adds an account through the shared Oxy dialog', async ({
  context,
  page,
  candidate,
}) => {
  await installSession(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Navigation menu' }).click();
  await page.getByRole('button', { name: 'Switch account, signed in as Account fixture' }).click();
  await page.getByRole('button', { name: 'Switch account', exact: true }).click();
  await page.getByText('Add another account', { exact: true }).click();
  await expect(page.getByTestId('signin-identifier')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close navigation' })).toHaveCount(0);
  await page.getByTestId('create-account-link').click();
  await expect(page.getByTestId('signup-username')).toBeVisible();
  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(page.getByTestId('signin-identifier')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Navigation menu' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close navigation' })).toHaveCount(0);
  await page.close();
  expect(candidate.scriptErrors).toEqual([]);
});
