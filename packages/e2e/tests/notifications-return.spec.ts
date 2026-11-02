/** Auth/API fixtures exercise the exported router without creating public interactions. */
import { APP_ORIGIN } from '../environment';
import { expect, test } from '../fixtures';
import {
  fixtureViewerMatchesRequest,
  installNotificationFixture,
  postText,
  selectedPostId,
  selectedText,
  user,
} from '../notificationFixture';

for (const systemActor of ['populated', 'unpopulated'] as const) {
  test(`a ${systemActor} system actor renders without an Oxy lookup`, async ({
    context,
    page,
    candidate,
  }) => {
    await installNotificationFixture(context, systemActor);
    const systemRequests: string[] = [];
    const realActorRead = page.waitForResponse((response) =>
      response.url().endsWith('/users/notification-actor-real'),
    );
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/users/system') systemRequests.push(url.pathname);
      if (url.pathname === '/users/by-ids' && request.method() === 'POST') {
        const body = request.postDataJSON() as { ids?: string[] } | null;
        if (body?.ids?.includes('system')) systemRequests.push(url.pathname);
      }
    });

    await page.goto('/notifications');
    await expect(page.getByText('Welcome to Mention! 👋', { exact: true })).toBeVisible();
    await realActorRead;
    await expect(page.getByText('Real notification actor', { exact: true }).first()).toBeVisible();
    await page.getByText(selectedText, { exact: true }).click();
    await expect(page).toHaveURL(`${APP_ORIGIN}/p/${selectedPostId}`);
    await page.goBack();
    await expect(page.getByText(selectedText, { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await expect(page.getByText('Welcome to Mention! 👋', { exact: true })).toBeVisible();
    expect(systemRequests).toEqual([]);
    expect(candidate.scriptErrors).toEqual([]);
  });
}

for (const back of ['app', 'browser'] as const) {
  test(`Notifications returns to its inbox after ${back} Back from a post`, async ({
    context,
    page,
    candidate,
  }) => {
    await installNotificationFixture(context);
    await page.goto('/notifications');
    await expect(page.getByText(`${postText} 0`, { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Likes', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Likes', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.mouse.move(600, 500);
    await page.mouse.wheel(0, 1200);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
    await page.getByText(selectedText, { exact: true }).click();
    await expect(page).toHaveURL(`${APP_ORIGIN}/p/${selectedPostId}`);
    await expect(page.getByText(selectedText, { exact: true })).toBeVisible();
    if (back === 'browser') await page.goBack();
    else await page.getByRole('button', { name: 'Back', exact: true }).first().click();
    await expect(page).toHaveURL(`${APP_ORIGIN}/notifications?filter=likes`);
    await expect(page.getByRole('tab', { name: 'Likes', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByText(selectedText, { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
    await expect
      .poll(() =>
        page.getByText(selectedText, { exact: true }).evaluate((element) => {
          const box = element.getBoundingClientRect();
          return box.bottom > 0 && box.top < window.innerHeight;
        }),
      )
      .toBe(true);
    expect(candidate.scriptErrors).toEqual([]);
  });
}

test('a failed notification read is refreshed and can be retried', async ({
  context,
  page,
  candidate,
}) => {
  await installNotificationFixture(context, 'populated');
  const notificationId = 'read-retry-fixture';
  const inbox = {
    notifications: [
      {
        _id: notificationId,
        recipientId: user.id,
        actorId: 'system',
        type: 'welcome',
        entityId: '',
        entityType: 'system',
        read: false,
        createdAt: new Date().toISOString(),
        actorId_populated: { _id: 'system', username: 'system' },
      },
    ],
    unreadCount: 1,
    hasMore: false,
    limit: 20,
  };
  let readAttempts = 0;
  const headers = {
    'access-control-allow-origin': APP_ORIGIN,
    'access-control-allow-credentials': 'true',
  };
  await context.route(
    (url) => url.origin !== APP_ORIGIN && url.pathname === '/notifications/_viewer/inbox',
    (route) => {
      if (route.request().method() === 'OPTIONS') return route.fallback();
      expect(fixtureViewerMatchesRequest(route.request(), user.id)).toBe(true);
      return route.fulfill({ headers, json: inbox });
    },
  );
  await context.route(`**/notifications/_viewer/${notificationId}/read`, (route) => {
    if (route.request().method() === 'OPTIONS') return route.fallback();
    expect(route.request().headers()['x-mention-expected-viewer']).toBe(user.id);
    readAttempts += 1;
    return route.fulfill({ headers, status: readAttempts === 1 ? 500 : 200, json: {} });
  });
  await page.goto('/notifications');
  const welcome = page.getByText('Welcome to Mention! 👋', { exact: true });
  await expect(welcome).toBeVisible();
  const refreshed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/notifications/_viewer/inbox' &&
      response.request().method() === 'GET',
  );
  await welcome.click();
  await expect(page.getByText('Failed to mark notification as read')).toBeVisible();
  await refreshed;
  const successfulRead = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/notifications/_viewer/${notificationId}/read` &&
      response.ok(),
  );
  await welcome.click();
  await successfulRead;
  expect(readAttempts).toBe(2);
  await expect(welcome).toBeVisible();
  expect(candidate.scriptErrors).toEqual([]);
});
