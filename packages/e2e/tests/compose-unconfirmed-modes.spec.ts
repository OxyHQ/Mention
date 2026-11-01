import { installDraftFixture } from '../draftFixture';
import { APP_ORIGIN } from '../environment';
import { expect, test } from '../fixtures';

const notice =
  'Could not confirm the result. Check whether the change took effect before trying again.';
const originalText = 'Work to preserve';

for (const mode of ['post', 'reply', 'thread', 'scheduled', 'edit', 'server draft'] as const) {
  test(`${mode} retains work and gives a neutral warning on an unconfirmed response`, async ({
    page,
    context,
    candidate,
  }) => {
    expect(candidate.servedPaths).toBeDefined();
    await installDraftFixture(context, { seedDrafts: false });
    const headers = {
      'access-control-allow-origin': APP_ORIGIN,
      'access-control-allow-credentials': 'true',
    };
    await page.route('**/posts/fixture/edit-source', (route) =>
      route.fulfill({
        headers,
        json: {
          id: 'fixture',
          content: { text: originalText },
          mentions: [],
          mentionUsers: [],
          status: mode === 'server draft' ? 'draft' : 'published',
        },
      }),
    );
    const target =
      mode === 'reply'
        ? '/feed/reply'
        : mode === 'thread'
          ? '/posts/thread'
          : mode === 'edit' || mode === 'server draft'
            ? '/posts/fixture'
            : '/posts';
    const method = mode === 'edit' || mode === 'server draft' ? 'PUT' : 'POST';
    const requests: unknown[] = [];
    await page.route(`**${target}`, async (route) => {
      if (route.request().method() !== method) return route.fallback();
      requests.push(route.request().postDataJSON());
      await route.fulfill({
        status: 500,
        headers,
        json: { error: 'Synthetic unconfirmed result' },
      });
    });

    const params = new URLSearchParams();
    if (mode === 'reply') params.set('replyToPostId', 'fixture');
    if (mode === 'edit' || mode === 'server draft') params.set('editPostId', 'fixture');
    if (mode === 'thread') params.set('thread[0].text', 'Second thread entry');
    if (mode === 'scheduled')
      params.set('scheduledFor', new Date(Date.now() + 86_400_000).toISOString());
    await page.goto(`/compose?${params.toString()}`);
    const editor = page.getByPlaceholder("What's new?").first();
    await expect(editor).toBeVisible();
    if (mode === 'edit' || mode === 'server draft') await expect(editor).toHaveValue(originalText);
    else await editor.fill(originalText);
    await expect(page.getByTestId('compose-submit')).toBeEnabled();
    await page.getByTestId('compose-submit').click();
    const warning = page.getByText(notice, { exact: true });
    await expect(warning).toBeVisible();
    await expect(warning.locator('xpath=ancestor-or-self::*[@aria-live]').first()).toHaveAttribute(
      'aria-live',
      /polite|assertive/,
    );
    await expect(editor).toHaveValue(originalText);
    expect(requests).toHaveLength(1);
    if (mode === 'thread') expect((requests[0] as { posts: unknown[] }).posts).toHaveLength(2);
    if (mode === 'scheduled')
      expect((requests[0] as { scheduledFor?: string }).scheduledFor).toBeTruthy();
    expect(candidate.scriptErrors.filter((error) => error.startsWith('uncaught '))).toEqual([]);
  });
}
