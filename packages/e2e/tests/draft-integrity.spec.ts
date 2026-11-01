import type { Page } from '@playwright/test';
import { DRAFT_KEY, installDraftFixture, type FixtureDraft } from '../draftFixture';
import { APP_ORIGIN } from '../environment';
import { expect, test } from '../fixtures';

async function openDraft(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: 'Open drafts and scheduled posts' }).click();
  const row = page.getByRole('button', { name: 'Continue writing' }).filter({ hasText: text });
  await expect(row).toBeVisible();
  await row.click();
  await expect(row).toBeHidden();
}

async function storedDrafts(page: Page): Promise<FixtureDraft[]> {
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? '[]') as FixtureDraft[],
    DRAFT_KEY,
  );
}

async function setWriteFailure(page: Page, fail: boolean): Promise<void> {
  await page.evaluate((value) => {
    (window as typeof window & { __failDraftWrites?: boolean }).__failDraftWrites = value;
  }, fail);
}

async function holdPublication(
  page: Page,
): Promise<{ started: Promise<void>; release: () => void; payload: () => unknown }> {
  let markStarted!: () => void;
  let release!: () => void;
  let body: unknown;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/posts', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    body = route.request().postDataJSON();
    markStarted();
    await gate;
    await route.fulfill({
      json: { success: true, post: null },
      headers: {
        'access-control-allow-origin': APP_ORIGIN,
        'access-control-allow-credentials': 'true',
      },
    });
  });
  return { started, release, payload: () => body };
}

test.beforeEach(async ({ context, candidate }) => {
  // Requiring this fixture routes every app asset from the candidate export.
  expect(candidate.servedPaths).toBeDefined();
  await installDraftFixture(context);
});

test.afterEach(async ({ candidate }) => {
  // Storage failures and revision conflicts are intentionally logged by the
  // app in these tests, but none should escape as an uncaught script error.
  expect(candidate.scriptErrors.filter((error) => error.startsWith('uncaught '))).toEqual([]);
});

test('keeps an edit when switching drafts and when selecting the current draft', async ({
  page,
  candidate,
}) => {
  await page.goto('/compose');
  const editor = page.getByPlaceholder("What's new?");
  await expect(editor).toBeVisible();
  await openDraft(page, 'Draft A original');
  await editor.fill('Draft A edited');
  await editor.evaluate((element: HTMLTextAreaElement) => {
    element.focus();
    element.setSelectionRange(2, 7);
  });
  await openDraft(page, 'Draft A original');
  await expect(editor).toHaveValue('Draft A edited');
  await expect
    .poll(() =>
      editor.evaluate((element: HTMLTextAreaElement) => [
        element.selectionStart,
        element.selectionEnd,
      ]),
    )
    .toEqual([2, 7]);
  await openDraft(page, 'Draft B original');
  await expect(editor).toHaveValue('Draft B original');
  await expect
    .poll(async () => (await storedDrafts(page)).find((draft) => draft.id === 'a')?.postContent)
    .toBe('Draft A edited');
  expect(candidate.scriptErrors).toEqual([]);
});

test('keeps the old editor and selection after a failed switch, then recovers', async ({
  page,
}) => {
  await page.goto('/compose');
  const editor = page.getByPlaceholder("What's new?");
  await expect(editor).toBeVisible();
  await openDraft(page, 'Draft A original');
  await setWriteFailure(page, true);
  const writeIsBlocked = await page.evaluate((key) => {
    try {
      localStorage.setItem(key, localStorage.getItem(key) ?? '[]');
      return false;
    } catch {
      return true;
    }
  }, DRAFT_KEY);
  expect(writeIsBlocked).toBe(true);
  await editor.fill('Unsaved A');
  await editor.evaluate((element: HTMLTextAreaElement) => {
    element.focus();
    element.setSelectionRange(2, 6);
  });
  const error = page.getByRole('alert').filter({ hasText: "Couldn't save the draft" });
  await expect(error).toBeVisible();
  await openDraft(page, 'Draft B original');
  await expect(editor).toHaveValue('Unsaved A');
  await expect(error).toBeVisible();
  await expect
    .poll(() =>
      editor.evaluate((element: HTMLTextAreaElement) => [
        element.selectionStart,
        element.selectionEnd,
      ]),
    )
    .toEqual([2, 6]);
  await setWriteFailure(page, false);
  await page.getByRole('button', { name: 'Retry saving draft' }).click();
  await expect(error).toBeHidden();
  await expect
    .poll(async () => (await storedDrafts(page)).find((draft) => draft.id === 'a')?.postContent)
    .toBe('Unsaved A');
  await openDraft(page, 'Draft B original');
  await expect(editor).toHaveValue('Draft B original');
});

