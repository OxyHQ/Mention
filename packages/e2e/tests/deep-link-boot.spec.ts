/** Cold deep links must survive every history write during provider/chunk boot. */
import { PROFILE_HANDLE } from '../environment';
import { expect, test } from '../fixtures';
import type { Page } from '@playwright/test';

type HistoryEntry = { kind: string; href: string; length: number };
type HistoryWindow = Window & { __bootHistory: HistoryEntry[] };

async function captureHistory(page: Page) {
  await page.addInitScript(() => {
    const entries: HistoryEntry[] = [];
    (window as unknown as HistoryWindow).__bootHistory = entries;
    const record = (kind: string) => entries.push({ kind, href: location.href, length: history.length });
    record('initial');
    for (const method of ['pushState', 'replaceState'] as const) {
      const original = history[method];
      history[method] = function (...args: Parameters<History[typeof method]>) {
        original.apply(this, args);
        record(method);
      };
    }
    addEventListener('popstate', () => record('popstate'));
  });
}

async function expectStableBoot(page: Page, pathname: string) {
  // Two paints let the committed route's history effect run; every earlier
  // write has already been captured, including changes that immediately revert.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const entries = await page.evaluate(() => (window as unknown as HistoryWindow).__bootHistory);
  expect(entries.length, 'router initialization must have been observed').toBeGreaterThan(1);
  expect(entries.map(({ href }) => decodeURIComponent(new URL(href).pathname)), JSON.stringify(entries)).toEqual(entries.map(() => pathname));
  for (const { href, length } of entries) {
    const url = new URL(href);
    expect(url.searchParams.get('bootProbe'), href).toBe('deep-link');
    expect(url.hash, href).toBe('#boot-probe');
    expect(length, 'boot must not add browser history entries').toBe(entries[0].length);
  }
}

for (const route of [
  { pathname: `/@${PROFILE_HANDLE}`, tab: 'Posts' },
  { pathname: `/@${PROFILE_HANDLE}/media`, tab: 'Media' },
  { pathname: '/search', tab: null },
]) {
  test(`cold ${route.pathname} preserves the URL through font and route loading`, async ({ page, candidate }) => {
    await captureHistory(page);
    // Delay real font responses without mocking their bytes. This widens the
    // navigator-free boot window that exposed the shipped home-route flash.
    await page.route(/\.(?:woff2?|ttf)(?:\?|$)/, async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await request.fallback();
    });
    await page.goto(`${route.pathname}?bootProbe=deep-link#boot-probe`);
    if (route.tab) {
      await expect(page.getByRole('tab', { name: route.tab, exact: true })).toHaveAttribute('aria-selected', 'true');
    } else {
      await expect(page.getByPlaceholder('Search...', { exact: true })).toBeVisible();
    }
    await expectStableBoot(page, route.pathname);
    if (route.pathname === `/@${PROFILE_HANDLE}`) {
      // A reload re-runs addInitScript and captures a fresh, already-populated
      // history entry rather than only the browser's initial navigation.
      await page.reload();
      await expect(page.getByRole('tab', { name: 'Posts', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expectStableBoot(page, route.pathname);
    }
    expect(candidate.scriptErrors).toEqual([]);
  });
}

test('profile history returns directly between the routes the visitor opened', async ({ page, candidate }) => {
  await captureHistory(page);
  await page.goto(`/@${PROFILE_HANDLE}?bootProbe=deep-link#boot-probe`);
  const posts = page.getByRole('tab', { name: 'Posts', exact: true });
  const media = page.getByRole('tab', { name: 'Media', exact: true });
  await expect(posts).toHaveAttribute('aria-selected', 'true');
  await expectStableBoot(page, `/@${PROFILE_HANDLE}`);
  await media.focus();
  await page.keyboard.press('Enter');
  await expect(media).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(new RegExp(`/@${PROFILE_HANDLE}/media$`));
  await page.goBack();
  await expect(posts).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(new RegExp(`/@${PROFILE_HANDLE}\\?bootProbe=deep-link#boot-probe$`));
  await page.goForward();
  await expect(media).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(new RegExp(`/@${PROFILE_HANDLE}/media$`));
  const paths = await page.evaluate(() => (window as unknown as HistoryWindow).__bootHistory.map(({ href }) => decodeURIComponent(new URL(href).pathname)));
  expect(paths.every((pathname) => pathname === `/@${PROFILE_HANDLE}` || pathname === `/@${PROFILE_HANDLE}/media`), JSON.stringify(paths)).toBe(true);
  expect(candidate.scriptErrors).toEqual([]);
});


test('a cold post deep link keeps its route until the post response resolves', async ({ page, candidate }) => {
  const id = 'c186e8a0-e9a5-4e84-9c97-15b285a77777';
  const pathname = `/p/${id}`;
  const text = 'Public post for the deep-link navigation regression.';
  await captureHistory(page);
  // The post DTO is deterministic so this routing gate does not depend on a
  // particular production post surviving. The real screen and router still run.
  await page.route(`**/feed/item/${id}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ json: {
      id, type: 'post',
      user: { id: 'deep-link-fixture-user', username: 'deep-link-fixture', name: { displayName: 'Navigation Fixture' } },
      authors: [], attachments: {},
      viewerState: { isOwner: false, isCollaborator: false, isLiked: false, isDownvoted: false, isBoosted: false, isSaved: false, isFollowingAuthor: false },
      content: { text, media: [] },
      metadata: { visibility: 'public', status: 'published', createdAt: '2026-01-01T00:00:00Z' },
      engagement: { likes: 0, downvotes: 0, replies: 0, boosts: 0, views: 0 },
    } });
  });
  await page.route(`**/feed/replies/${id}**`, (route) => route.fulfill({ json: { items: [], hasMore: false, totalCount: 0 } }));
  await page.route(`**/statistics/post/${id}/view`, (route) => route.fulfill({ json: { viewsCount: 1 } }));
  await page.goto(`${pathname}?bootProbe=deep-link#boot-probe`);
  await expect(page.getByText(text, { exact: true })).toBeVisible();
  await expectStableBoot(page, pathname);
  expect(candidate.scriptErrors).toEqual([]);
});
