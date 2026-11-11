import { expect, test } from '../fixtures';

const post = {
  id: '019e23ee-2d68-7000-8000-000000000011',
  user: {
    id: '019e23ee-2d68-7000-8000-000000000012',
    username: 'panel-author',
    name: { displayName: 'Panel author' },
  },
  authors: [],
  content: { text: 'Read this post while browsing its likes.' },
  attachments: {},
  metadata: {
    visibility: 'public',
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
  },
  engagement: { likes: 80, boosts: 2, downvotes: 0, replies: 0 },
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

// This is a layout contract. Both page content and every list page are owned fixtures.
test.beforeEach(async ({ page }) => {
  await page.route('**/feed/mtn?**', (route) =>
    route.fulfill({ json: { items: [post], hasMore: false } }),
  );
  await page.route(`**/feed/item/${post.id}`, (route) => route.fulfill({ json: post }));
  await page.route('**/feed/thread-continuations/**', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/feed/replies/**', (route) =>
    route.fulfill({ json: { items: [], hasMore: false } }),
  );
  await page.route(`**/posts/${post.id}/likes?**`, (route) =>
    route.fulfill({
      json: {
        users: Array.from({ length: 80 }, (_, index) => ({
          id: `engager-${index}`,
          username: `reader-${index}`,
          name: { displayName: `Reader ${index}` },
        })),
        hasMore: false,
        totalCount: 80,
      },
    }),
  );
});

test('likes split the post bounds, scroll independently and close without remounting the post', async ({
  page,
  candidate,
}) => {
  await page.goto(`/p/${post.id}`);
  const group = page.getByTestId('mention-shell-panels-main');
  const content = page.getByTestId('mention-shell-panels-main-content');
  const screen = content.getByTestId('post-screen');
  await expect(screen).toBeVisible();
  await screen.evaluate((node) => node.setAttribute('data-original-post', 'true'));
  await content.getByText('likes', { exact: true }).click();
  const likes = page.getByTestId('mention-shell-panels-main-engagement');
  await expect(likes.getByRole('heading', { name: 'Likes', exact: true })).toBeVisible();
  await expect(screen).toHaveAttribute('data-original-post', 'true');
  await expect
    .poll(async () => {
      const top = await content.boundingBox();
      const bottom = await likes.boundingBox();
      if (!top || !bottom) return false;
      return (
        Math.abs(top.height - bottom.height) <= 2 &&
        Math.abs(bottom.y - top.y - top.height - 8) <= 1 &&
        bottom.y + bottom.height <= 900
      );
    })
    .toBe(true);
  const postOwner = screen.locator('[data-bloom-screen-viewport="element"]');
  const listOwner = likes.locator('[data-bloom-screen-viewport="element"]');
  await expect(listOwner).toHaveCount(1);
  const postOffset = await postOwner.evaluate((node) => node.scrollTop);
  await listOwner.hover();
  await page.mouse.wheel(0, 350);
  await expect.poll(() => listOwner.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  expect(await postOwner.evaluate((node) => node.scrollTop)).toBe(postOffset);
  const divider = group.getByRole('separator').first();
  await divider.focus();
  const before = await content.boundingBox();
  await divider.press('ArrowUp');
  await expect
    .poll(async () => (await content.boundingBox())?.height ?? 0)
    .toBeLessThan(before?.height ?? 0);
  const topStop = await divider.boundingBox();
  if (!topStop) throw new Error('Split divider has no pointer target');
  await page.mouse.move(topStop.x + topStop.width / 2, topStop.y + topStop.height / 2);
  await page.mouse.down();
  await page.mouse.move(topStop.x + topStop.width / 2, 10, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await content.boundingBox())?.height ?? 0).toBeCloseTo(160, 0);
  const bottomStop = await divider.boundingBox();
  if (!bottomStop) throw new Error('Split divider disappeared after resizing');
  await page.mouse.move(bottomStop.x + bottomStop.width / 2, bottomStop.y + bottomStop.height / 2);
  await page.mouse.down();
  await page.mouse.move(bottomStop.x + bottomStop.width / 2, 890, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await likes.boundingBox())?.height ?? 0).toBeCloseTo(160, 0);
  const closeFromMinimum = await divider.boundingBox();
  if (!closeFromMinimum) throw new Error('Split divider disappeared before closing');
  await page.mouse.move(
    closeFromMinimum.x + closeFromMinimum.width / 2,
    closeFromMinimum.y + closeFromMinimum.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(closeFromMinimum.x + closeFromMinimum.width / 2, 10, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await content.boundingBox())?.height ?? 0).toBeCloseTo(160, 0);
  const closingFrames = likes.evaluate(
    (panel) =>
      new Promise<number[]>((resolve) => {
        const positions: number[] = [];
        const started = performance.now();
        const sample = (time: number) => {
          const box = panel.getBoundingClientRect();
          if (box.width > 1 && box.height > 1) positions.push(box.x);
          if (time - started < 700) requestAnimationFrame(sample);
          else resolve(positions);
        };
        requestAnimationFrame(sample);
      }),
  );
  await likes.getByRole('button', { name: 'Close', exact: true }).click();
  const horizontalPositions = await closingFrames;
  expect(horizontalPositions.length).toBeGreaterThan(1);
  expect(Math.max(...horizontalPositions) - Math.min(...horizontalPositions)).toBeLessThanOrEqual(
    1,
  );
  await expect(likes).toBeHidden();
  await expect(likes.locator('[role="heading"]')).toHaveCount(0);
  await expect(screen).toHaveAttribute('data-original-post', 'true');
  await expect(postOwner).toHaveCount(0);
  await expect.poll(async () => (await content.boundingBox())?.height ?? 0).toBeGreaterThan(850);
  expect(candidate.scriptErrors).toEqual([]);
});

test('phone likes use one bottom sheet and leave the post mounted', async ({ page, candidate }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/p/${post.id}`);
  const screen = page.getByTestId('post-screen');
  await expect(screen).toBeVisible();
  await screen.evaluate((node) => node.setAttribute('data-original-post', 'true'));
  await screen.getByText('likes', { exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Likes', exact: true });
  await expect(sheet).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Likes', exact: true })).toHaveCount(1);
  await expect(screen).toHaveAttribute('data-original-post', 'true');
  await sheet.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(sheet).toBeHidden();
  await expect(screen).toHaveAttribute('data-original-post', 'true');
  expect(candidate.scriptErrors).toEqual([]);
});

test('two Deck columns keep independent engagement panels and retain their reorder grips', async ({
  page,
  candidate,
}) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.addInitScript((postId) => {
    const order = ['custom-a', 'custom-b'];
    const state = {
      syncEnabled: false,
      order,
      panels: Object.fromEntries(
        order.map((id) => [
          id,
          {
            source: 'explore',
            width: 390,
            resizable: true,
            appearance: 'solid',
            navigation: { entries: [{ key: 'root', name: `/p/${postId}` }], index: 0 },
          },
        ]),
      ),
    };
    localStorage.setItem(
      'mention:deck:workspace',
      JSON.stringify({
        version: 1,
        state: {
          records: {
            anonymous: { state, base: null, revision: 0, dirty: false },
          },
        },
      }),
    );
  }, post.id);
  await page.goto('/deck');
  const first = page.getByTestId('mention-shell-panels-custom-a');
  const second = page.getByTestId('mention-shell-panels-custom-b');
  await expect(first.getByTestId('post-screen')).toBeVisible();
  await expect(second.getByTestId('post-screen')).toBeVisible();
  await expect(page.getByTestId('mention-shell-panels-custom-a-reorder')).toBeVisible();
  await first.getByText('likes', { exact: true }).click();
  await second.getByText('likes', { exact: true }).click();
  const firstList = page.getByTestId('mention-shell-panels-custom-a-engagement');
  const secondList = page.getByTestId('mention-shell-panels-custom-b-engagement');
  await expect(firstList.getByRole('heading', { name: 'Likes', exact: true })).toBeVisible();
  await expect(secondList.getByRole('heading', { name: 'Likes', exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const upper = await page.getByTestId('mention-shell-panels-custom-a-content').boundingBox();
      const lower = await firstList.boundingBox();
      return upper && lower ? lower.y - upper.y - upper.height : -1;
    })
    .toBeCloseTo(8, 0);
  const divider = first.locator('[role="separator"][aria-orientation="horizontal"]');
  const handle = await divider.boundingBox();
  if (!handle) throw new Error('Deck split divider has no pointer target');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, 10, { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        (await page.getByTestId('mention-shell-panels-custom-a-content').boundingBox())?.height ??
        0,
    )
    .toBeCloseTo(160, 0);
  await firstList.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(firstList).toBeHidden();
  await expect(firstList.locator('[role="heading"]')).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await page.getByTestId('mention-shell-panels-custom-a-content').boundingBox())?.height ??
        0,
    )
    .toBeCloseTo((await first.boundingBox())?.height ?? 0, 0);
  await expect(secondList.getByRole('heading', { name: 'Likes', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  expect(candidate.scriptErrors).toEqual([]);
});

test('the normal post keeps its viewport mask and document reading position through a split', async ({
  page,
  candidate,
}) => {
  const longPost = {
    ...post,
    content: {
      text: Array.from(
        { length: 24 },
        (_, index) =>
          `Paragraph ${index + 1}. Keep the normal document scroll and its rounded viewport mask while reading this post.`,
      ).join('\n\n'),
    },
  };
  await page.route(`**/feed/item/${post.id}`, (route) => route.fulfill({ json: longPost }));
  await page.goto(`/p/${post.id}`);
  const content = page.getByTestId('mention-shell-panels-main-content');
  const screen = content.getByTestId('post-screen');
  const mask = content.locator('[data-bloom-panel-mask="viewport"]');
  await expect(screen).toBeVisible();
  await expect(mask).toHaveCount(1);
  const initialMask = await mask.boundingBox();
  expect(initialMask).not.toBeNull();
  await screen.evaluate((node) => node.setAttribute('data-original-post', 'true'));
  await screen.hover();
  const initialOffset = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 240);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(initialOffset + 200);
  const readingOffset = await page.evaluate(() => window.scrollY);
  await expect
    .poll(async () => (await mask.boundingBox())?.y ?? -1000)
    .toBeCloseTo(initialMask?.y ?? 0, 0);
  // Preserve the established reading offset rather than scrolling the counter into view.
  await screen.getByText('likes', { exact: true }).evaluate((node: HTMLElement) => node.click());
  const likes = page.getByTestId('mention-shell-panels-main-engagement');
  await expect(likes.getByRole('heading', { name: 'Likes', exact: true })).toBeVisible();
  await expect(screen).toHaveAttribute('data-original-post', 'true');
  const bounded = screen.locator('[data-bloom-screen-viewport="element"]');
  await expect.poll(() => bounded.evaluate((node) => node.scrollTop)).toBeCloseTo(readingOffset, 0);
  await likes.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(likes).toBeHidden();
  await expect(likes.locator('[role="heading"]')).toHaveCount(0);
  await expect(screen).toHaveAttribute('data-original-post', 'true');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(readingOffset, 0);
  await expect(mask).toHaveCount(1);
  await expect
    .poll(async () => (await mask.boundingBox())?.y ?? -1000)
    .toBeCloseTo(initialMask?.y ?? 0, 0);
  expect(candidate.scriptErrors).toEqual([]);
});

test('a short desktop window presents likes as a sheet instead of violating split minimums', async ({
  page,
  candidate,
}) => {
  await page.setViewportSize({ width: 1440, height: 300 });
  await page.goto(`/p/${post.id}`);
  const screen = page.getByTestId('post-screen');
  await expect(screen).toBeVisible();
  await screen.getByText('likes', { exact: true }).evaluate((node: HTMLElement) => node.click());
  const sheet = page.getByRole('dialog', { name: 'Likes', exact: true });
  await expect(sheet).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Likes', exact: true })).toHaveCount(1);
  await expect(screen.locator('[data-bloom-screen-viewport="element"]')).toHaveCount(1);
  await sheet.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(sheet).toBeHidden();
  await expect(screen.locator('[data-bloom-screen-viewport="document"]')).toHaveCount(1);
  expect(candidate.scriptErrors).toEqual([]);
});

test('normal and Deck preserve the post through continuous visible width transitions', async ({
  page,
  candidate,
}) => {
  await page.goto(`/p/${post.id}`);
  const screen = page.getByTestId('post-screen');
  await expect(screen).toBeVisible();
  await screen.evaluate((node) => node.setAttribute('data-retained-post', 'true'));
  await page
    .getByRole('button', { name: 'Deck mode', exact: true })
    .evaluate((node) => node.setAttribute('data-deck-transition-trigger', 'true'));
  const transitions = await page.evaluate(async () => {
    const main = document.querySelector('[data-testid="mention-shell-panels-main"]');
    const retained = document.querySelector('[data-testid="post-screen"]');
    const button = document.querySelector<HTMLElement>('[data-deck-transition-trigger]');
    if (!main || !retained || !button) throw new Error('Post or Deck control was not mounted');
    const record = () =>
      new Promise<Array<{ time: number; width: number; opacity: number; retained: boolean }>>(
        (resolve) => {
          const frames: Array<{ time: number; width: number; opacity: number; retained: boolean }> =
            [];
          const started = performance.now();
          const sample = (now: number) => {
            let opacity = 1;
            let node: Element | null = retained;
            while (node) {
              opacity *= Number(getComputedStyle(node).opacity);
              node = node.parentElement;
            }
            frames.push({
              time: now - started,
              width: main.getBoundingClientRect().width,
              opacity,
              retained:
                retained.isConnected &&
                document.querySelector('[data-testid="post-screen"]') === retained,
            });
            if (now - started < 1000) requestAnimationFrame(sample);
            else resolve(frames);
          };
          requestAnimationFrame(sample);
          button.click();
        },
      );
    return [await record(), await record()];
  });
  for (const frames of transitions) {
    expect(frames.every((frame) => frame.retained && frame.opacity >= 0.99)).toBe(true);
    expect(frames.filter((frame) => frame.width > 391 && frame.width < 619).length).toBeGreaterThan(
      2,
    );
    for (let index = 1; index < frames.length; index += 1) {
      const previous = frames[index - 1];
      const current = frames[index];
      // Account for dropped frames; a hard max-width clamp used to jump 141px in 17ms.
      const pixelsPerMillisecond =
        Math.abs(current.width - previous.width) / Math.max(1, current.time - previous.time);
      expect(pixelsPerMillisecond).toBeLessThan(3.5);
    }
  }
  await expect(screen).toHaveAttribute('data-retained-post', 'true');
  expect(candidate.scriptErrors).toEqual([]);
});