test('preserves both versions when a revision conflict is saved as a copy', async ({ page }) => {
  await page.goto('/compose');
  const editor = page.getByPlaceholder("What's new?");
  await expect(editor).toBeVisible();
  await openDraft(page, 'Draft A original');
  await editor.fill('First A edit');
  await expect
    .poll(async () => (await storedDrafts(page)).find((draft) => draft.id === 'a')?.postContent)
    .toBe('First A edit');
  // A separately completed write changes the revision. Atomicity across tabs is
  // outside this test; concurrency inside one runtime is covered by hook tests.
  await page.evaluate((key) => {
    const drafts = JSON.parse(localStorage.getItem(key) ?? '[]') as FixtureDraft[];
    const draft = drafts.find((entry) => entry.id === 'a');
    if (!draft) throw new Error('Fixture draft missing');
    draft.postContent = 'Other writer';
    draft.localRevision = (draft.localRevision ?? 0) + 1;
    localStorage.setItem(key, JSON.stringify(drafts));
  }, DRAFT_KEY);
  await editor.fill('My unsaved A');
  const conflict = page.getByRole('alert').filter({ hasText: 'This draft changed elsewhere' });
  await expect(conflict).toBeVisible();
  await expect(editor).toHaveValue('My unsaved A');
  await page.getByRole('button', { name: 'Save as copy' }).click();
  await expect(conflict).toBeHidden();
  await expect
    .poll(async () =>
      (await storedDrafts(page)).some(
        (draft) => draft.id !== 'a' && draft.postContent === 'My unsaved A',
      ),
    )
    .toBe(true);
  expect((await storedDrafts(page)).find((draft) => draft.id === 'a')?.postContent).toBe(
    'Other writer',
  );
});

test('no other draft opens while A is publishing, and B stays stored', async ({ page }) => {
  await page.goto('/compose');
  const editor = page.getByPlaceholder("What's new?");
  await expect(editor).toBeVisible();
  await openDraft(page, 'Draft A original');
  const publication = await holdPublication(page);
  try {
    await page.getByTestId('compose-submit').click();
    await publication.started;
    // Opening B now would save the editor into A's session, which the
    // publish then deletes.
    await expect(
      page.getByRole('button', { name: 'Open drafts and scheduled posts' }),
    ).toBeDisabled();
    publication.release();
    await expect
      .poll(async () => {
        const drafts = await storedDrafts(page);
        return {
          a: drafts.some((draft) => draft.id === 'a'),
          b: drafts.find((draft) => draft.id === 'b')?.postContent,
        };
      })
      .toEqual({ a: false, b: 'Draft B original' });
    expect(publication.payload()).toMatchObject({ content: { text: 'Draft A original' } });
  } finally {
    publication.release();
  }
});

test('publishing A retains text edited after submission in a separate draft', async ({ page }) => {
  await page.goto('/compose');
  const editor = page.getByPlaceholder("What's new?");
  await expect(editor).toBeVisible();
  await openDraft(page, 'Draft A original');
  const publication = await holdPublication(page);
  try {
    await page.getByTestId('compose-submit').click();
    await publication.started;
    await editor.fill('Later work');
    publication.release();
    await expect
      .poll(async () =>
        (await storedDrafts(page)).some(
          (draft) => draft.id !== 'a' && draft.postContent === 'Later work',
        ),
      )
      .toBe(true);
    await expect(editor).toHaveValue('Later work');
    expect(publication.payload()).toMatchObject({ content: { text: 'Draft A original' } });
  } finally {
    publication.release();
  }
});

test('publishing a conflicted draft does not remove a copy saved during the request', async ({
  page,
}) => {
  await page.goto('/compose');
  const editor = page.getByPlaceholder("What's new?");
  await expect(editor).toBeVisible();
  await openDraft(page, 'Draft A original');
  await page.evaluate((key) => {
    const drafts = JSON.parse(localStorage.getItem(key) ?? '[]') as FixtureDraft[];
    const draft = drafts.find((entry) => entry.id === 'a');
    if (!draft) throw new Error('Fixture draft missing');
    draft.postContent = 'Other writer';
    draft.localRevision = 1;
    localStorage.setItem(key, JSON.stringify(drafts));
  }, DRAFT_KEY);
  await editor.fill('Published version');
  const copy = page.getByRole('button', { name: 'Save as copy' });
  await expect(copy).toBeVisible();
  const publication = await holdPublication(page);
  try {
    await page.getByTestId('compose-submit').click();
    await publication.started;
    await editor.fill('Later work');
    await copy.click();
    await expect
      .poll(async () =>
        (await storedDrafts(page)).some(
          (draft) => draft.id !== 'a' && draft.postContent === 'Later work',
        ),
      )
      .toBe(true);
    publication.release();
    await expect
      .poll(async () =>
        (await storedDrafts(page)).some(
          (draft) =>
            draft.id !== 'a' &&
            draft.postContent === 'Later work' &&
            (draft.localRevision ?? 0) >= 2,
        ),
      )
      .toBe(true);
    await expect(editor).toHaveValue('Later work');
    expect((await storedDrafts(page)).find((draft) => draft.id === 'a')?.postContent).toBe(
      'Other writer',
    );
    expect(publication.payload()).toMatchObject({ content: { text: 'Published version' } });
  } finally {
    publication.release();
  }
});
