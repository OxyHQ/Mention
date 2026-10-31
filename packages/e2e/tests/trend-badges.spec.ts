import { contractTest as test, expect } from '../fixtures';
import { API_ORIGIN } from '../environment';

test('trending shows the new and age badges for the same shared time window', async ({
  page,
  candidate,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const now = Date.now();
  const startedAt = (hours: number) => new Date(now - hours * 60 * 60 * 1000).toISOString();
  await page.route(
    (url) => url.origin === API_ORIGIN && url.pathname === '/trending',
    (route) =>
      route.fulfill({
        json: {
          trending: [
            {
              name: 'fresh-topic',
              displayName: 'Fresh topic',
              type: 'topic',
              startedAt: startedAt(0.5),
            },
            {
              name: 'older-topic',
              displayName: 'Older topic',
              type: 'topic',
              startedAt: startedAt(3),
            },
          ],
        },
      }),
  );
  await page.route('**/trending/history?**', (route) =>
    route.fulfill({ json: { days: [], page: 1, totalPages: 0 } }),
  );

  await page.goto('/explore/trending');
  const main = page.getByTestId('mention-shell-panels-main-surface-bounds');
  await expect(main.getByText('Fresh topic', { exact: true })).toBeVisible();
  await expect(main.getByText('Older topic', { exact: true })).toBeVisible();
  await expect(main.getByText('New', { exact: true })).toBeVisible();
  await expect(main.getByText('3h', { exact: true })).toBeVisible();
  expect(candidate.scriptErrors).toEqual([]);
});
