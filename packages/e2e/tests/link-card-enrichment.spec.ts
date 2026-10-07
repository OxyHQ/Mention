import { expect, test } from '../fixtures';

test('a source URL card becomes a real article card when pending metadata arrives', async ({ page, candidate }) => {
  const id = '01a10e9f-dd51-72bd-9ddc-372e8b28c77b';
  const sourceUrl = 'https://www.kpbs.org/news/story';
  let releaseMetadata: (() => void) | undefined;
  const metadataReady = new Promise<void>((resolve) => { releaseMetadata = resolve; });
  await page.route(`**/feed/item/${id}`, (route) => route.fulfill({ json: {
    id, type: 'post',
    user: { id: 'link-fixture-user', username: 'link-fixture', name: { displayName: 'Link Fixture' } },
    authors: [], attachments: {}, documents: [], documentsPending: true,
    viewerState: { isOwner: false, isCollaborator: false, isLiked: false, isDownvoted: false, isBoosted: false, isSaved: false },
    content: { text: `Read this article ${sourceUrl}` },
    metadata: { visibility: 'public', status: 'published', createdAt: '2026-10-07T07:00:00.000Z' },
    engagement: { likes: 0, downvotes: 0, replies: 0, boosts: 0, views: 0 },
  } }));
  await page.route(`**/feed/replies/${id}**`, (route) => route.fulfill({ json: { items: [], hasMore: false, totalCount: 0 } }));
  await page.route(`**/statistics/post/${id}/view`, (route) => route.fulfill({ json: { viewsCount: 1 } }));
  await page.route('**/posts/documents', async (route) => {
    await metadataReady;
    await route.fulfill({ json: { posts: { [id]: { documents: [{
      id: 'document-fixture', requestedUrl: sourceUrl, canonicalUrl: 'https://www.npr.org/news/story',
      status: 'indexed', title: 'The fetched article title', description: 'The article summary returned by the indexing service.',
    }] } } } });
  });
  await page.goto(`/p/${id}`);
  const sourceCard = page.getByRole('link', { name: 'kpbs.org', exact: true });
  await expect(sourceCard).toBeVisible();
  await expect(page.getByRole('link', { name: 'The fetched article title', exact: true })).toHaveCount(0);
  releaseMetadata?.();
  await expect(page.getByRole('link', { name: 'The fetched article title', exact: true })).toBeVisible();
  await expect(page.getByText('The article summary returned by the indexing service.', { exact: true })).toBeVisible();
  await expect(sourceCard).toHaveCount(0);
  expect(candidate.scriptErrors).toEqual([]);
});
