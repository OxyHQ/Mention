import { expect, contractTest as test } from '../fixtures';

const originalId = '11111111-1111-4111-8111-111111111111';
const quoteId = '22222222-2222-4222-8222-222222222222';
const original = {
  id: originalId,
  user: {
    id: 'quote-fixture-author',
    username: 'quote-fixture',
    name: { displayName: 'Original author' },
  },
  authors: [],
  attachments: {},
  documents: [],
  content: { text: 'Original quote fixture body' },
  metadata: { visibility: 'public', createdAt: '2026-10-23T08:00:00.000Z' },
  engagement: { likes: 0, downvotes: 0, replies: 0, boosts: 0, views: 0 },
  viewerState: {
    isOwner: false,
    isCollaborator: false,
    isLiked: false,
    isDownvoted: false,
    isBoosted: false,
    isSaved: false,
  },
};
const quote = {
  ...original,
  id: quoteId,
  user: {
    id: 'quote-fixture-writer',
    username: 'quote-writer',
    name: { displayName: 'Quote writer' },
  },
  content: { text: 'Distinct quote commentary fixture' },
  quotedPost: original,
};

test('a quote keeps its commentary and opens its embedded original even when already shown', async ({
  page,
  candidate,
}) => {
  await page.route('**/feed/mtn?**', (route) =>
    route.fulfill({ json: { items: [original, quote], hasMore: false } }),
  );
  await page.route(`**/feed/item/${originalId}`, (route) => route.fulfill({ json: original }));
  await page.route(`**/feed/replies/${originalId}**`, (route) =>
    route.fulfill({ json: { items: [], hasMore: false } }),
  );
  await page.route(`**/statistics/post/${originalId}/view`, (route) =>
    route.fulfill({ json: { viewsCount: 1 } }),
  );
  await page.goto('/');
  const quoteRow = page.locator('[data-post-uri]').filter({ hasText: quote.content.text });
  await expect(quoteRow.getByText(quote.content.text, { exact: true })).toBeVisible();
  const embeddedOriginal = quoteRow.getByText(original.content.text, { exact: true });
  await expect(embeddedOriginal).toBeVisible();
  await embeddedOriginal.click();
  await expect(page).toHaveURL(`/p/${originalId}`);
  await expect(page.getByText(original.content.text, { exact: true }).first()).toBeVisible();
  expect(candidate.scriptErrors).toEqual([]);
});

for (const kind of ['likedBy', 'boostedBy'] as const)
  test(`a supplied ${kind} reason opens its own engagement list without opening the row`, async ({
    page,
    candidate,
  }) => {
    const socialContext = { type: kind, postId: quoteId, actors: [original.user], total: 1 };
    await page.route('**/feed/mtn?**', (route) =>
      route.fulfill({
        json: {
          items: [quote],
          hasMore: false,
          slices: [
            {
              _sliceKey: quoteId,
              items: [
                {
                  post: quote,
                  isThreadParent: false,
                  isThreadChild: false,
                  isThreadLastChild: false,
                },
              ],
              isIncompleteThread: false,
              socialContext,
            },
          ],
        },
      }),
    );
    let engagementReads = 0;
    await page.route(
      `**/posts/${quoteId}/${kind === 'likedBy' ? 'likes' : 'boosts'}?**`,
      (route) => {
        engagementReads += 1;
        return route.fulfill({ json: { users: [], hasMore: false, total: 0 } });
      },
    );
    await page.goto('/');
    const reason = page.getByRole('button', {
      name: kind === 'likedBy' ? 'Liked by Original author' : 'Reposted by Original author',
      exact: true,
    });
    await expect(reason).toBeVisible();
    expect(engagementReads).toBe(0);
    await reason.click();
    await expect.poll(() => engagementReads).toBe(1);
    await expect(page).toHaveURL('/');
    expect(candidate.scriptErrors).toEqual([]);
  });
