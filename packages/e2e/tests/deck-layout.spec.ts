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

// These flows exercise an already configured workspace. A new workspace keeps
// the current application page as its first column (covered separately below).
test.describe('configured Deck', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (localStorage.getItem('mention:deck:workspace')) return;
      const sources = ['explore', 'trending', 'following', 'saved'];
      const ids = ['deck-custom', 'deck-1', 'deck-2', 'deck-3'];
      const state = {
        syncEnabled: false,
        order: ids,
        panels: Object.fromEntries(
          sources.map((source, index) => [
            ids[index],
            { source, width: 390, resizable: true, appearance: 'solid' },
          ]),
        ),
      };
      localStorage.setItem(
        'mention:deck:workspace',
        JSON.stringify({
          version: 1,
          state: { records: { anonymous: { state, base: null, revision: 0, dirty: false } } },
        }),
      );
    });
  });

  test('Deck has independent feed history and survives leaving and re-entering', async ({
    page,
    candidate,
  }) => {
    await page.goto('/deck');
    const first = page.getByTestId('mention-shell-panels-deck-custom');
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
    await page.getByRole('button', { name: 'Deck mode', exact: true }).click();
    await page.getByRole('link', { name: 'Home', exact: true }).click();
    await expect(page).not.toHaveURL(/\/deck$/);
    await page.getByRole('button', { name: 'Deck mode', exact: true }).click();
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
    await expect(page.getByTestId('mention-shell-panels-deck-custom')).toBeVisible();
    await page.setViewportSize({ width: 768, height: 900 });
    await expect(page).not.toHaveURL(/\/deck$/);
    await expect(page.getByTestId('mention-shell-panels-deck-custom')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Deck mode', exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/deck');
    await expect(page).not.toHaveURL(/\/deck$/);
    await expect(page.getByTestId('mention-shell-panels-deck-custom')).toBeHidden();
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
    const first = page.getByTestId('mention-shell-panels-deck-custom');
    const second = page.getByTestId('mention-shell-panels-deck-1');
    await first.getByText(post.content.text, { exact: true }).first().click();
    await expect(first.getByRole('heading', { name: 'Post', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
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
    await expect(page).toHaveURL(/\/$/);
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
    const first = page.getByTestId('mention-shell-panels-deck-custom');
    const second = page.getByTestId('mention-shell-panels-deck-1');
    await first.locator(`a[href="/@${PROFILE_HANDLE}"]`).first().click();
    const replies = first.getByRole('tab', { name: 'Replies', exact: true });
    await expect(replies).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
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
    await expect(page).toHaveURL(/\/$/);
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
    await expect(page.getByTestId('mention-shell-panels-deck-custom')).toBeVisible();
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
          let parent: Element | null = node;
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
    const firstColumn = await page.getByTestId('mention-shell-panels-main').boundingBox();
    const bottom = await page.getByTestId('sign-in-banner').filter({ visible: true }).boundingBox();
    expect(bottom!.x).toBeCloseTo(firstColumn!.x, 0);
    expect(bottom!.width).toBeCloseTo(firstColumn!.width, 0);
    const column = await page.getByTestId('mention-shell-panels-deck-1').boundingBox();
    expect(column!.y).toBeCloseTo(8, 0);
    expect(bottom!.y + bottom!.height - column!.y - column!.height).toBeCloseTo(0, 0);
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
    const first = page.getByTestId('mention-shell-panels-deck-custom');
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
    await expect(page.getByTestId('mention-shell-panels-deck-custom')).toBeVisible();
    await page.evaluate(() => {
      const documentScroller = document.scrollingElement;
      if (!documentScroller) throw new Error('Document scroll owner is unavailable');
      window.scrollTo(documentScroller.scrollWidth, 0);
    });
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
    expect(
      candidate.scriptErrors.filter(
        (error) => !/Failed to load animation data from URL: .*AbortError/.test(error),
      ),
    ).toEqual([]);
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
      return route.fulfill({
        json: { items: [{ ...deckPost, content: { text } }], hasMore: false },
      });
    });
    await page.goto('/deck');
    const first = page.getByTestId('mention-shell-panels-deck-custom');
    await first.getByText('Bloom UI', { exact: true }).first().click();
    await expect(first.getByText('Topic fixture', { exact: false })).toBeVisible();
    await expect(first.locator('[data-bloom-screen-viewport="element"]')).toHaveCount(1);
    expect(descriptors).toContain('trend|Bloom UI');
    await first.getByRole('link', { name: '#Bloom', exact: true }).click();
    await expect(first.getByRole('heading', { name: '#Bloom', exact: true })).toBeVisible();
    await expect(first.getByText('Hashtag fixture', { exact: true })).toBeVisible();
    await expect(first.locator('[data-bloom-screen-viewport="element"]')).toHaveCount(1);
    await expect(page).toHaveURL(/\/$/);
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
        json: {
          items: [{ ...deckPost, content: { text: 'Loaded topic content' } }],
          hasMore: false,
        },
      });
    });
    await page.goto('/deck');
    const first = page.getByTestId('mention-shell-panels-deck-custom');
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

  test('Deck home preference survives reload and can be disabled in settings', async ({
    page,
    candidate,
  }) => {
    await page.goto('/settings/deck');
    const home = page.getByRole('switch', { name: 'Make Deck my home screen', exact: true });
    await expect(home).toHaveAttribute('aria-checked', 'false');
    await home.click();
    await expect(home).toHaveAttribute('aria-checked', 'true');
    await page.goto('/');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('mention-shell-panels-deck-custom')).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('mention-shell-panels-deck-custom')).toBeVisible();
    await page.goto('/settings/deck');
    await expect(home).toHaveAttribute('aria-checked', 'true');
    await home.click();
    await page.goto('/');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('mention-shell-panels-deck-custom')).toBeHidden();
    expect(
      candidate.scriptErrors.filter(
        (error) => !/Failed to load animation data from URL: .*AbortError/.test(error),
      ),
    ).toEqual([]);
  });

  test('restoring the last active panel does not scroll the Deck document to the end', async ({
    page,
    candidate,
  }) => {
    await page.addInitScript(() => {
      const sources = ['explore', 'trending', 'following', 'saved'];
      const state = {
        syncEnabled: false,
        homeScreen: true,
        activePanel: 'deck-3',
        order: sources.map((_, index) => (index === 0 ? 'deck-custom' : `deck-${index}`)),
        panels: Object.fromEntries(
          sources.map((source, index) => [
            index === 0 ? 'deck-custom' : `deck-${index}`,
            { source, width: 390, resizable: true, appearance: 'solid' },
          ]),
        ),
      };
      localStorage.setItem(
        'mention:deck:workspace',
        JSON.stringify({
          version: 1,
          state: { records: { anonymous: { state, base: null, revision: 0, dirty: false } } },
        }),
      );
    });
    await page.goto('/');
    await expect(page).toHaveURL(/\/$/);
    const first = page.getByTestId('mention-shell-panels-deck-custom');
    await expect(first.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollX)).toBe(0);
    await page.reload();
    await expect(first.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollX)).toBe(0);
    expect(
      candidate.scriptErrors.filter(
        (error) => !/Failed to load animation data from URL: .*AbortError/.test(error),
      ),
    ).toEqual([]);
  });
});

