import { PROFILE_HANDLE } from '../environment';
import { expect, test } from '../fixtures';

const deckPost = {
  id: '019e23ee-2d68-7000-8000-000000000001',
  user: {
    id: '019e23ee-2d68-7000-8000-000000000002',
    username: 'averylongfederatedhandle@example.social',
    name: { displayName: 'An author with a long display name' },
  },
  authors: [],
  content: { text: 'A post that opens inside this Deck column.' },
  attachments: {},
  metadata: {
    visibility: 'public',
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
  },
  engagement: { likes: 0, downvotes: 0, boosts: 0, replies: 0 },
  viewerState: {
    isOwner: false,
    isCollaborator: false,
    isLiked: false,
    isDownvoted: false,
    isBoosted: false,
    isSaved: false,
  },
  permissions: { canReply: true, canDelete: false, canPin: false, canViewSources: false },
};

// Keep the regression about shell/router ownership independent of live feed ranking.
test.beforeEach(async ({ page }) => {
  await page.route('**/feed/mtn?**', (route) =>
    route.fulfill({ json: { items: [], hasMore: false } }),
  );
});

test('Deck has independent feed history and survives leaving and re-entering', async ({
  page,
  candidate,
}) => {
  await page.goto('/deck');
  const first = page.getByTestId('mention-shell-panels-deck-0');
  const second = page.getByTestId('mention-shell-panels-deck-1');
  await expect(first).toBeVisible();
  const settings = first.getByRole('button', { name: 'Panel settings', exact: true });
  await settings.click();
  const selector = page.getByRole('button', { name: 'Column feed', exact: true });
  await selector.click();
  await page.getByRole('radio', { name: 'Trending', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Panel settings', exact: true })).toHaveCount(0);
  await expect(first.getByRole('heading', { name: 'Trending', exact: true })).toBeVisible();
  await first.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(first.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
  await expect(second.getByRole('heading', { name: 'Trending', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page).not.toHaveURL(/\/deck$/);
  await page.getByRole('link', { name: 'Deck', exact: true }).click();
  await expect(first).toBeVisible();
  // The empty-feed illustration cancels its remote animation when leaving the route.
  expect(
    candidate.scriptErrors.filter(
      (error) => !/Failed to load animation data from URL: .*AbortError/.test(error),
    ),
  ).toEqual([]);
});

test('Deck disappears and redirects safely when the viewport becomes tablet-sized', async ({
  page,
  candidate,
}) => {
  await page.goto('/deck');
  await expect(page.getByTestId('mention-shell-panels-deck-0')).toBeVisible();
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(page).not.toHaveURL(/\/deck$/);
  await expect(page.getByTestId('mention-shell-panels-deck-0')).toBeHidden();
  await expect(page.getByRole('link', { name: 'Deck', exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/deck');
  await expect(page).not.toHaveURL(/\/deck$/);
  await expect(page.getByTestId('mention-shell-panels-deck-0')).toBeHidden();
  // The empty-feed illustration cancels its remote animation when leaving the route.
  expect(
    candidate.scriptErrors.filter(
      (error) => !/Failed to load animation data from URL: .*AbortError/.test(error),
    ),
  ).toEqual([]);
});

test('post clicks stay in their column and support back without horizontal drift', async ({
  page,
  candidate,
}) => {
  const post = deckPost;
  await page.route('**/feed/mtn?**', (route) =>
    route.fulfill({ json: { items: [post], hasMore: false } }),
  );
  await page.route(`**/feed/item/${post.id}`, (route) => route.fulfill({ json: post }));
  await page.route('**/feed/thread-continuations/**', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.goto('/deck');
  const first = page.getByTestId('mention-shell-panels-deck-0');
  const second = page.getByTestId('mention-shell-panels-deck-1');
  await first.getByText(post.content.text, { exact: true }).first().click();
  await expect(first.getByRole('heading', { name: 'Post', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/deck$/);
  await expect(second.getByRole('heading', { name: 'Trending', exact: true })).toBeVisible();
  const viewport = first.locator('[data-bloom-screen-viewport="element"]');
  expect(
    await viewport.evaluate((node) => node.scrollWidth - node.clientWidth),
  ).toBeLessThanOrEqual(1);
  expect(await viewport.evaluate((node) => node.scrollLeft)).toBe(0);
  await first.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(first.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
  await expect(
    first.getByRole('button', { name: 'Forward in this column', exact: true }),
  ).toHaveCount(0);
  await expect(page).toHaveURL(/\/deck$/);
  expect(
    candidate.scriptErrors.filter(
      (error) => !/Failed to load animation data from URL: .*AbortError/.test(error),
    ),
  ).toEqual([]);
});

test('profiles, profile tabs and post routes share the column history and scroll owner', async ({
  page,
  candidate,
}) => {
  const post = { ...deckPost, user: { ...deckPost.user, username: PROFILE_HANDLE } };
  await page.route('**/feed/mtn?**', (route) =>
    route.fulfill({ json: { items: [post], hasMore: false } }),
  );
  await page.route(`**/feed/item/${post.id}`, (route) => route.fulfill({ json: post }));
  await page.goto('/deck');
  const first = page.getByTestId('mention-shell-panels-deck-0');
  const second = page.getByTestId('mention-shell-panels-deck-1');
  await first.locator(`a[href="/@${PROFILE_HANDLE}"]`).first().click();
  const replies = first.getByRole('tab', { name: 'Replies', exact: true });
  await expect(replies).toBeVisible();
  await expect(page).toHaveURL(/\/deck$/);
  const chrome = first.getByTestId('profile-hero');
  await chrome.evaluate((node) => node.setAttribute('data-retained-profile', 'true'));
  await replies.click();
  await expect(replies).toHaveAttribute('aria-selected', 'true');
  await expect(chrome).toHaveAttribute('data-retained-profile', 'true');
  await first.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(first.getByRole('tab', { name: 'Posts', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(
    first.getByRole('button', { name: 'Forward in this column', exact: true }),
  ).toHaveCount(0);
  await expect(second.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/deck$/);
  expect(
    candidate.scriptErrors.filter(
      (error) => !/Failed to load animation data from URL: .*AbortError/.test(error),
    ),
  ).toEqual([]);
});

test('Deck horizontal wheel belongs to the page and shell chrome stays at the viewport edge', async ({
  page,
  candidate,
}) => {
  await page.goto('/deck');
  await expect(page.getByTestId('mention-shell-panels-deck-0')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth))
    .toBeGreaterThan(100);
  // Classic horizontal scrollbars consume viewport height; Deck must not gain
  // a second document scroll axis when that space is reserved.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const documentScroll = document.scrollingElement!;
        return documentScroll.scrollHeight - documentScroll.clientHeight;
      }),
    )
    .toBe(0);
  const sidebar = page.getByRole('complementary', { name: 'Sidebar', exact: true });
  const before = await sidebar.boundingBox();
  expect(
    await page.getByTestId('mention-shell-panels').evaluate((node) => {
      for (
        let parent: HTMLElement | null = node;
        parent && parent !== document.body;
        parent = parent.parentElement
      ) {
        if (['auto', 'scroll'].includes(getComputedStyle(parent).overflowX)) return true;
      }
      return false;
    }),
  ).toBe(false);
  await page.mouse.move(900, 300);
  await page.mouse.wheel(500, 0);
  await expect
    .poll(() => page.evaluate(() => document.scrollingElement!.scrollLeft))
    .toBeGreaterThan(100);
  expect((await sidebar.boundingBox())!.x).toBeCloseTo(before!.x, 0);
  const bottom = await page.getByTestId('mention-shell-bottom-bar').boundingBox();
  expect(bottom!.x).toBeCloseTo(0, 0);
  expect(bottom!.width).toBeCloseTo(page.viewportSize()!.width, 0);
  const column = await page.getByTestId('mention-shell-panels-deck-1').boundingBox();
  expect(column!.y).toBeCloseTo(8, 0);
  expect(bottom!.y - column!.y - column!.height).toBeCloseTo(8, 0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.evaluate(() => window.scrollTo(document.scrollingElement!.scrollWidth, 0));
  const lastColumn = await page.getByTestId('mention-shell-panels-deck-3').boundingBox();
  const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(viewportWidth - lastColumn!.x - lastColumn!.width).toBeCloseTo(8, 0);

  expect(
    candidate.scriptErrors.filter(
      (error) => !/Failed to load animation data from URL: .*AbortError/.test(error),
    ),
  ).toEqual([]);
});

test('panel settings use one modal, update only that panel and survive reload', async ({
  page,
  candidate,
}) => {
  await page.goto('/deck');
  const first = page.getByTestId('mention-shell-panels-deck-0');
  const second = page.getByTestId('mention-shell-panels-deck-1');
  await first.getByRole('button', { name: 'Panel settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Panel settings', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('slider', { name: 'Panel width', exact: true })).toHaveCount(0);
  await expect.poll(async () => (await second.boundingBox())?.width).toBe(390);
  await dialog.getByRole('switch', { name: 'Allow resizing', exact: true }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await first.getByRole('button', { name: 'Panel settings', exact: true }).click();
  await expect(
    dialog.getByRole('switch', { name: 'Allow resizing', exact: true }),
  ).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Reset panel settings', exact: true }).click();
  await expect.poll(async () => (await first.boundingBox())?.width).toBe(390);
  expect(
    candidate.scriptErrors.filter(
      (error) => !/Failed to load animation data from URL: .*AbortError/.test(error),
    ),
  ).toEqual([]);
});

test('the trailing edge creates a real screen panel and its settings can remove it', async ({
  page,
  candidate,
}) => {
  await page.goto('/deck');
  await expect(page.getByTestId('mention-shell-panels-deck-0')).toBeVisible();
  await page.evaluate(() => window.scrollTo(document.scrollingElement!.scrollWidth, 0));
  const edge = page.getByTestId('mention-shell-panels-trailing-action');
  await edge.hover();
  await edge.getByRole('button', { name: 'Add panel', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add panel', exact: true });
  await dialog.getByRole('button', { name: 'Add panel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const added = page
    .locator('[data-bloom-panel-index][data-testid^="mention-shell-panels-deck-"]')
    .filter({ has: page.getByRole('heading', { name: 'Explore', exact: true }) })
    .last();
  await expect
    .poll(async () => await added.evaluate((e) => e.getBoundingClientRect().right))
    .toBeLessThanOrEqual(1440);
  await expect(added.getByRole('tab', { name: 'Media', exact: true })).toBeVisible();
  await added.getByRole('button', { name: 'Panel settings', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Panel settings', exact: true })
    .getByRole('button', { name: 'Remove panel', exact: true })
    .click();
  await expect(
    page.locator('[data-bloom-panel-index][data-testid^="mention-shell-panels-deck-"]'),
  ).toHaveCount(4);
});

test('topic and hashtag screens render their feeds inside the column scroll owner', async ({
  page,
  candidate,
}) => {
  await page.route(/\/trending(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        trending: [
          { name: 'Bloom UI', displayName: 'Bloom UI', type: 'topic', volume: 20, rank: 1 },
        ],
      },
    }),
  );
  await page.route('**/trending/summary?**', (route) => route.fulfill({ json: {} }));
  await page.route('**/posts/hashtag/**', (route) =>
    route.fulfill({
      json: {
        items: [{ ...deckPost, content: { text: 'Hashtag fixture' } }],
        hasMore: false,
      },
    }),
  );
  const descriptors: string[] = [];
  await page.route('**/feed/mtn?**', (route) => {
    const descriptor = new URL(route.request().url()).searchParams.get('descriptor') ?? '';
    descriptors.push(descriptor);
    const text = descriptor.startsWith('trend|') ? 'Topic fixture #Bloom' : 'Hashtag fixture';
    return route.fulfill({ json: { items: [{ ...deckPost, content: { text } }], hasMore: false } });
  });
  await page.goto('/deck');
  const first = page.getByTestId('mention-shell-panels-deck-0');
  await first.getByText('Bloom UI', { exact: true }).first().click();
  await expect(first.getByText('Topic fixture', { exact: false })).toBeVisible();
  await expect(first.locator('[data-bloom-screen-viewport="element"]')).toHaveCount(1);
  expect(descriptors).toContain('trend|Bloom UI');
  await first.getByRole('link', { name: '#Bloom', exact: true }).click();
  await expect(first.getByRole('heading', { name: '#Bloom', exact: true })).toBeVisible();
  await expect(first.getByText('Hashtag fixture', { exact: true })).toBeVisible();
  await expect(first.locator('[data-bloom-screen-viewport="element"]')).toHaveCount(1);
  await expect(page).toHaveURL(/\/deck$/);
  expect(
    candidate.scriptErrors.filter(
      (error) => !/Failed to load animation data from URL: .*AbortError/.test(error),
    ),
  ).toEqual([]);
});

test('a slow topic read shows its skeleton and revisiting uses cached posts immediately', async ({
  page,
  candidate,
}) => {
  await page.route(/\/trending(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        trending: [
          { name: 'Bloom UI', displayName: 'Bloom UI', type: 'topic', volume: 20, rank: 1 },
        ],
      },
    }),
  );
  await page.route('**/trending/summary?**', (route) => route.fulfill({ json: {} }));
  let release!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let topicReads = 0;
  await page.route('**/feed/mtn?**', async (route) => {
    const descriptor = new URL(route.request().url()).searchParams.get('descriptor') ?? '';
    if (!descriptor.startsWith('trend|')) {
      await route.fulfill({ json: { items: [], hasMore: false } });
      return;
    }
    topicReads += 1;
    await responseGate;
    await route.fulfill({
      json: { items: [{ ...deckPost, content: { text: 'Loaded topic content' } }], hasMore: false },
    });
  });
  await page.goto('/deck');
  const first = page.getByTestId('mention-shell-panels-deck-0');
  try {
    await first.getByText('Bloom UI', { exact: true }).first().click();
    await expect(first.getByTestId('feed-skeleton')).toBeVisible();
    await expect(first.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
    await expect(first.locator('[data-bloom-screen-viewport="element"]')).toHaveCount(1);
  } finally {
    release();
  }
  await expect(first.getByText('Loaded topic content', { exact: true })).toBeVisible();
  await expect(first.getByTestId('feed-skeleton')).toHaveCount(0);
  await first.getByRole('button', { name: 'Back', exact: true }).click();
  await first.getByText('Bloom UI', { exact: true }).first().click();
  await expect(first.getByText('Loaded topic content', { exact: true })).toBeVisible();
  await expect(first.getByTestId('feed-skeleton')).toHaveCount(0);
  expect(topicReads).toBe(1);
  expect(
    candidate.scriptErrors.filter(
      (error) => !/Failed to load animation data from URL: .*AbortError/.test(error),
    ),
  ).toEqual([]);
});
