import { expect, contractTest as test } from '../fixtures';

test('dragging post images scrolls the row without opening the viewer; clicking still opens it', async ({
  page,
  candidate,
}) => {
  const id = 'c186e8a0-e9a5-4e84-9c97-15b285a78888';
  const media = ['red', 'blue', 'green', 'orange'].map((color, index) => ({
    id: `drag-fixture-${index}`,
    type: 'image',
    width: 400,
    height: 200,
    alt: `Carousel image ${index + 1}`,
    url: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="${color}"/></svg>`)}`,
  }));
  await page.route(`**/feed/item/${id}`, (route) =>
    route.fulfill({
      json: {
        id,
        type: 'post',
        user: {
          id: 'attachment-fixture-user',
          username: 'attachment-fixture',
          name: { displayName: 'Attachment Fixture' },
        },
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
        content: { text: 'Attachment carousel regression', media },
        metadata: { visibility: 'public', status: 'published', createdAt: '2026-01-01T00:00:00Z' },
        engagement: { likes: 0, downvotes: 0, replies: 0, boosts: 0, views: 0 },
      },
    }),
  );
  await page.route(`**/feed/replies/${id}**`, (route) =>
    route.fulfill({ json: { items: [], hasMore: false, totalCount: 0 } }),
  );
  await page.route(`**/statistics/post/${id}/view`, (route) =>
    route.fulfill({ json: { viewsCount: 1 } }),
  );
  await page.goto(`/p/${id}`);

  const image = page.locator('img[alt="Carousel image 1"]');
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0))
    .toBe(true);
  // Locate the actual RN Web scrolling host, not its inner content container.
  const scrollOffset = () =>
    image.evaluate((node) => {
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (
          getComputedStyle(parent).overflowX === 'auto' ||
          getComputedStyle(parent).overflowX === 'scroll'
        )
          return parent.scrollLeft;
      }
      throw new Error('image has no horizontal scroll host');
    });
  // Inspect the browser's actual window listeners: a mounted carousel must
  // subscribe to pointer movement only while its mouse gesture is active.
  const cdp = await page.context().newCDPSession(page);
  const windowListeners = async (): Promise<Record<string, number>> => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const listeners = getEventListeners(window);
        return Object.fromEntries(['blur', 'mouseup', 'mousemove'].map((type) => [type, (listeners[type] ?? []).length]));
      })()`,
      includeCommandLineAPI: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error('Could not inspect window listeners');
    return result.value as Record<string, number>;
  };
  const idleListeners = await windowListeners();
  const box = await image.boundingBox();
  if (!box) throw new Error('image has no layout');
  const x = box.x + Math.min(box.width - 20, 240);
  const y = box.y + box.height / 2;
  // Even a stationary press is cancelled when the window loses focus.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect.poll(windowListeners).toEqual({
    blur: idleListeners.blur + 1,
    mouseup: idleListeners.mouseup + 1,
    mousemove: idleListeners.mousemove + 1,
  });
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  await expect.poll(windowListeners).toEqual(idleListeners);
  await expect(page.getByRole('button', { name: 'Close media viewer', exact: true })).toHaveCount(
    0,
  );

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 150, y, { steps: 15 });
  await page.mouse.up();
  await expect.poll(scrollOffset).toBeGreaterThan(100);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
  await expect(page.getByRole('button', { name: 'Close media viewer', exact: true })).toHaveCount(
    0,
  );
  await expect(page).toHaveURL(new RegExp(`/p/${id}$`));

  // Releasing outside the row must also finish the gesture, so merely moving
  // back over it cannot keep scrolling the attachments.
  await page.mouse.move(box.x + 80, y);
  await page.mouse.down();
  await page.mouse.move(box.x - 30, y, { steps: 10 });
  await page.mouse.up();
  const releasedOffset = await scrollOffset();
  await page.mouse.move(box.x + 100, y, { steps: 5 });
  expect(await scrollOffset()).toBe(releasedOffset);

  // Losing the window while pressed cancels both scroll ownership and the tap.
  // Release on the same target so the browser still dispatches a click.
  await page.mouse.down();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.move(box.x + 99, y);
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Close media viewer', exact: true })).toHaveCount(
    0,
  );
  expect(await scrollOffset()).toBe(releasedOffset);

  // A fresh click after the drag must not remain suppressed.
  await page.mouse.click(box.x + 40, y);
  await expect(page.getByRole('button', { name: 'Close media viewer', exact: true })).toBeVisible();
  expect(candidate.scriptErrors).toEqual([]);
});
