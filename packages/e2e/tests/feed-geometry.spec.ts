import type { Locator } from '@playwright/test';
import { expect, test } from '../fixtures';

const posts = Array.from({ length: 24 }, (_, index) => ({
  id: `019e23ee-2d68-7000-8000-${String(index + 1).padStart(12, '0')}`,
  user: {
    id: '019e23ee-2d68-7000-8001-000000000001',
    username: 'geometry-fixture',
    name: { displayName: 'Feed geometry' },
  },
  authors: [],
  attachments: {},
  content: {
    text: `Geometry post ${index + 1}\n${'A line of variable-height content.\n'.repeat(index % 5)}`,
  },
  metadata: { visibility: 'public', createdAt: '2026-10-01T12:00:00.000Z' },
  engagement: { likes: 0, downvotes: 0, boosts: 0, replies: 0 },
  viewerState: {
    isOwner: false,
    isCollaborator: false,
    isLiked: false,
    isDownvoted: false,
    isBoosted: false,
    isSaved: false,
  },
}));

/** Check measured row boundaries, including overscan; an estimated spacer is not content. */
async function expectContiguousRows(container: Locator) {
  await expect
    .poll(() =>
      container.locator('[data-post-uri]').evaluateAll((posts) => {
        const rows = [...new Set(posts.map((post) => post.closest<HTMLElement>('[data-index]')))]
          .filter((row): row is HTMLElement => row !== null)
          .filter((row) => row.getBoundingClientRect().height > 0);
        if (rows.length < 3) return [`Only ${rows.length} measured rows`];
        const failures: string[] = [];
        let comparedPairs = 0;
        for (let index = 1; index < rows.length; index += 1) {
          const previous = rows[index - 1];
          const current = rows[index];
          if (previous.parentElement !== current.parentElement) continue;
          if (Number(current.dataset.index) !== Number(previous.dataset.index) + 1) continue;
          comparedPairs += 1;
          const gap = current.getBoundingClientRect().top - previous.getBoundingClientRect().bottom;
          if (Math.abs(gap) > 1) {
            failures.push(`Rows ${previous.dataset.index}/${current.dataset.index}: ${gap}px gap`);
          }
        }
        if (comparedPairs < 2) failures.push(`Only ${comparedPairs} consecutive row pairs`);
        return failures;
      }),
    )
    .toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.route('**/feed/mtn?**', (route) =>
    route.fulfill({ json: { items: posts, hasMore: false } }),
  );
  await page.route('**/feed/item/*', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop();
    const post = posts.find((item) => item.id === id);
    return route.fulfill({ status: post ? 200 : 404, json: post ?? {} });
  });
  await page.route('**/feed/replies/**', (route) =>
    route.fulfill({ json: { items: [], hasMore: false } }),
  );
  await page.route('**/feed/thread-continuations/**', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
});

test('different-height feed rows remain contiguous after viewport resize and returning from a post', async ({
  page,
  candidate,
}) => {
  await page.goto('/');
  const main = page.getByTestId('mention-shell-panels-main');
  await expectContiguousRows(main);
  // A height-only resize leaves every row's actual height unchanged. The row
  // ResizeObservers must not be relied on to repair discarded measurements.
  await page.setViewportSize({ width: 1440, height: 800 });
  await expectContiguousRows(main);
  await page.setViewportSize({ width: 1300, height: 800 });
  await expectContiguousRows(main);

  await page.mouse.move(600, 500);
  await page.mouse.wheel(0, 1400);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(800);
  await expectContiguousRows(main);
  const selected = await main.locator('[data-post-uri]').evaluateAll((rows) => {
    const row = rows.find((node) => {
      const box = node.getBoundingClientRect();
      return box.top > 100 && box.top < innerHeight - 150;
    });
    const target = row?.querySelector<HTMLElement>('[tabindex="0"]');
    if (!row || !target) throw new Error('No visible keyboard-accessible feed post');
    target.focus();
    return row.getAttribute('data-post-uri');
  });
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/p\/[^/]+$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expectContiguousRows(main);
  await expect(main.locator('[data-post-uri]').filter({ visible: true }).first()).toBeAttached();
  await expect
    .poll(() =>
      main.locator('[data-post-uri]').evaluateAll(
        (rows, uri) =>
          rows.some((row) => {
            const box = row.getBoundingClientRect();
            return (
              row.getAttribute('data-post-uri') === uri && box.bottom > 0 && box.top < innerHeight
            );
          }),
        selected,
      ),
    )
    .toBe(true);
  expect(candidate.scriptErrors).toEqual([]);
});

test('feed row measurements follow the scroll owner when entering and leaving Deck', async ({
  page,
  candidate,
}) => {
  await page.goto('/');
  const main = page.getByTestId('mention-shell-panels-main');
  await expectContiguousRows(main);
  await page.getByRole('button', { name: 'Deck mode', exact: true }).click();
  await expect(main.locator('[data-bloom-screen-viewport="element"]')).toBeVisible();
  await expectContiguousRows(main);
  await page.getByRole('button', { name: 'Deck mode', exact: true }).click();
  await expect(main.locator('[data-bloom-screen-viewport="element"]')).toHaveCount(0);
  await expectContiguousRows(main);
  expect(candidate.scriptErrors).toEqual([]);
});

test('delayed feed media keeps neighboring rows contiguous through loading and width changes', async ({
  page,
  candidate,
}) => {
  const imageUrl = 'https://media.mention.earth/feed-geometry/landscape.svg';
  let releaseImage = () => {};
  const imageReady = new Promise<void>((resolve) => {
    releaseImage = resolve;
  });
  await page.route(imageUrl, async (route) => {
    await imageReady;
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="#438ac5"/></svg>',
    });
  });
  await page.route('**/feed/mtn?**', (route) =>
    route.fulfill({
      json: {
        items: posts.map((post, index) =>
          index === 1
            ? {
                ...post,
                content: {
                  ...post.content,
                  media: [
                    {
                      id: 'geometry-landscape',
                      type: 'image',
                      url: imageUrl,
                      width: 800,
                      height: 400,
                      alt: 'Delayed landscape',
                    },
                  ],
                },
              }
            : post,
        ),
        hasMore: false,
      },
    }),
  );
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const main = page.getByTestId('mention-shell-panels-main');
    const image = main.locator('img[alt="Delayed landscape"]');
    await expect(image).toBeAttached();
    await expectContiguousRows(main);
    releaseImage();
    await expect
      .poll(() =>
        image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0),
      )
      .toBe(true);
    await expectContiguousRows(main);
    await page.setViewportSize({ width: 700, height: 900 });
    await expectContiguousRows(main);
    expect(candidate.scriptErrors).toEqual([]);
  } finally {
    releaseImage();
  }
});
