/** Synthetic session and API for local-draft browser regressions. */
import type { BrowserContext } from '@playwright/test';
import { APP_ORIGIN } from './environment';

export const DRAFT_VIEWER_ID = 'draft-fixture-viewer';
export const DRAFT_KEY = `@mention_drafts:v2:${DRAFT_VIEWER_ID}`;

export interface FixtureDraft {
  id: string;
  postContent: string;
  localRevision?: number;
  updatedAt: number;
}

export async function installDraftFixture(context: BrowserContext): Promise<void> {
  const user = {
    id: DRAFT_VIEWER_ID,
    username: DRAFT_VIEWER_ID,
    kind: 'personal',
    name: { displayName: 'Draft Viewer' },
    email: 'viewer@example.test',
    avatar: null,
    verified: false,
    privacy: { isPrivate: false },
    counts: { followers: 0, following: 0, posts: 0 },
    locale: 'en',
  };
  const expiresAt = new Date(Date.now() + 7_200_000).toISOString();
  const token = [
    Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url'),
    Buffer.from(
      JSON.stringify({
        sub: user.id,
        userId: user.id,
        sessionId: 'draft-fixture',
        exp: Math.floor(Date.now() / 1000) + 7200,
      }),
    ).toString('base64url'),
    'fixture',
  ].join('.');
  await context.addInitScript(
    ({ user, token, expiresAt, draftKey }) => {
      localStorage.setItem('welcome_modal_seen', 'true');
      localStorage.setItem(
        'oxy.auth.v1',
        JSON.stringify({
          sessionId: 'draft-fixture',
          userId: user.id,
          deviceId: 'fixture-device',
          deviceSecret: 'fixture-only',
        }),
      );
      localStorage.setItem('oxy.auth.token.v1', JSON.stringify({ accessToken: token, expiresAt }));
      const draft = (id: string, postContent: string) => ({
        id,
        postContent,
        mediaIds: [],
        pollOptions: [],
        showPollCreator: false,
        location: null,
        mentions: [],
        threadItems: [],
        postingMode: 'thread',
        createdAt: 1,
        updatedAt: 1,
      });
      localStorage.setItem(
        draftKey,
        JSON.stringify([draft('a', 'Draft A original'), draft('b', 'Draft B original')]),
      );
      const state = window as typeof window & { __failDraftWrites?: boolean };
      state.__failDraftWrites = false;
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('@mention_drafts:v2') && state.__failDraftWrites)
          throw new DOMException('Quota exceeded', 'QuotaExceededError');
        return setItem.call(this, key, value);
      };
    },
    { user, token, expiresAt, draftKey: DRAFT_KEY },
  );
  await context.routeWebSocket('**/*', (socket) => socket.close());
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === APP_ORIGIN || !['http:', 'https:'].includes(url.protocol))
      return route.fallback();
    const path = url.pathname;
    const headers = {
      'access-control-allow-origin': APP_ORIGIN,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': '*',
    };
    const json = (body: unknown) => route.fulfill({ headers, json: body });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (path.startsWith('/auth/oauth/client/'))
      return json({
        application: {
          id: 'fixture-app',
          name: 'Draft fixture',
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
        userId: user.id,
        sessionId: 'draft-fixture',
        nextDeviceSecret: 'fixture-only',
        user,
      });
    if (path.startsWith('/session/user/') || path === '/users/me' || path === `/users/${user.id}`)
      return json(user);
    if (path.includes('/session/sessions') || path.startsWith('/session/device/sessions/'))
      return json([]);
    if (path.includes('/accounts')) return json({ accounts: [], items: [] });
    if (path.includes('/users/by-ids')) return json({ users: [user] });
    if (path === '/safety/supervision') return json({ self: null, children: [], invitations: [] });
    if (path.includes('settings') || path.includes('preferences') || path.includes('entitlements'))
      return json({});
    if (path.startsWith('/notifications/')) return json({ count: 0 });
    if (path.includes('/feed') || path.includes('/posts'))
      return json({ posts: [], items: [], hasMore: false, nextCursor: null });
    if (path.startsWith('/socket.io')) return route.abort();
    return json({ items: [], data: [], nextCursor: null });
  });
}
