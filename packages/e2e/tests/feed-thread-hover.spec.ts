import type { Page } from '@playwright/test';
import { expect, contractTest as test } from '../fixtures';
import { APP_ORIGIN } from '../environment';

const author = {
  id: 'thread-fixture-author',
  username: 'thread-fixture',
  name: { displayName: 'Thread Author' },
};
const post = (id: string, text: string) => ({
  id,
  user: author,
  authors: [],
  attachments: {},
  documents: [],
  content: { text },
  metadata: { visibility: 'public', createdAt: '2026-10-23T08:00:00.000Z' },
  engagement: { likes: 0, downvotes: 0, replies: 0, boosts: 0, views: 0 },
  viewerState: {
    isOwner: false,
    isCollaborator: false,
    isLiked: false,
    isDownvoted: false,
    isBoosted: false,
    isSaved: false,
  },
});
const first = post('11111111-1111-4111-8111-111111111111', 'Thread first body');
const second = post('22222222-2222-4222-8222-222222222222', 'Thread second body');
const single = post('33333333-3333-4333-8333-333333333333', 'Standalone body');
const fillers = Array.from({ length: 45 }, (_, index) =>
  post(`44444444-4444-4444-8444-${String(index).padStart(12, '0')}`, `Filler ${index}`),
);

async function fixture(page: Page): Promise<void> {
  // Every external request is owned by this fixture. No visit, impression or
  // interaction signal reaches a live API; the app build still comes from the
  // candidate through the contract fixture.
  await page.route(
    (url) => url.origin !== APP_ORIGIN,
    (route) => route.fulfill({ status: 404, json: { error: 'synthetic fixture' } }),
  );
  await page.route('**/feed/mtn?**', (route) =>
    route.fulfill({
      json: {
        items: [first, second, single, ...fillers],
        hasMore: false,
        slices: [
          {
            _sliceKey: 'thread-a',
            items: [
              { post: first, isThreadParent: true, isThreadChild: false, isThreadLastChild: false },
              { post: second, isThreadParent: false, isThreadChild: true, isThreadLastChild: true },
            ],
            isIncompleteThread: true,
          },
          ...[single, ...fillers].map((item) => ({
            _sliceKey: item.id,
            items: [
              { post: item, isThreadParent: false, isThreadChild: false, isThreadLastChild: false },
            ],
            isIncompleteThread: false,
          })),
        ],
      },
    }),
  );
  await page.route(`**/feed/item/${first.id}`, (route) => route.fulfill({ json: first }));
  await page.route(`**/feed/replies/${first.id}**`, (route) =>
    route.fulfill({ json: { items: [], hasMore: false, totalCount: 0 } }),
  );
  await page.route(`**/statistics/post/${first.id}/view`, (route) =>
    route.fulfill({ json: { viewsCount: 1 } }),
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
  await page.context().routeWebSocket(
    () => true,
    (socket) => socket.close(),
  );
}

test('thread hover stays synchronized and clears when the hovered row is recycled', async ({
  page,
  candidate,
}) => {
  await fixture(page);
  await page.goto('/');

  const firstRow = page.locator(`[data-post-uri="${first.id}"]`);
  const secondRow = page.locator(`[data-post-uri="${second.id}"]`);
  const firstRoot = firstRow.locator('[aria-label="Thread Author: Thread first body"]');
  const secondRoot = secondRow.locator('[aria-label="Thread Author: Thread second body"]');
  const firstOverlay = firstRoot.locator(':scope > div').first();
  const secondOverlay = secondRoot.locator(':scope > div').first();
  const opacity = (locator: typeof firstOverlay) =>
    locator.evaluate((element) => Number(getComputedStyle(element).opacity));

  await expect(firstRoot).toBeVisible();
  await expect(secondRoot).toBeVisible();
  await expect.poll(() => opacity(firstOverlay)).toBe(0);
  await expect.poll(() => opacity(secondOverlay)).toBe(0);
  const box = await firstRoot.boundingBox();
  if (!box) throw new Error('Thread row has no layout');
  await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2);
  // Dark and light themes use different final opacity values; both exceed .3.
  await expect.poll(() => opacity(firstOverlay)).toBeGreaterThan(0.3);
  await expect.poll(() => opacity(secondOverlay)).toBeGreaterThan(0.3);

  const showThread = page.getByText('Show this thread', { exact: true });
  await showThread.hover();
  await expect.poll(() => opacity(firstOverlay)).toBeGreaterThan(0.3);
  await expect.poll(() => opacity(secondOverlay)).toBeGreaterThan(0.3);

  // Window virtualization removes the hovered trigger without a pointer move.
  await page.evaluate(() => window.scrollTo(0, 9000));
  await expect(firstRow).toHaveCount(0);
  await page.mouse.move(0, 0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(firstRow).toHaveCount(1);
  await expect.poll(() => opacity(firstOverlay)).toBe(0);
  await expect.poll(() => opacity(secondOverlay)).toBe(0);

  // The anonymous welcome dialog can open after the long scroll. Dismiss its
  // backdrop as a user would before clicking the second post in the thread.
  const dismissWelcome = page.getByRole('button', { name: 'Dismiss Welcome to Mention' });
  if (await dismissWelcome.isVisible()) {
    await dismissWelcome.click({ position: { x: 5, y: 5 } });
    await expect(dismissWelcome).toBeHidden();
  }
  await secondRoot.click({ position: { x: box.width - 8, y: 10 } });
  await expect(page).toHaveURL(`/p/${first.id}`);
  expect(candidate.scriptErrors).toEqual([]);
});

test.describe('touch', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('tapping a thread row keeps the thread destination', async ({ page, candidate }) => {
    await fixture(page);
    await page.goto('/');
    const secondRoot = page
      .locator(`[data-post-uri="${second.id}"]`)
      .locator('[aria-label="Thread Author: Thread second body"]');
    await expect(secondRoot).toBeVisible();
    const dismissWelcome = page.getByRole('button', { name: 'Dismiss Welcome to Mention' });
    if (await dismissWelcome.isVisible()) {
      await dismissWelcome.tap({ position: { x: 5, y: 5 } });
      await expect(dismissWelcome).toBeHidden();
    }
    await secondRoot.getByText(second.content.text, { exact: true }).tap();
    await expect(page).toHaveURL(`/p/${first.id}`);
    expect(candidate.scriptErrors).toEqual([]);
  });
});
