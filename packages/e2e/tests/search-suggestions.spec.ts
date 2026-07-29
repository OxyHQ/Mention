/**
 * Flow 4 — the search screen's suggestion surface and its submit.
 *
 * Assertions supplied by the agent that built the surfaces; the reasons are
 * theirs, the reachability is verified here. All of them run signed-out: the
 * suggestion rows are client state, and the tabs the screen queries on submit
 * (starter packs, hashtags, feeds) are public endpoints. Only the
 * posts/users/lists tabs need a session, and nothing below depends on them.
 *
 * The suggestion rows are list content, not an overlay, dropdown or portal, so
 * nothing here waits on an animation or a z-index.
 */

import { expect, test } from '../fixtures';

/**
 * Several characters on purpose. A one-character query passes whether or not
 * the stale-closure bug is present, because there is no "minus its last
 * character" to observe.
 */
const QUERY = 'starter';

/**
 * The search SCREEN's own box. `/search` renders two text inputs and picking the
 * wrong one fails silently: the right rail's "Search Mention" widget belongs to
 * the persistent shell, so it is in the DOM from the first paint, before this
 * route has mounted at all. Typing into it puts the text in a real input while
 * the screen's own `query` never changes, so the suggestion list stays on its
 * idle branch and every assertion below reads as a broken feature. Selecting the
 * screen's own placeholder is also the honest readiness wait: this input cannot
 * exist until the route's chunk has rendered.
 */
const SCREEN_SEARCH_BOX = 'Search...';

/**
 * The commit-this-query row — the first row the typing branch pushes, before any
 * conditional, so it is present whenever the box is non-empty. It is the right
 * landmark precisely because the screen swaps row sets on the first keystroke:
 * the idle set (recents, trending, the operator cheat-sheet) is REPLACED, so
 * asserting on the cheat-sheet would be asserting that the feature had not run.
 */
const COMMIT_QUERY_ROW = /search for/i;

test('suggestions survive typing and blur', async ({ page, candidate }) => {
  await page.goto('/search');

  const input = page.getByPlaceholder(SCREEN_SEARCH_BOX, { exact: true });
  await expect(input).toBeVisible();
  await input.click();
  await page.keyboard.type(QUERY, { delay: 0 });

  // Before the fix the whole suggestion surface vanished on the first keystroke.
  const suggestionRow = page.getByText(COMMIT_QUERY_ROW).first();
  await expect(suggestionRow).toBeVisible();

  // Deliberately NOT overlay behaviour: the rows are list content, so "does not
  // close when the input loses focus" holds structurally rather than by policy.
  // There is no `onBlur` in the screen and there should not be one — Bluesky
  // shipped exactly that handler and deleted it 25 days later because their
  // overlay's own focus management made the results uninteractable. This
  // assertion is what catches someone re-adding it.
  //
  // Known limit, measured rather than assumed: an injected handler that hides
  // the surface IMMEDIATELY on blur fails this, but one that hides it on a
  // ~400ms timer still passes. A React `onBlur` calling `setState` renders
  // synchronously and is caught; a deliberately deferred dismissal is not.
  // Closing that needs a settle window, i.e. a sleep, which would cost more in
  // flakiness than it buys.
  await page.keyboard.press('Tab');
  await expect(input).not.toBeFocused();
  await expect(suggestionRow).toBeVisible();

  expect(candidate.scriptErrors).toEqual([]);
});

test('submitting carries the full typed query', async ({ page, candidate }) => {
  await page.goto('/search');

  const input = page.getByPlaceholder(SCREEN_SEARCH_BOX, { exact: true });
  await expect(input).toBeVisible();

  // The outgoing request is the unambiguous signal — rendered results can lag,
  // dedupe or fall back, and would let a truncated query look fine.
  const submittedTerms: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== 'https://api.mention.earth') return;
    const term = url.searchParams.get('search') ?? url.searchParams.get('query');
    if (term !== null) submittedTerms.push(term);
  });

  await input.click();
  // No per-character delay, and Enter on the final character: the keystroke and
  // the submit can then land in one batch, which is the interleave the
  // stale-closure fix defends against and the one jest can model but not
  // reproduce.
  await page.keyboard.type(QUERY, { delay: 0 });
  await page.keyboard.press('Enter');

  await expect
    .poll(() => submittedTerms.length, {
      message: 'submitting the query must reach the API',
    })
    .toBeGreaterThan(0);

  // The last term the screen asked for is the one the submit produced. With the
  // stale closure it is `QUERY` minus its final character.
  await expect
    .poll(() => submittedTerms.at(-1), {
      message: 'the submitted query must be the complete typed string',
    })
    .toBe(QUERY);

  expect(candidate.scriptErrors).toEqual([]);
});
