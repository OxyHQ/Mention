import type { BrowserContext } from '@playwright/test';
import { APP_ORIGIN, FIXTURE_VIEWER_SETTINGS } from '../environment';

const viewer = {
  id: 'account-flow-fixture-user',
  avatar: 'https://media.mention.earth/playback-regression/avatar.svg',
  username: 'account-flow-fixture',
  kind: 'personal',
  name: { displayName: 'Account fixture' },
  privacy: { isPrivate: false },
  counts: { followers: 0, following: 0, posts: 0 },
};

export async function installReplySession(context: BrowserContext) {
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
    (url) => url.origin !== APP_ORIGIN.replace(/^http/, 'ws'),
    (socket) => void socket.close(),
  );
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === APP_ORIGIN || !['http:', 'https:'].includes(url.protocol))
      return route.fallback();
    const path = url.pathname;
    const method = request.method();
    if (path.includes('avatar.svg'))
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="16" fill="#68a"/></svg>',
        headers: { 'access-control-allow-origin': '*' },
      });
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
      'GET /community-notes/availability',
      'POST /apps/assertions',
      'GET /privacy/blocked',
      'GET /privacy/restricted',
      'POST /stickers/resolve',
    ]);
    if (unrelated.has(`${method} ${path}`)) return route.abort('blockedbyclient');
    if (
      method !== 'GET' &&
      !(method === 'POST' && ['/session/device/token', '/users/by-ids'].includes(path))
    ) {
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
    if (path === '/users/me/graph')
      return json({
        followingIds: ['follow-a', 'follow-b', 'follow-c'],
        mutualIds: [],
        blockedIds: [],
        restrictedIds: [],
      });
    if (path.includes('/users/by-ids'))
      return json([
        viewer,
        ...['follow-a', 'follow-b', 'follow-c'].map((id) => ({ ...viewer, id, username: id })),
      ]);
    if (path === '/safety/supervision') return json({ self: null, children: [], invitations: [] });
    if (path.startsWith('/profile/design/'))
      return json({ privacy: { profileVisibility: 'public' }, appearance: {}, profileMedia: null });
    if (path.includes('settings') || path.includes('preferences') || path.includes('entitlements'))
      return json(FIXTURE_VIEWER_SETTINGS);
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
