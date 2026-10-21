import { expect, test } from '../fixtures';

const id = '01a115bf-2135-7f51-8656-1b3a4ed7bde9';
const sourceUrl = 'https://flipboard.com/@forbes/leadership-bs0je34pz';
const resolutionPath = `/mention?uri=${encodeURIComponent(sourceUrl)}`;

// A Group's human profile URL cannot be reconstructed from its actor URI or label.
test.beforeEach(async ({ page }) => {
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
});

test('a source mention resolves its canonical Oxy identity inside the app and local mentions retain navigation', async ({
  page,
  context,
  candidate,
}) => {
  const canonicalHandle = 'canonical-leadership@flipboard.com';
  const queries: string[] = [];
  let openedPages = 0;
  context.on('page', () => {
    openedPages += 1;
  });
  await page.route('**/federation/resolve?**', (route) => {
    queries.push(new URL(route.request().url()).searchParams.get('handle') ?? '');
    return route.fulfill({
      json: {
        actor: {
          network: 'activitypub',
          externalId: 'https://flipboard.com/actor/opaque-group-id',
          handle: canonicalHandle,
          oxyUserId: 'fixture-canonical-group',
          followed: false,
        },
      },
    });
  });
  await page.route('https://api.oxy.so/profiles/resolve?**', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          id: 'fixture-canonical-group',
          username: canonicalHandle,
          type: 'federated',
          isFederated: true,
          name: { displayName: 'Canonical Leadership' },
          bio: 'Resolved from the source URL',
          redirectedUserIds: [],
        },
      },
    }),
  );
  await page.goto(`/p/${id}`);
  const mention = page.getByRole('link', { name: '@leadership-forbes', exact: true });
  await expect(mention).toHaveAttribute('href', resolutionPath);
  await mention.click();
  await expect(page).toHaveURL(new RegExp(`/@${canonicalHandle.replaceAll('.', '\\.')}$`));
  expect(queries).toEqual([sourceUrl]);
  expect(openedPages).toBe(0);
  expect(context.pages()).toHaveLength(1);

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/p/${id}$`));
  const localMention = page.getByRole('link', { name: 'Nate', exact: true });
  await expect(localMention).toHaveAttribute('href', '/@nate');
  await localMention.click();
  await expect(page).toHaveURL(/\/@nate$/);
  expect(candidate.scriptErrors).toEqual([]);
});

test('an unresolved source mention stays unavailable inside the app without guessing an identity or opening a tab', async ({
  page,
  context,
  candidate,
}) => {
  const queries: string[] = [];
  let openedPages = 0;
  context.on('page', () => {
    openedPages += 1;
  });
  await page.route('**/federation/resolve?**', (route) => {
    queries.push(new URL(route.request().url()).searchParams.get('handle') ?? '');
    // A handle alone is not a verified Oxy identity.
    return route.fulfill({
      json: {
        actor: {
          network: 'activitypub',
          externalId: 'https://flipboard.com/actor/opaque-group-id',
          handle: 'guessed-from-label@flipboard.com',
          followed: false,
        },
      },
    });
  });
  await page.goto(`/p/${id}`);
  await page.getByRole('link', { name: '@leadership-forbes', exact: true }).click();
  await expect(page.getByText('Profile not found', { exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/mention');
  expect(new URL(page.url()).searchParams.get('uri')).toBe(sourceUrl);
  expect(queries).toEqual([sourceUrl]);
  expect(openedPages).toBe(0);
  expect(context.pages()).toHaveLength(1);
  expect(candidate.scriptErrors).toEqual([]);
});
