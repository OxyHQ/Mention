import type { Page } from '@playwright/test';
import { DRAFT_KEY, installDraftFixture, type FixtureDraft } from '../draftFixture';
import { expect, test } from '../fixtures';

async function openDraft(page: Page, text: string) {
  await page.getByRole('button', { name: 'Open drafts and scheduled posts' }).click();
  const row = page.getByRole('button', { name: 'Continue writing' }).filter({ hasText: text });
  await expect(row).toBeVisible();
  await row.click();
  await expect(row).toBeHidden();
}

test('two tabs keep both drafts after interleaved saves', async ({ page, context, candidate }) => {
  await installDraftFixture(context);
  await context.addInitScript((draftKey) => {
    const state = window as typeof window & { __holdDraftRead?: boolean };
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      const value = original.call(this, key);
      if (key === draftKey && state.__holdDraftRead) {
        state.__holdDraftRead = false;
        // biome-ignore lint/suspicious/noDebugger: The audit pauses this read to force the documented interleaving.
        debugger;
      }
      return value;
    };
  }, DRAFT_KEY);
  const second = await context.newPage();
  const debuggerSession = await context.newCDPSession(page);
  let paused = false;
  try {
    await Promise.all([page.goto('/compose'), second.goto('/compose')]);
    const firstEditor = page.getByPlaceholder("What's new?");
    const secondEditor = second.getByPlaceholder("What's new?");
    await expect(firstEditor).toBeVisible();
    await expect(secondEditor).toBeVisible();
    await openDraft(page, 'Draft A original');
    await openDraft(second, 'Draft B original');
    // Allow any load-triggered autosave to settle before pausing A's next read.
    await page.waitForTimeout(3_500);

    await debuggerSession.send('Debugger.enable');
    const pausedRead = new Promise<void>((resolve) => {
      debuggerSession.once('Debugger.paused', () => {
        paused = true;
        resolve();
      });
    });
    await page.evaluate(() => {
      (window as typeof window & { __holdDraftRead?: boolean }).__holdDraftRead = true;
    });
    await firstEditor.fill('Edited A, should survive');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pausedRead,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('A did not pause after reading drafts')),
            15_000,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    await secondEditor.fill('Edited B, should survive');
    const drafts = () =>
      second.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? '[]') as FixtureDraft[],
        DRAFT_KEY,
      );
    await expect
      .poll(async () => (await drafts()).find((draft) => draft.id === 'b')?.postContent)
      .toBe('Edited B, should survive');
    await debuggerSession.send('Debugger.resume');
    paused = false;
    await expect
      .poll(async () => (await drafts()).find((draft) => draft.id === 'a')?.postContent)
      .toBe('Edited A, should survive');
    expect((await drafts()).find((draft) => draft.id === 'b')?.postContent).toBe(
      'Edited B, should survive',
    );
    expect(candidate.scriptErrors).toEqual([]);
  } finally {
    if (paused) await debuggerSession.send('Debugger.resume');
    await debuggerSession.detach();
    await second.close();
  }
});
