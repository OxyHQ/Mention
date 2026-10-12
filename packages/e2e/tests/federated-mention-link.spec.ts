import { expect, test } from '../fixtures';

test('an unresolved federated mention opens its source profile and resolved mentions retain local navigation', async ({
  page,
  context,
  candidate,
}) => {
  // The reported Forbes post links to a Flipboard Group whose human profile
  // URL cannot be reconstructed from its actor URI.
  const id = '01a115bf-2135-7f51-8656-1b3a4ed7bde9';
  const sourceUrl = 'https://flipboard.com/@forbes/leadership-bs0je34pz';
  await page.route(`**/feed/item/${id}`, (route) =>
    route.fulfill({
      json: {
        id,
        type: 'post',
        user: {
          id: 'mention-fixture-forbes',
          username: 'forbes@flipboard.com',
          name: { displayName: 'Forbes' },
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
          text: `As AI Gets Better At Answers, Human Questions May Matter More\n\nPosted into Leadership [@@leadership-forbes](${sourceUrl})\nWith [@Nate](nate)`,
        },
        metadata: {
          visibility: 'public',
          status: 'published',
          createdAt: '2026-10-07T07:00:00.000Z',
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
  // Keep actual new-tab navigation independent of the remote site's availability.
  await context.route(sourceUrl, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Leadership source profile</title>' }),
  );
  await page.goto(`/p/${id}`);
  const mention = page.getByRole('link', { name: '@leadership-forbes', exact: true });
  await expect(mention).toBeVisible();
  const opened = context.waitForEvent('page');
  await mention.click();
  const destination = await opened;
  await expect(destination).toHaveURL(sourceUrl);
  await expect(destination).toHaveTitle('Leadership source profile');
  await expect(page).toHaveURL(new RegExp(`/p/${id}$`));
  await destination.close();

  const localMention = page.getByRole('link', { name: 'Nate', exact: true });
  await expect(localMention).toHaveAttribute('href', '/@nate');
  await localMention.click();
  await expect(page).toHaveURL(/\/@nate$/);
  expect(candidate.scriptErrors).toEqual([]);
});
