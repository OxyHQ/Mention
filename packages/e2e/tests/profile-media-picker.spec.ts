import type { BrowserContext } from '@playwright/test';
import { APP_ORIGIN } from '../environment';
import { expect, test } from '../fixtures';

const viewer = {
  id: 'media-picker-fixture-user',
  username: 'media-picker-fixture',
  kind: 'personal',
  name: { displayName: 'Media fixture' },
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
          sessionId: 'media-fixture',
          userId: viewer.id,
          deviceId: 'fixture',
          deviceSecret: 'fixture',
        }),
      );
      localStorage.setItem('oxy.auth.token.v1', JSON.stringify({ accessToken: token, expiresAt }));
    },
    { viewer, token, expiresAt },
  );

  const unexpected: string[] = [];
  const roomRequests: string[] = [];
  const trendRequests: string[] = [];
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
      'GET /session/device/directory',
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
      unexpected.push(`${method} ${url.host}${path}`);
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
    if (path === '/session/device/token')
      return json({
        accessToken: token,
        expiresAt,
        userId: viewer.id,
        sessionId: 'media-fixture',
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
      trendRequests.push(url.href);
      return json({ trending: [], count: 0 });
    }
    if (path === '/recommendations') return json({ recommendations: [], hasMore: false });
    if (path === '/lanes') return json({ data: [] });
    if (method === 'GET' && path === '/api/rooms') {
      roomRequests.push(url.href);
      return json({ rooms: [] });
    }
    unexpected.push(`${method} ${url.host}${path}`);
    return route.abort('blockedbyclient');
  });
  return { unexpected, roomRequests, trendRequests };
}

for (const viewport of [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
]) {
  test(`${viewport.name}: opening profile media loads the picker on demand`, async ({
    context,
    page,
    candidate,
  }) => {
    const { unexpected, roomRequests, trendRequests } = await installSession(context);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const pickerRequests: string[] = [];
    let release: () => void = () => {
      throw new Error('Picker gate was not initialized');
    };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/MediaPickerSheet-[0-9a-f]{32}\.js$/, async (route) => {
      pickerRequests.push(route.request().url());
      await gate;
      await route.fallback();
    });

    try {
      await page.goto('/edit-profile');
      const add = page.getByRole('button', { name: 'Add song or podcast' });
      await expect(add).toBeVisible();
      expect(pickerRequests).toEqual([]);
      await add.click();
      await expect.poll(() => pickerRequests.length).toBe(1);
      await expect(page.getByText('Profile media', { exact: true })).toBeVisible();
      await expect(page.getByTestId('form-skeleton')).toBeVisible();
    } finally {
      release();
    }
    await expect(page.getByRole('button', { name: 'Song', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Podcast', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Podcast', exact: true }).click();
    await expect(page.getByPlaceholder('Search podcasts…')).toBeVisible();
    await page.getByRole('button', { name: 'Song', exact: true }).click();
    await expect(page.getByPlaceholder('Search songs…')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByPlaceholder('Search songs…')).toBeHidden();
    if (viewport.name === 'phone') {
      expect(roomRequests).toHaveLength(0);
      expect(trendRequests).toHaveLength(0);
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect.poll(() => roomRequests.length).toBe(1);
      await expect.poll(() => trendRequests.length).toBe(1);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
      const search = page.getByPlaceholder('Search Mention');
      await expect(search).toBeVisible();
      await search.fill('retained query');
      await expect(search).toHaveValue('retained query');
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByRole('search', { name: 'Search Mention' })).toBeHidden();
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect.poll(() => roomRequests.length).toBe(2);
      await expect.poll(() => trendRequests.length).toBe(2);
      await expect(search).toHaveValue('retained query');
    } else {
      await expect.poll(() => roomRequests.length).toBe(1);
      await expect.poll(() => trendRequests.length).toBe(1);
    }
    await page.close();
    expect(candidate.scriptErrors).toEqual([]);
    expect(unexpected).toEqual([]);
  });
}
