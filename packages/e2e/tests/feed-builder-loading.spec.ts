import { contractTest as test, expect } from '../fixtures';

const post = {
  id: '11111111-1111-4111-8111-111111111111',
  user: {
    id: 'builder-fixture-author',
    username: 'builder-fixture',
    name: { displayName: 'Author' },
  },
  authors: [],
  attachments: {},
  documents: [],
  content: { text: 'A feed row for the builder loading test' },
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

for (const viewport of [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
]) {
  test(`${viewport.name}: the feed builder loads on demand with a header and skeleton`, async ({
    page,
    candidate,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.route('**/feed/mtn?**', (route) =>
      route.fulfill({ json: { items: [post], hasMore: false } }),
    );
    const builderRequests: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/FeedBuilder-[0-9a-f]{32}\.js$/, async (route) => {
      builderRequests.push(route.request().url());
      await gate;
      await route.fallback();
    });

    try {
      await page.goto('/');
      await expect(page.getByText(post.content.text, { exact: true })).toBeVisible();
      expect(builderRequests).toEqual([]);

      await page.goto('/feeds/new', { waitUntil: 'domcontentloaded' });
      await expect.poll(() => builderRequests.length).toBe(1);
      await expect(page.getByText('New feed', { exact: true })).toBeVisible();
      await expect(page.getByTestId('form-skeleton')).toBeVisible();
    } finally {
      release();
    }

    await expect(page.getByText('Sign in to build a feed', { exact: true })).toBeVisible();
    expect(candidate.scriptErrors).toEqual([]);
  });
}
