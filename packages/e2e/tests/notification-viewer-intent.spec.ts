import type { Page } from '@playwright/test';
import { APP_ORIGIN } from '../environment';
import { expect, test } from '../fixtures';
import {
  fixtureViewerMatchesRequest,
  installNotificationFixture,
  selectedPostId,
  selectedText,
  user,
} from '../notificationFixture';

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
  await page.route('**/notifications/_viewer/unread-count', (route) => {
    if (route.request().method() === 'OPTIONS') return route.fallback();
    if (!remote || !fixtureViewerMatchesRequest(route.request(), remote))
      return route.fulfill({ status: 409, headers, json: { code: 'VIEWER_CHANGED' } });
    return route.fulfill({ headers, json: { count: 20 } });
  });
  await page.route('**/notifications/_viewer/inbox?*', (route) => {
    if (route.request().method() === 'OPTIONS') return route.fallback();
    if (new URL(route.request().url()).origin === APP_ORIGIN || remote === userA)
      return route.fallback();
    if (!remote || !fixtureViewerMatchesRequest(route.request(), remote))
      return route.fulfill({ status: 409, headers, json: { code: 'VIEWER_CHANGED' } });
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

for (const scenario of ['switch', 'aba', 'logout', 'relogin'] as const) {
  test(`an old mark-all confirmation cannot submit after ${scenario}`, async ({
    page,
    candidate,
  }) => {
    const fixture = await installSwitchingFixture(page);
    const writes: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (
        request.method() === 'PATCH' &&
        path.includes('/notifications/') &&
        path.endsWith('read-all')
      )
        writes.push(path);
    });
    await page.goto('/notifications');
    await expect(page.getByText(selectedText, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Mark all as read', exact: true }).click();
    const question = page.getByText('Are you sure you want to mark all notifications as read?', {
      exact: true,
    });
    await expect(question).toBeVisible();
    await fixture.changeTo(scenario === 'logout' || scenario === 'relogin' ? null : userB);
    await expect(question).toHaveCount(0);
    if (scenario === 'aba' || scenario === 'relogin') await fixture.changeTo(userA);
    const unexpected = page
      .waitForRequest(
        (request) =>
          request.method() === 'PATCH' &&
          new URL(request.url()).pathname.includes('/notifications/') &&
          new URL(request.url()).pathname.endsWith('read-all'),
        { timeout: 1000 },
      )
      .catch(() => null);
    await expect(question).toHaveCount(0);
    expect(await unexpected).toBeNull();
    expect(writes).toEqual([]);
    expect(candidate.scriptErrors).toEqual([]);
  });
}

for (const scenario of ['switch', 'aba', 'logout', 'relogin'] as const) {
  test(`a notification menu opened by A closes after ${scenario}`, async ({ page, candidate }) => {
    const fixture = await installSwitchingFixture(page);
    const writes: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (['PATCH', 'DELETE'].includes(request.method()) && path.includes('/notifications/'))
        writes.push(path);
    });
    await page.goto('/notifications');
    const preview = page.getByText(selectedText, { exact: true });
    const row = page.locator('.group').filter({ has: preview });
    await expect(row).toHaveCount(1);
    const rowAction =
      (await row.getAttribute('role')) === 'button'
        ? row
        : row.getByRole('button', { name: `${userA} liked your post`, exact: true });
    await expect(rowAction).toHaveCount(1);
    await expect(rowAction).toHaveAccessibleName(`${userA} liked your post`);
    await preview.scrollIntoViewIfNeeded();
    const box = await preview.boundingBox();
    if (!box) throw new Error('The notification preview has no visible bounds');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const mark = page.getByText('Mark as read', { exact: true });
    await expect(mark).toBeVisible();
    await page.mouse.up();
    await expect(page).toHaveURL(`${APP_ORIGIN}/notifications`);
    await fixture.changeTo(scenario === 'logout' || scenario === 'relogin' ? null : userB);
    await expect(mark).toHaveCount(0);
    if (scenario === 'aba' || scenario === 'relogin') await fixture.changeTo(userA);
    await expect(mark).toHaveCount(0);
    expect(writes).toEqual([]);
    expect(candidate.scriptErrors).toEqual([]);
  });
}