test('default Deck preserves the current post and its DOM through both layout changes', async ({
  page,
  candidate,
}) => {
  const post = {
    ...deckPost,
    content: {
      text: Array.from(
        { length: 12 },
        (_, i) => `Paragraph ${i + 1}. Keep reading this same post as the workspace changes.`,
      ).join('\n\n'),
    },
  };
  await page.route(`**/feed/item/${post.id}`, (route) => route.fulfill({ json: post }));
  await page.route('**/feed/thread-continuations/**', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/feed/replies/**', (route) =>
    route.fulfill({ json: { items: [], hasMore: false } }),
  );
  await page.goto(`/p/${post.id}`);
  const panel = page.getByTestId('mention-shell-panels-main');
  const screen = panel.getByTestId('post-screen');
  await expect(screen).toBeVisible();
  await screen.evaluate((node) => node.setAttribute('data-retained-post', 'true'));
  await page.evaluate(() => window.scrollTo(0, 200));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(200);
  const deck = page.getByRole('button', { name: 'Deck mode', exact: true });
  // DOM click avoids the automation's scroll-into-view changing the reading offset.
  await deck.evaluate((node: HTMLElement) => node.click());
  await expect(page).toHaveURL(new RegExp(`/p/${post.id}$`));
  await expect(screen).toHaveAttribute('data-retained-post', 'true');
  await expect.poll(async () => (await panel.boundingBox())?.width).toBe(390);
  await expect(panel.getByRole('button', { name: 'Panel settings', exact: true })).toHaveCount(0);
  const owner = screen.locator('[data-bloom-screen-viewport="element"]');
  await expect.poll(() => owner.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await owner.evaluate((node) => {
    node.scrollTop = 300;
  });
  await expect.poll(() => owner.evaluate((node) => node.scrollTop)).toBe(300);
  await page
    .getByRole('button', { name: 'Deck mode', exact: true })
    .evaluate((node: HTMLElement) => node.click());
  await expect.poll(async () => (await panel.boundingBox())?.width).toBe(620);
  await expect(screen).toHaveAttribute('data-retained-post', 'true');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect(panel.getByTestId('sign-in-banner')).toBeVisible();
  expect(candidate.scriptErrors).toEqual([]);
});

test('column grips reorder saved panels while the application column stays fixed', async ({
  page,
}) => {
  await page.goto('/deck');
  const main = page.getByTestId('mention-shell-panels-main');
  const first = page.getByTestId('mention-shell-panels-deck-1');
  const second = page.getByTestId('mention-shell-panels-deck-2');
  const grip = page.getByTestId('mention-shell-panels-deck-1-reorder');
  await expect(grip).toBeVisible();
  await expect(main.locator('[data-bloom-panel-reorder]')).toHaveCount(0);
  await first.evaluate((node) => node.setAttribute('data-retained-column', 'true'));
  await page.evaluate(() => window.scrollTo(350, 0));
  const start = await grip.boundingBox();
  const target = await second.boundingBox();
  if (!start || !target) throw new Error('Column drag targets were not rendered');
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2 + 30, start.y + start.height / 2, {
    steps: 20,
  });
  await page.mouse.up();
  const savedOrder = () =>
    page.evaluate(() => {
      const workspace = JSON.parse(localStorage.getItem('mention:deck:workspace') ?? '{}');
      return workspace.state?.records?.anonymous?.state?.order;
    });
  await expect.poll(savedOrder).toEqual(['deck-0', 'deck-2', 'deck-1', 'deck-3']);
  await expect(first).toHaveAttribute('data-retained-column', 'true');
  await expect(main).toBeVisible();
  await page.reload();
  await expect(grip).toBeVisible();
  await expect.poll(savedOrder).toEqual(['deck-0', 'deck-2', 'deck-1', 'deck-3']);
  // Keyboard users can move the same column back without dragging.
  await grip.focus();
  await grip.press('ArrowLeft');
  await expect.poll(savedOrder).toEqual(['deck-0', 'deck-1', 'deck-2', 'deck-3']);
});
