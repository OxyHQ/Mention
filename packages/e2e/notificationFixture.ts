import type { BrowserContext } from '@playwright/test';
import { APP_ORIGIN } from './environment';

export const user = {
  id: 'notification-navigation-viewer',
  username: 'notification-navigation-viewer',
  kind: 'personal',
  name: { displayName: 'Navigation Viewer' },
  email: 'viewer@example.test',
  avatar: null,
  verified: false,
  privacy: { isPrivate: false },
  counts: { followers: 0, following: 0, posts: 0 },
  locale: 'en',
};
export const postText = 'Notification navigation regression post';
const postId = 'notification-navigation-post';
export const selectedPostId = `${postId}-15`;
export const selectedText = `${postText} 15`;

export async function installNotificationFixture(
  context: BrowserContext,
  systemActor?: 'populated' | 'unpopulated',
  unread = false,
) {
  const expiresAt = new Date(Date.now() + 7_200_000).toISOString();
  const token = [
    Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url'),
    Buffer.from(
      JSON.stringify({
        sub: user.id,
        userId: user.id,
        sessionId: 'notification-fixture',
        exp: Math.floor(Date.now() / 1000) + 7200,
      }),
    ).toString('base64url'),
    'fixture',
  ].join('.');
  await context.addInitScript(
    ({ user, token, expiresAt }) => {
      localStorage.setItem(
        'oxy.auth.v1',
        JSON.stringify({
          sessionId: 'notification-fixture',
          userId: user.id,
          deviceId: 'fixture-device',
          deviceSecret: 'fixture-only',
        }),
      );
      localStorage.setItem('oxy.auth.token.v1', JSON.stringify({ accessToken: token, expiresAt }));
    },
    { user, token, expiresAt },
  );
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    // Let the release fixture serve candidate assets at the real app origin.
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
          name: 'Navigation fixture',
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
        sessionId: 'notification-fixture',
        nextDeviceSecret: 'fixture-only',
        user,
      });
    if (path === '/users/notification-actor-real')
      return json({
        id: 'notification-actor-real',
        username: 'notification-actor-real',
        name: { displayName: 'Real notification actor' },
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
    if (path === '/notifications')
      return json({
        notifications: Array.from({ length: 20 }, (_, index) => ({
          _id: `notification-navigation-like-${index}`,
          recipientId: user.id,
          actorId:
            systemActor && index === 0
              ? 'system'
              : systemActor && index === 1
                ? 'notification-actor-real'
                : user.id,
          type: systemActor && index === 0 ? 'welcome' : 'like',
          entityId: `${postId}-${index}`,
          entityType: 'post',
          read: !unread,
          createdAt: new Date(Date.now() - index * 60_000).toISOString(),
          preview: `${postText} ${index}`,
          actorId_populated:
            systemActor && index === 0
              ? systemActor === 'populated'
                ? { _id: 'system', username: 'system', name: { displayName: 'System' } }
                : undefined
              : systemActor && index === 1
                ? {
                    _id: 'notification-actor-real',
                    username: 'notification-actor-real',
                    name: { displayName: 'Real notification actor' },
                  }
                : { id: user.id, username: user.username, name: user.name },
        })),
        unreadCount: unread ? 20 : 0,
        hasMore: false,
        limit: 20,
      });
    if (path.startsWith('/notifications/')) return json({ count: 0 });
    if (path === `/feed/item/${selectedPostId}` || path === `/posts/${selectedPostId}`)
      return json({
        id: selectedPostId,
        user,
        content: { text: selectedText },
        visibility: 'public',
        attachments: {},
        authors: [],
        permissions: { canReply: true, canDelete: false, canPin: false, canViewSources: true },
        metadata: {
          status: 'published',
          visibility: 'public',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        engagement: { replies: 0, likes: 1, boosts: 0, saves: 0 },
        viewerState: {
          isOwner: false,
          isLiked: false,
          isDownvoted: false,
          isBoosted: false,
          isSaved: false,
          isCollaborator: false,
        },
      });
    if (path.includes('/feed') || path.includes('/posts'))
      return json({ posts: [], items: [], hasMore: false, nextCursor: null });
    if (path.startsWith('/socket.io')) return route.abort();
    return json({ items: [], data: [], nextCursor: null });
  });
}
