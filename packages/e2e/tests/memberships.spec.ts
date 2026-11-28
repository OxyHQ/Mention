import { expect, contractTest as test } from '../fixtures';

const communityId = '123e4567-e89b-42d3-a456-426614174000';

for (const path of ['/memberships', '/memberships/create']) {
  test(`anonymous ${path} loads its route and requires sign-in`, async ({ page, candidate }) => {
    await page.goto(path);
    await expect(page.getByText('Sign in to join a community', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Only authorized members can read community posts and files.', {
        exact: true,
      }),
    ).toBeVisible();
    expect(candidate.scriptErrors).toEqual([]);
  });
}

test('a public membership landing renders the server envelope through the real SDK without fetching private content', async ({
  page,
  candidate,
}) => {
  let landingReads = 0;
  await page.route(`**/membership-communities/${communityId}/landing`, (route) => {
    landingReads += 1;
    return route.fulfill({
      json: {
        data: {
          community: {
            id: communityId,
            ownerOxyUserId: 'membership-fixture-owner',
            slug: 'membership-fixture',
            name: 'Fixture community',
            description: 'Public community description',
            visibility: 'public',
            status: 'active',
            createdAt: '2026-10-28T00:00:00.000Z',
            updatedAt: '2026-10-28T00:00:00.000Z',
          },
          tiers: [
            {
              id: 'reader-tier',
              communityId,
              name: 'Reader pass',
              description: 'Read updates and vote on community decisions.',
              kind: 'free',
              status: 'active',
              benefits: ['content_read', 'polls_vote'],
            },
          ],
          membership: null,
          canManage: false,
          viewerBenefits: [],
          paidSubscriptionsAvailable: false,
        },
      },
    });
  });
  await page.route(`**/membership-communities/${communityId}/directory`, (route) =>
    route.fulfill({ json: { data: [] } }),
  );
  // The opt-in public directory is allowed; private content, reports and
  // mutations have no fixtures and the contract guard must reject them.
  await page.goto(`/memberships/${communityId}`);
  await expect(page.getByText('Fixture community', { exact: true })).toBeVisible();
  await expect(page.getByText('Public community description', { exact: true })).toBeVisible();
  await expect(page.getByText('Reader pass', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Read updates and vote on community decisions.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Read member content', { exact: true })).toBeVisible();
  await expect(page.getByText('Vote in polls', { exact: true })).toBeVisible();
  await expect(page.getByText('Download private files', { exact: true })).toHaveCount(0);

  await expect(page.getByText('Sign in to join a community', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Join free', exact: true })).toHaveCount(0);
  expect(landingReads).toBe(1);
  expect(candidate.scriptErrors).toEqual([]);
});