test('a retained failure does not toast under the new viewer', async ({ page, candidate }) => {
  const fixture = await installSwitchingFixture(page);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/notifications/_viewer/*/read', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const requestHeaders = route.request().headers();
    expect(requestHeaders['x-mention-expected-viewer']).toBe(userA);
    const authorization = requestHeaders.authorization ?? '';
    expect(authorization).toMatch(/^Bearer /);
    const claims = JSON.parse(
      Buffer.from(authorization.slice('Bearer '.length).split('.')[1], 'base64url').toString(),
    );
    expect(claims).toMatchObject({ sub: userA, sessionId: 'notification-fixture' });
    started();
    await gate;
    await route
      .fulfill({ status: 500, headers: fixture.headers, json: { error: 'fixture failure' } })
      .catch(() => {});
  });
  try {
    await page.goto('/notifications');
    await page.getByText(selectedText, { exact: true }).click();
    await seen;
    await fixture.changeTo(userB);
    const response = page.waitForResponse(
      (result) =>
        result.url().includes('/notifications/_viewer/') &&
        result.url().endsWith('/read') &&
        result.status() === 500,
    );
    await page.evaluate(() => {
      const state = window as typeof window & { __lateNotificationToast?: boolean };
      state.__lateNotificationToast = false;
      const observer = new MutationObserver(() => {
        if (document.body.innerText.includes('Failed to mark notification as read'))
          state.__lateNotificationToast = true;
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    release();
    await response;
    await page.waitForTimeout(300);
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { __lateNotificationToast?: boolean }).__lateNotificationToast,
      ),
    ).toBe(false);
    expect(candidate.scriptErrors).toEqual([]);
  } finally {
    release();
  }
});

async function installCollaborationFixture(
  page: Page,
  fixture: Awaited<ReturnType<typeof installSwitchingFixture>>,
) {
  await page.route('**/notifications/_viewer/inbox?*', (route) => {
    if (new URL(route.request().url()).origin === APP_ORIGIN) return route.fallback();
    if (route.request().method() === 'OPTIONS') return route.fallback();
    const current = fixture.viewer();
    if (!current || !fixtureViewerMatchesRequest(route.request(), current))
      return route.fulfill({
        status: 409,
        headers: fixture.headers,
        json: { code: 'VIEWER_CHANGED' },
      });
    const notifications =
      fixture.viewer() === userA
        ? [
            {
              _id: 'collab-notification',
              recipientId: userA,
              actorId: userA,
              type: 'collab_invite',
              entityId: 'collab-post',
              entityType: 'post',
              read: false,
              createdAt: new Date().toISOString(),
              actorId_populated: {
                id: userA,
                username: userA,
                name: { displayName: 'Navigation Viewer' },
              },
            },
          ]
        : [];
    return route.fulfill({
      headers: fixture.headers,
      json: { notifications, unreadCount: notifications.length, hasMore: false, limit: 20 },
    });
  });
  await page.route('**/feed/item/collab-post', (route) =>
    route.fulfill({
      headers: fixture.headers,
      json: {
        id: 'collab-post',
        user: profile(userA),
        content: { text: 'Collaboration fixture' },
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
        engagement: { replies: 0, likes: 0, boosts: 0, saves: 0 },
        viewerState: {
          isOwner: false,
          isLiked: false,
          isDownvoted: false,
          isBoosted: false,
          isSaved: false,
          isCollaborator: false,
          collabInvitePending: true,
          viewerRole: 'collaborator',
        },
      },
    }),
  );
}

for (const scenario of ['switch', 'aba', 'logout', 'relogin'] as const) {
  test(`a collaboration sheet opened by A closes after ${scenario}`, async ({
    page,
    candidate,
  }) => {
    const fixture = await installSwitchingFixture(page);
    const writes: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === 'POST' && path.includes('/collaborators/')) writes.push(path);
    });
    await installCollaborationFixture(page, fixture);
    await page.goto('/notifications');
    await page.getByRole('button', { name: 'Accept', exact: true }).first().click();
    await expect(page).toHaveURL(`${APP_ORIGIN}/notifications`);
    const question = page.getByText('Accept invite?', { exact: true });
    await expect(question).toBeVisible();
    await fixture.changeTo(scenario === 'logout' || scenario === 'relogin' ? null : userB);
    await expect(question).toHaveCount(0);
    if (scenario === 'aba' || scenario === 'relogin') await fixture.changeTo(userA);
    const unexpected = page
      .waitForRequest(
        (request) =>
          request.method() === 'POST' &&
          new URL(request.url()).pathname.includes('/collaborators/'),
        { timeout: 1000 },
      )
      .catch(() => null);
    await expect(question).toHaveCount(0);
    expect(await unexpected).toBeNull();
    expect(writes).toEqual([]);
    expect(candidate.scriptErrors).toEqual([]);
  });
}

