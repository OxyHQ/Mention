/** Gallery sharing uses a post/profile permalink, never viewer-scoped media URLs. */
import type { BrowserContext, Page } from '@playwright/test';
import { APP_ORIGIN, API_ORIGIN } from '../environment';
import { expect, contractTest as test } from '../fixtures';

const postId = 'c186e8a0-e9a5-4e84-9c97-15b285a79999';
const mediaUrl = 'https://media.fixture.test/image.svg?token=private-fixture';
const avatarUrl = 'https://media.fixture.test/avatar.svg?token=private-fixture';
const author = {
  id: 'gallery-share-author',
  username: 'gallery-share-person',
  kind: 'personal',
  name: { displayName: 'Gallery Share Person' },
  avatar: avatarUrl,
};
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="100%" height="100%" fill="blue"/></svg>';

async function installFixture(context: BrowserContext, page: Page) {
  await context.addInitScript(() => {
    const shares: ShareData[] = [];
    Object.assign(window, { galleryShares: shares });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data: ShareData) => {
        shares.push(data);
      },
    });
  });
  // Only the local candidate and the synthetic API boundary may see requests.
  await context.route('**/*', (route) => {
    const { origin, protocol } = new URL(route.request().url());
    if (origin === APP_ORIGIN || origin === API_ORIGIN || !['http:', 'https:'].includes(protocol))
      return route.fallback();
    return route.fulfill({
      status: 200,
      json: {},
      headers: { 'access-control-allow-origin': '*' },
    });
  });
  await page.route('https://media.fixture.test/**', (route) =>
    route.fulfill({ contentType: 'image/svg+xml', body: svg }),
  );
  await page.route(`https://api.oxy.so/profiles/username/${author.username}**`, (route) =>
    route.fulfill({ json: author }),
  );
  await page.route('**/feed/mtn?**', (route) =>
    route.fulfill({ json: { items: [], hasMore: false, nextCursor: null } }),
  );
  await page.route(`**/channels/${author.id}/writers**`, (route) =>
    route.fulfill({ status: 404, json: { error: 'Not found' } }),
  );
  await page.route(`**/feed/item/${postId}`, (route) =>
    route.fulfill({
      json: {
        id: postId,
        type: 'post',
        user: author,
        authors: [],
        attachments: {},
        viewerState: {
          isOwner: false,
          isCollaborator: false,
          isLiked: false,
          isDownvoted: false,
          isBoosted: false,
          isSaved: false,
          isFollowingAuthor: false,
        },
        content: {
          text: 'Gallery share fixture',
          media: [
            {
              id: 'share-image',
              type: 'image',
              alt: 'Private fixture image',
              width: 800,
              height: 800,
              url: mediaUrl,
              fullUrl: mediaUrl,
              thumbUrl: mediaUrl,
            },
          ],
        },
        metadata: { visibility: 'public', status: 'published', createdAt: '2026-01-01T00:00:00Z' },
        engagement: { likes: 0, downvotes: 0, replies: 0, boosts: 0, views: 0 },
      },
    }),
  );
}

async function expectSharedUrl(page: Page, expected: string) {
  await page.getByRole('button', { name: 'Share media', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { galleryShares: ShareData[] }).galleryShares),
    )
    .toEqual([{ url: expected }]);
}

test('post gallery shares the post permalink, not a scoped image URL', async ({
  context,
  page,
  candidate,
}) => {
  await installFixture(context, page);
  await page.goto(`/p/${postId}`);
  await page.locator('img[alt="Private fixture image"]').first().click();
  await expect(page.getByRole('button', { name: 'Close media viewer', exact: true })).toBeVisible();
  await expectSharedUrl(page, `https://mention.earth/p/${postId}`);
  expect(candidate.scriptErrors).toEqual([]);
});

test('profile avatar shares the profile permalink, not a scoped avatar URL', async ({
  context,
  page,
  candidate,
}) => {
  await installFixture(context, page);
  await page.goto(`/@${author.username}`);
  await page.getByLabel('Profile avatar').first().click();
  await expect(page.getByRole('button', { name: 'Close media viewer', exact: true })).toBeVisible();
  await expectSharedUrl(page, `https://mention.earth/@${author.username}`);
  expect(candidate.scriptErrors).toEqual([]);
});

test('channel avatar shares its channel permalink', async ({ context, page, candidate }) => {
  await installFixture(context, page);
  await page.route(`https://api.oxy.so/profiles/username/${author.username}**`, (route) =>
    route.fulfill({ json: { ...author, kind: 'channel' } }),
  );
  await page.goto(`/c/${author.username}`);
  await page.getByLabel('Profile avatar').first().click();
  await expect(page.getByRole('button', { name: 'Close media viewer', exact: true })).toBeVisible();
  await expectSharedUrl(page, `https://mention.earth/c/${author.username}`);
  expect(candidate.scriptErrors).toEqual([]);
});

test('an avatar without a resolved username does not expose sharing', async ({
  context,
  page,
  candidate,
}) => {
  await installFixture(context, page);
  await page.route(`https://api.oxy.so/profiles/username/${author.username}**`, (route) =>
    route.fulfill({ json: { ...author, username: '' } }),
  );
  await page.goto(`/@${author.username}`);
  await page.getByLabel('Profile avatar').first().click();
  await expect(page.getByRole('button', { name: 'Close media viewer', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share media', exact: true })).toHaveCount(0);
  expect(candidate.scriptErrors).toEqual([]);
});
