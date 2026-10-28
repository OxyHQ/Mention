import { expect, contractTest as test } from '../fixtures';

const id = '01a15043-f124-792e-8f2b-aa57ebcbb503';

test('composer bold renders with Bloom while mentions keep their internal destination', async ({
  page,
  candidate,
}) => {
  await page.route(`**/feed/item/${id}`, (route) =>
    route.fulfill({
      json: {
        id,
        type: 'post',
        user: {
          id: 'markdown-fixture-author',
          username: 'markdown-fixture',
          name: { displayName: 'Markdown fixture' },
        },
        authors: [],
        attachments: {},
        documents: [],
        documentsPending: false,
        viewerState: {
          isOwner: false,
          isCollaborator: false,
          isLiked: false,
          isDownvoted: false,
          isBoosted: false,
          isSaved: false,
        },
        content: {
          text: 'Meet **Deck**. Your social world, **your way**. With [@Allo](allo).',
        },
        metadata: {
          visibility: 'public',
          status: 'published',
          createdAt: '2026-10-18T12:00:00.000Z',
        },
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
  const bold = page.getByText('your way', { exact: true });
  await expect(bold).toBeVisible();
  await expect(bold).toHaveCSS('font-weight', '600');
  await expect(page.getByText('**your way**', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Allo', exact: true })).toHaveAttribute(
    'href',
    '/@allo',
  );
  expect(candidate.scriptErrors).toEqual([]);
});