test('pressing and holding the collaboration button does not open the row menu', async ({
  page,
  candidate,
}, testInfo) => {
  const fixture = await installSwitchingFixture(page);
  await installCollaborationFixture(page, fixture);
  await page.goto('/notifications');
  const accept = page.getByRole('button', { name: 'Accept', exact: true }).first();
  await expect(accept).toBeVisible();
  const box = await accept.boundingBox();
  if (!box) throw new Error('The collaboration button has no visible bounds');
  const rowBox = await accept.evaluate((element) => {
    const row = element.closest('.group');
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  expect(rowBox).not.toBeNull();
  await testInfo.attach('collaboration-gesture-geometry', {
    body: JSON.stringify({ viewport: page.viewportSize(), row: rowBox, accept: box }),
    contentType: 'application/json',
  });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Hold longer than the native-web long-press threshold before releasing.
  await page.waitForTimeout(800);
  await expect(page.getByText('Mark as read', { exact: true })).toHaveCount(0);
  await page.mouse.up();
  await expect(page).toHaveURL(`${APP_ORIGIN}/notifications`);
  await expect(page.getByText('Accept invite?', { exact: true })).toBeVisible();
  expect(candidate.scriptErrors).toEqual([]);
});

test('keyboard activation of collaboration does not navigate the row', async ({
  page,
  candidate,
}) => {
  const fixture = await installSwitchingFixture(page);
  await installCollaborationFixture(page, fixture);
  await page.goto('/notifications');
  const accept = page.getByRole('button', { name: 'Accept', exact: true }).first();
  await accept.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${APP_ORIGIN}/notifications`);
  await expect(page.getByText('Accept invite?', { exact: true })).toBeVisible();
  expect(candidate.scriptErrors).toEqual([]);
});

test('clicking a disabled collaboration button does not navigate the row', async ({
  page,
  candidate,
}) => {
  const fixture = await installSwitchingFixture(page);
  await installCollaborationFixture(page, fixture);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/posts/collab-post/collaborators/_viewer/decline', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fallback();
    expect(fixtureViewerMatchesRequest(route.request(), userA)).toBe(true);
    started();
    await gate;
    return route.fulfill({ headers: fixture.headers, json: { success: true } });
  });
  try {
    await page.goto('/notifications');
    await page.getByRole('button', { name: 'Decline', exact: true }).first().click();
    await sent;
    const accept = page.getByRole('button', { name: 'Accept', exact: true }).first();
    await expect(accept).toBeDisabled();
    const box = await accept.boundingBox();
    if (!box) throw new Error('The disabled collaboration button has no bounds');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const unexpected = await page.waitForURL('**/p/collab-post', { timeout: 1000 }).then(
      () => true,
      () => false,
    );
    expect(unexpected).toBe(false);
    await expect(page).toHaveURL(`${APP_ORIGIN}/notifications`);
    expect(candidate.scriptErrors).toEqual([]);
  } finally {
    release();
  }
});

test('the row background preserves padding hit testing', async ({ page, candidate }) => {
  const fixture = await installSwitchingFixture(page);
  await installCollaborationFixture(page, fixture);
  await page.goto('/notifications');
  const accept = page.getByRole('button', { name: 'Accept', exact: true }).first();
  await expect(accept).toBeVisible();
  const row = page.locator('.group').filter({ has: accept });
  await expect(row).toHaveCount(1);
  const box = await row.boundingBox();
  if (!box) throw new Error('The notification row has no bounds');
  await page.mouse.click(box.x + 3, box.y + 3);
  await expect(page).toHaveURL(`${APP_ORIGIN}/p/collab-post`);
  expect(candidate.scriptErrors).toEqual([]);
});

test('an ordinary notification preserves its accessible name and padding hit target', async ({
  page,
  candidate,
}, testInfo) => {
  await installSwitchingFixture(page);
  await page.goto('/notifications');
  const preview = page.getByText(selectedText, { exact: true });
  await preview.scrollIntoViewIfNeeded();
  const row = page.locator('.group').filter({ has: preview });
  await expect(row).toHaveCount(1);
  const action =
    (await row.getAttribute('role')) === 'button'
      ? row
      : row.getByRole('button', { name: `${userA} liked your post`, exact: true });
  await expect(action).toHaveAccessibleName(`${userA} liked your post`);
  const box = await row.boundingBox();
  if (!box) throw new Error('The ordinary notification row has no bounds');
  await testInfo.attach('ordinary-row-geometry', {
    body: JSON.stringify({ viewport: page.viewportSize(), row: box }),
    contentType: 'application/json',
  });
  await page.mouse.click(box.x + 3, box.y + 3);
  await expect(page).toHaveURL(/\/p\/notification-navigation-post-15$/);
  expect(candidate.scriptErrors).toEqual([]);
});

test('an expandable notification group keeps its control and row gesture independent', async ({
  page,
  candidate,
}, testInfo) => {
  const fixture = await installSwitchingFixture(page);
  await page.route('**/notifications/_viewer/inbox?*', (route) => {
    if (new URL(route.request().url()).origin === APP_ORIGIN) return route.fallback();
    if (route.request().method() === 'OPTIONS') return route.fallback();
    if (fixture.viewer() !== userA || !fixtureViewerMatchesRequest(route.request(), userA))
      return route.fulfill({
        status: 409,
        headers: fixture.headers,
        json: { code: 'VIEWER_CHANGED' },
      });
    const notifications = [userA, userB].map((actorId, index) => ({
      _id: `group-${index}`,
      recipientId: userA,
      actorId,
      type: 'like',
      entityId: 'group-post',
      entityType: 'post',
      read: false,
      createdAt: new Date().toISOString(),
      preview: 'Grouped notification fixture',
      actorId_populated: { id: actorId, username: actorId, name: { displayName: actorId } },
    }));
    return route.fulfill({
      headers: fixture.headers,
      json: { notifications, unreadCount: 2, hasMore: false, limit: 20 },
    });
  });
  await page.goto('/notifications');
  const toggle = page.getByRole('button', { name: 'Show all', exact: true });
  await expect(toggle).toHaveCount(1);
  const row = page.locator('.group').filter({ has: toggle });
  await expect(row).toHaveCount(1);
  const rowBox = await row.boundingBox();
  const toggleBox = await toggle.boundingBox();
  if (!rowBox || !toggleBox) throw new Error('The group or toggle has no bounds');
  await testInfo.attach('group-row-geometry', {
    body: JSON.stringify({ viewport: page.viewportSize(), row: rowBox, toggle: toggleBox }),
    contentType: 'application/json',
  });
  await page.mouse.move(toggleBox.x + toggleBox.width / 2, toggleBox.y + toggleBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(800);
  await expect(page.getByText('Mark as read', { exact: true })).toHaveCount(0);
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Show less', exact: true })).toBeVisible();
  await expect(page).toHaveURL(`${APP_ORIGIN}/notifications`);
  expect(candidate.scriptErrors).toEqual([]);
});

test('a focused ordinary row keeps focus when a realtime notification creates a group', async ({
  page,
  candidate,
}) => {
  await installSwitchingFixture(page);
  let emitNotification!: (notification: unknown) => void;
  let connected!: () => void;
  const ready = new Promise<void>((resolve) => {
    connected = resolve;
  });
  await page.routeWebSocket('**/socket.io/**', (socket) => {
    socket.send(
      '0{"sid":"fixture","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}',
    );
    socket.onMessage((message) => {
      if (typeof message !== 'string' || !message.startsWith('40/notifications,')) return;
      socket.send('40/notifications,{"sid":"notification-fixture"}');
      emitNotification = (notification) =>
        socket.send(`42/notifications,${JSON.stringify(['notification', notification])}`);
      connected();
    });
  });
  await page.goto('/notifications');
  const preview = page.getByText(selectedText, { exact: true });
  await preview.scrollIntoViewIfNeeded();
  const row = page.locator('.group').filter({ has: preview });
  const action =
    (await row.getAttribute('role')) === 'button'
      ? row
      : row.getByRole('button', { name: `${userA} liked your post`, exact: true });
  await expect(action).toHaveAccessibleName(`${userA} liked your post`);
  await action.focus();
  await expect(action).toBeFocused();
  await ready;
  emitNotification({
    _id: 'notification-realtime-group',
    recipientId: userA,
    actorId: userB,
    type: 'like',
    entityId: selectedPostId,
    entityType: 'post',
    read: false,
    createdAt: new Date().toISOString(),
    preview: selectedText,
    actorId_populated: { id: userB, username: userB, name: { displayName: userB } },
  });
  await expect(row.getByRole('button', { name: 'Show all', exact: true })).toBeVisible();
  const groupedAction =
    (await row.getAttribute('role')) === 'button' ? row : row.getByRole('button').first();
  await expect(groupedAction).toBeFocused();
  expect(candidate.scriptErrors).toEqual([]);
});

test('the row background and collaboration buttons have distinct keyboard focus', async ({
  page,
  candidate,
}) => {
  const fixture = await installSwitchingFixture(page);
  await installCollaborationFixture(page, fixture);
  await page.goto('/notifications');
  const accept = page.getByRole('button', { name: 'Accept', exact: true }).first();
  await expect(accept).toBeVisible();
  const row = page.locator('.group').filter({ has: accept });
  const buttons = row.getByRole('button');
  await expect(buttons).toHaveCount(3);
  const rowAction = buttons.first();
  await expect(rowAction).toHaveAccessibleName(`${userA} invited you to collaborate on a post`);
  await rowAction.focus();
  await expect(rowAction).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(accept).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${APP_ORIGIN}/notifications`);
  await expect(page.getByText('Accept invite?', { exact: true })).toBeVisible();
  expect(candidate.scriptErrors).toEqual([]);
});

test('keyboard activation of the accessible row opens its post', async ({ page, candidate }) => {
  const fixture = await installSwitchingFixture(page);
  await installCollaborationFixture(page, fixture);
  await page.goto('/notifications');
  const accept = page.getByRole('button', { name: 'Accept', exact: true }).first();
  await expect(accept).toBeVisible();
  const row = page.locator('.group').filter({ has: accept });
  const rowAction = row.getByRole('button', {
    name: `${userA} invited you to collaborate on a post`,
    exact: true,
  });
  await expect(rowAction).toHaveCount(1);
  await rowAction.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${APP_ORIGIN}/p/collab-post`);
  expect(candidate.scriptErrors).toEqual([]);
});

test('the profile hover target remains interactive above the row background', async ({
  page,
  candidate,
}) => {
  const fixture = await installSwitchingFixture(page);
  await installCollaborationFixture(page, fixture);
  await page.goto('/notifications');
  const accept = page.getByRole('button', { name: 'Accept', exact: true }).first();
  await expect(accept).toBeVisible();
  const row = page.locator('.group').filter({ has: accept });
  const hover = row.locator('[aria-haspopup]').first();
  await hover.hover();
  await expect(hover).toHaveAttribute('aria-expanded', 'true');
  expect(candidate.scriptErrors).toEqual([]);
});

test('a 404 from an older server fails without retrying an old write route', async ({
  page,
  candidate,
}) => {
  const fixture = await installSwitchingFixture(page);
  const writes: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'PATCH' && path.includes('/notifications/')) writes.push(path);
  });
  await page.route('**/notifications/_viewer/*/read', (route) =>
    route.fulfill({ status: 404, headers: fixture.headers, json: { message: 'not found' } }),
  );
  await page.goto('/notifications');
  await page.getByText(selectedText, { exact: true }).click();
  await expect(
    page.getByText('Failed to mark notification as read', { exact: true }),
  ).toBeVisible();
  expect(writes).toEqual(['/notifications/_viewer/notification-navigation-like-15/read']);
  expect(candidate.scriptErrors).toEqual([]);
});
