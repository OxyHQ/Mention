import { expect, contractTest as test } from '../fixtures';

const postId = '01a15043-f124-792e-8f2b-aa57ebcbb503';
const articleTitle = 'A controlled article';
const articleUrl = 'https://example.test/article-link';
const articleBody = `Controlled article body ${articleUrl} ${Array.from(
  { length: 180 },
  (_, index) => `line ${index} sample text for scrolling and selection. `,
).join('')}`;

test('article reader accepts pointer, scrolling, selection, links and dismissal', async ({
  page,
  candidate,
}) => {
  await page.addInitScript(() => {
    const audit = window as typeof window & { articleOpened: string[][] };
    audit.articleOpened = [];
    window.open = (url, target, features) => {
      audit.articleOpened.push([String(url), String(target), String(features)]);
      return null;
    };
  });
  await page.route(`**/feed/item/${postId}`, (route) =>
    route.fulfill({
      json: {
        id: postId,
        type: 'post',
        user: {
          id: 'article-fixture-author',
          username: 'article-fixture',
          name: { displayName: 'Article fixture' },
        },
        authors: [],
        attachments: {
          article: { articleId: 'article-fixture', title: articleTitle, body: articleBody },
        },
        documents: [],
        viewerState: {
          isOwner: false,
          isCollaborator: false,
          isLiked: false,
          isDownvoted: false,
          isBoosted: false,
          isSaved: false,
        },
        content: { text: 'A post with an article' },
        metadata: {
          visibility: 'public',
          status: 'published',
          createdAt: '2026-10-18T12:00:00.000Z',
        },
        engagement: { likes: 0, downvotes: 0, replies: 0, boosts: 0, views: 0 },
      },
    }),
  );
  await page.route('**/stickers/resolve', (route) => route.fulfill({ json: { stickers: [] } }));
  await page.goto(`/p/${postId}`);

  const card = page.getByText(articleTitle, { exact: true }).first();
  const close = page.getByRole('button', { name: 'Close', exact: true }).first();
  const openReader = async () => {
    await card.click();
    await expect(close).toBeVisible();
  };
  await openReader();
  const link = page.getByText(articleUrl, { exact: true }).last();
  await link.click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { articleOpened: string[][] }).articleOpened),
    )
    .toEqual([[articleUrl, '_blank', 'noopener,noreferrer']]);
  await expect(close).toBeVisible();

  const body = page.getByText('Controlled article body', { exact: false }).last();
  const box = await body.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error('Article body is not laid out');
  await page.mouse.click(box.x + 15, box.y + 10);
  await expect(close).toBeVisible();
  await page.mouse.move(box.x + 15, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 240, box.y + 10, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => String(window.getSelection()).length))
    .toBeGreaterThan(0);
  await expect(close).toBeVisible();

  const scrollTop = () =>
    body.evaluate((element) => {
      for (let node: HTMLElement | null = element as HTMLElement; node; node = node.parentElement) {
        if (
          node.scrollHeight > node.clientHeight &&
          /(auto|scroll)/.test(getComputedStyle(node).overflowY)
        ) {
          return node.scrollTop;
        }
      }
      return null;
    });
  expect(await scrollTop()).toBe(0);
  await page.mouse.move(box.x + 30, Math.min(box.y + 70, 700));
  await page.mouse.wheel(0, 600);
  await expect.poll(scrollTop).toBeGreaterThan(0);
  await expect(close).toBeVisible();

  await close.click();
  await expect(close).toBeHidden();
  await openReader();
  // The rounded top corner is outside the panel and hits the backdrop.
  await page.mouse.click(2, 2);
  await expect(close).toBeHidden();
  await openReader();
  await close.focus();
  await page.keyboard.press('Enter');
  await expect(close).toBeHidden();

  expect(candidate.servedPaths.some((path) => path.includes('/PostArticleModal-'))).toBe(true);
  expect(candidate.scriptErrors).toEqual([]);
});
